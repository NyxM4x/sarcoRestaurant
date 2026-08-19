# ACK durable — 6D.2F.5C.1

Documento **trackeado**. Fija qué se construyó y por qué.

**Estado: implementado en local, con el flag `WEBHOOK_ASYNC_ACK` apagado.**
Migración `0016` escrita y **sin aplicar**. Sin desplegar.

Contexto: Kapso exige **200 OK en menos de 10 s** y en Production los turnos
con herramienta tardan 11,4–12,0 s. Detalle en
[agent-intake-audit.md §3](./agent-intake-audit.md).

---

## 1. Auditoría de `webhook_events`

Esquema actual (0001, sin cambios desde entonces):

```sql
create table if not exists webhook_events (
  id             uuid primary key default gen_random_uuid(),
  event_id       text unique,
  message_id     text,
  event_name     text,
  payload        jsonb,
  status         text not null default 'processing'
    check (status in ('received', 'processing', 'processed', 'failed')),
  error_message  text,
  processed_at   timestamptz,
  created_at     timestamptz not null default now()
);
create index idx_webhook_events_message_id on webhook_events (message_id);
```

### Lo que ya sirve

| Requisito de un inbox durable | Estado |
|---|---|
| Copia durable del trabajo | **ya existe**: `payload jsonb` guarda el evento entero |
| Deduplicación de la entrega | **ya existe**: `event_id` UNIQUE = `X-Idempotency-Key` |
| Estado "aceptado, sin procesar" | **ya existe**: `'received'` está en el CHECK y **hoy no lo usa nadie** |
| Distinción processed / failed | ya existe |
| Reclamo atómico de reintento | ya existe: `claimFailedForRetry` (`UPDATE … WHERE status='failed'`) |

El hallazgo principal de esta auditoría: **la fila durable ya se escribe hoy,
antes de procesar**. El webhook no necesita una copia nueva del trabajo; le
falta responder antes de hacerlo y saber volver a lo que quedó a medias.

Y `'received'` estando ya en el dominio significa que el estado que hace falta
**no requiere tocar el CHECK**.

### Lo que falta

1. **`next_attempt_at`, que además hace de LEASE.** Es la pieza central. Al
   reclamar una fila se pone `next_attempt_at = now() + lease`; si la
   invocación muere a mitad, la fila vuelve a estar vencida sola, sin que nadie
   tenga que deducir que "quedó colgada". Un `processing` no vencido es trabajo
   vivo; uno vencido es trabajo abandonado. Y sirve para el backoff.
2. **`attempts`** — sin contador no se puede acotar el reintento ni distinguir
   un fallo transitorio de un evento venenoso que reintentará para siempre.
3. **`updated_at`** — para observabilidad y diagnóstico. Con el lease, la prueba
   de abandono ya no depende de esta columna; sigue siendo la que permite ver
   cuándo se tocó la fila por última vez.
4. **Índice para el recovery** — hoy solo hay índice por `message_id`. La
   consulta del worker filtra por vencimiento sobre una tabla que crece con
   cada evento de Kapso, incluidos los `delivered`/`read`.

### Migración mínima

```
alter table webhook_events
  add column attempts        integer not null default 0,
  add column max_attempts    integer not null default 5,
  add column updated_at      timestamptz,
  add column next_attempt_at timestamptz;

create index … on webhook_events (next_attempt_at)
  where next_attempt_at is not null and status in ('received','processing');
```

Sin tabla nueva, sin tocar el CHECK de `status`, sin backfill: las filas
históricas nacen con `next_attempt_at = null` y quedan invisibles para el
worker, que es exactamente lo que se quiere.

**`updated_at` no se mantiene solo.** `webhook_events` **no** tiene trigger.
Lo que sí existe desde 0001 es la función genérica `set_updated_at()`, que ya
reutilizan `orders`, `order_notifications`, `agent_conversations`, `agent_runs`
y `menu_send_deliveries`. La migración engancha el trigger a esta tabla igual
que las demás, sin redefinir la función:

```
create trigger trg_webhook_events_updated_at
  before update on public.webhook_events
  for each row execute function public.set_updated_at();
```

Así ninguna transición puede olvidarse de tocarla.

---

## 2. Opción A vs Opción B

### El precedente que decide

Este proyecto **ya opera un outbox durable con recovery, en producción, desde
hace semanas**: `order_notifications`.

Trae `attempt_count`, `max_attempts`, `next_attempt_at`, índice parcial sobre
`next_attempt_at`, `manual_review_required` como estado venenoso, constraints
que impiden que un terminal siga agendado, una función de selección de trabajo
vencido y un worker con presupuesto acotado en
`/api/internal/order-notifications/worker/tick`, protegido con
`INTERNAL_API_TOKEN`. Está tickeando cada 60 s ahora mismo.

La opción A no es *infraestructura nueva*. Es aplicar a la entrada el mismo
patrón que ya funciona en la salida, sobre una tabla que ya guarda el payload.

### Comparación

| | A · `webhook_events` como inbox | B · Vercel Queues |
|---|---|---|
| Durabilidad | fila Postgres, ya existente | 3 AZ, retención ≤ 24 h |
| **Orden** | por `created_at`; y el contexto se ordena por `message_timestamp` de todos modos | **sin FIFO garantizado**, ni con un consumidor y concurrencia 1 |
| Madurez | patrón ya en producción aquí | **beta pública**, no GA |
| Idempotencia | la de la base, que hace falta igual | clave de publicación **+** la de la base |
| Recovery | consulta SQL + cron ya existente | reintentos del proveedor + lo mismo por debajo |
| Infra nueva | ninguna | topic, consumer group, despliegue, operación |
| Latencia al procesar | `after()` en la misma invocación | salto de red al consumidor |

### Decisión: **A**

Razones concretas para *este* proyecto:

1. **El orden es el producto.** Una conversación fuera de orden es una
   conversación rota, y Queues dice explícitamente que no garantiza FIFO. Que
   la solución oficial sea "meted números de secuencia y reordenad en el
   consumidor" significa reconstruir a mano lo que la tabla ya da gratis.
2. **La fila durable ya se escribe.** Adoptar B añadiría un segundo sistema
   durable sin retirar el primero, porque la idempotencia de negocio seguiría
   viviendo en Postgres igualmente.
3. **Beta.** El canal de entrada de todos los mensajes de clientes no es el
   sitio para estrenar un producto que no ha llegado a GA.
4. **El patrón ya está probado aquí**, con sus constraints y su worker.

### Lo que A **no** resuelve por sí sola

El tick del cron es de 60 s. Para un chat eso no es latencia, es abandono. Por
eso la decisión completa es:

> **`after()` es el mecanismo de LATENCIA. La fila es el mecanismo de
> DURABILIDAD. Ninguno de los dos vale solo.**

`after()` ejecuta tras enviar la respuesta, dentro del `maxDuration` de la
ruta, y corre incluso si la respuesta terminó en error — pero es memoria de una
invocación: si el proceso muere, se lo lleva. El recovery no es opcional, es la
otra mitad.

---

## 3. Dos planos, no uno

El ajuste que cierra la carrera: **no todo evento puede ser asíncrono.**

Si el takeover humano también se difiere, la barrera pre-send no sirve de nada.
El agente consultaría la pausa, la vería `active` —porque el `sent` está
aceptado pero **sin aplicar**— y hablaría por encima de la persona. La barrera
solo puede ver lo que ya está escrito en la base.

Así que el criterio no es "entrante rápido / saliente lento", sino **plano de
control frente a plano de datos**:

| | Plano de control | Plano de datos |
|---|---|---|
| Qué | `sent` + `outbound` + `business_app` | `received` del cliente |
| Coste | solo base: mensaje, pausa, evento de control | OpenAI, tools, envíos |
| Cuándo | **síncrono, antes del 200** | `after()` + recovery |

El takeover es barato —tres escrituras, sin red externa— así que hacerlo
síncrono no compromete el ACK. Y es la única forma de que la pausa esté
**escrita** antes de que cualquier turno pueda consultarla.

```
POST /api/kapso/webhook
  │
  ├─ rawBody
  ├─ HMAC + versión + evento          ← SIEMPRE antes de parsear
  ├─ idempotencia (event_id UNIQUE)
  ├─ INSERT webhook_events            ← 'received', payload completo
  │
  ├─ ¿provenance = human_outbound?
  │    │
  │    ├─ SÍ  ── PLANO DE CONTROL, síncrono ────────────────────────┐
  │    │         persist mensaje humano                             │
  │    │         pause conversation                                 │
  │    │         agent_control_events                               │
  │    │         markProcessed                                      │
  │    │         200 OK  ·········································· │ ~300–600 ms
  │    │                                                            │
  │    └─ NO  ── PLANO DE DATOS ───────────────────────────────────┐│
  │              200 OK  ·········································││ ~200–400 ms
  │                    │                                           ││
  │                    └─ after(() => processEvent(rowId))         ││
  │                          claim 'received' → 'processing'       ││
  │                          persistInbound                        ││
  │                          processMessage   (determinísticos)    ││
  │                          runAgentTurn     (OpenAI, tools)      ││
  │                          'processed' | 'failed'                ││
  │                                                                ││
  └─ RECOVERY (cron) ── filas con next_attempt_at vencido ─────────┘┘
```

El ACK deja de depender de OpenAI: entre la aceptación durable y el 200 solo
hay un INSERT, y en el plano de control tres escrituras acotadas.

**El takeover conserva su semántica actual exactamente.** Hoy ya se resuelve
antes de bifurcar entrante/saliente y responde sin tocar `processMessage`; lo
único que cambia es que ahora va precedido de la aceptación durable, para que
un crash a mitad del takeover sea recuperable en vez de perderse. Sigue siendo
idempotente por wamid, así que la reejecución no duplica ni mensaje ni pausa.

---

## 4. Las dos barreras de pausa

El fast-path cierra la carrera grande, pero no la pequeña: una persona puede
tomar la conversación **mientras** OpenAI está pensando. Para eso, un trabajo
aceptado no otorga permiso permanente para hablar.

| Barrera | Cuándo | Si está pausada |
|---|---|---|
| 1 (ya existe) | antes del modelo | `skipped_paused` / `pre_openai` |
| 2 (**nueva**) | inmediatamente antes de **cada efecto visible** | ver abajo |

La barrera 2 no es "después del modelo": es **antes de cada salida**, y hoy hay
dos:

- **A.** el texto final de la IA;
- **B.** `send_menu`, que es un saliente **dentro** del bucle de herramientas y
  ocurre *antes* del texto final. Sin la comprobación ahí, el agente podría
  disparar un CTA sobre una conversación que una persona acaba de tomar.

**`pre_send` ya está en el esquema** —
`agent_runs.skipped_at_barrier check in ('pre_openai','pre_send')`— y hoy no lo
escribe nadie. El diseño original ya contaba con esto: la barrera no necesita
migración.

### Cómo cerrar el run, con los estados que ya existen

Depende de si el cliente ya vio algo:

| Situación al detectar la pausa | Cierre |
|---|---|
| Nada visible ocurrió aún | `skipped_paused` · `pre_send` · `completed_at` · sin `response_message_id` · sin `error_code` |
| Ya salió un CTA en una ronda anterior | **`completed`**, en silencio |

El segundo caso no necesita nada nuevo: es exactamente el *silent completion*
de 5B. Un turno con efecto visible confirmado y sin texto final cierra
`completed`, y la señal ya viaja por el contrato de las tools
(`userVisibleEffectConfirmed`). Cerrarlo como `skipped_paused` sería mentir —
diría que el agente no actuó cuando el cliente ya tiene el menú en la mano.

El primer caso encaja tal cual en `agent_runs_state_coherence`, que para
`skipped_paused` exige `completed_at`, `response_message_id` nulo, `error_code`
nulo y `skipped_at_barrier` presente.

### Dónde vive la barrera — y dónde NO

En el **camino de salida del agente**: el bucle de herramientas y el envío
final. **No** en el webhook.

Un `if (paused) abort` global en `handleKapsoWebhook` cambiaría en silencio la
semántica de `location`, `nfm_reply`, el Flow y `TESTMENU9842`, que hoy tienen
sus propias reglas y funcionan **también** con la conversación pausada: un
cliente que manda su GPS mientras un humano atiende sigue necesitando que ese
GPS se guarde. La pausa detiene al agente, no al negocio.

---

## 5. Idempotencia

Nada de lo que ya protege cambia; se le añade una capa por delante.

| Nivel | Clave | Garantiza |
|---|---|---|
| Entrega | `webhook_events.event_id` UNIQUE | la misma entrega no se procesa dos veces |
| Mensaje | `agent_messages.provider_message_id` UNIQUE parcial | el mismo WAMID no se persiste dos veces |
| Turno | `agent_runs.source_message_id` UNIQUE | un WAMID ancla, un turno, un OpenAI |
| Efecto | `menu_send_deliveries.source_message_id` UNIQUE | un WAMID ancla, un CTA |

El reintento asíncrono es seguro porque el claim del run va **antes** del
modelo y el claim del envío **inmediatamente antes** de Kapso. Un reintento tras
un crash encuentra los claims y no repite el efecto.

---

## 6. Fallback del lote

Con aceptación durable el escenario cambia de forma:

| Situación | Qué pasa |
|---|---|
| Aceptamos y el ACK se pierde | Kapso reentrega con el mismo `X-Idempotency-Key` → `event_id` UNIQUE → `IN_PROGRESS`. Ya funciona hoy. |
| Falla el **procesamiento** | Es nuestro; los reintentos son nuestros. Kapso ya recibió su 200 y no reentrega. |
| Falla la **aceptación** (base caída) | Único camino al fallback. Ventana mucho más estrecha: un INSERT, no un turno completo. |

Si aun así Kapso acaba entregando individuales, los mensajes previos al ancla
no tienen run reclamado y cada uno abriría el suyo: hasta N respuestas.

**Decisión recomendada: aceptar el riesgo en 5C.** Exige fallo total de
aceptación, y la alternativa —"¿hubo un run reciente en esta conversación que
cubra este mensaje?"— reintroduce una ventana temporal, justo lo que se eliminó
de `send_menu` en 5B por buenas razones. No se cambia un cooldown por otro con
otro nombre.

---

## 7. Estados y reclamo atómico

| Estado | Significado |
|---|---|
| `received` | aceptado de forma durable, **nadie lo ha tomado** |
| `processing` | reclamado; el lease dice hasta cuándo se le da por vivo |
| `processed` | terminado |
| `failed` | falló; `next_attempt_at` dice cuándo se reintenta |

Los cuatro **ya están en el CHECK** de 0001. No se toca el dominio.

Cambio de comportamiento: hoy `insertProcessing` escribe `'processing'` directo
porque procesa en línea. Pasa a escribir `'received'`, y `processing` se
convierte en lo que significa su nombre — *alguien lo está procesando ahora*.

### Dos reclamos, dos funciones

`claim_webhook_event(id, lease)` — el fast path. Compare-and-set contra
`'received'`: cero filas = otro lo tomó, y quien pierde se retira. Solo toma
`received`, así que nunca le roba trabajo vivo al worker.

`claim_due_webhook_events(limit, lease)` — el recovery. Selecciona lo vencido,
ordenado por `created_at`, con `FOR UPDATE SKIP LOCKED`.

Las **dos** son funciones de Postgres, no UPDATEs desde el cliente, por una
razón que apareció al implementar: `attempts = attempts + 1` tiene que ir en la
**misma sentencia** que el cambio de estado. Partirlo en dos deja una ventana
con la fila reclamada y el intento sin contar, que es justo por donde se cuelan
los reintentos infinitos. PostgREST no expresa ni `col + 1` ni
`FOR UPDATE SKIP LOCKED`.

Devuelven el `payload` para que quien reclama trabaje sin releer: una segunda
lectura podría traer una fila ya modificada por otro.

`FOR UPDATE SKIP LOCKED` es lo que impide que dos workers concurrentes tomen la
misma fila; el `ORDER BY created_at` mantiene el orden de llegada dentro del
tick. Nada de select-then-update.

**El lease sustituye a la heurística de antigüedad.** No hay que decidir cuánto
es "demasiado tiempo en `processing`": al reclamar se fija hasta cuándo vale el
reclamo, y si la invocación muere, la fila vence sola y vuelve a estar
disponible. Un `processing` vencido **es** trabajo abandonado, por definición.

Al terminar: `processed` con `next_attempt_at = null`, o `failed` con
`next_attempt_at = now() + backoff`. Agotado `max_attempts`, la fila deja de
seleccionarse y queda visible para revisión, como `manual_review_required` en
las notificaciones.

**Reclamar no es procesar dos veces.** El contador sube en cada reclamo, pero
la idempotencia de negocio (§5) es la que garantiza que un reproceso no
duplique efectos. `attempts` acota el gasto, no la corrección.

---

## 8. Rollback

Una **sola** implementación del negocio (`runBusiness`), alcanzable por tres
caminos que convergen en `processClaimedEvent`:

```
acceptKapsoWebhook(params)          ← valida, acepta, y resuelve el takeover
processWebhookEvent(rowId, params)  ← reclama por id y delega
processClaimedEvent(row, params)    ← el punto donde todo converge
   └── runBusiness(row, params)     ← el negocio, desde el payload GUARDADO

  inline   handleKapsoWebhook = accept + process, antes del 200
  async    accept → 200 → after(process)
  recovery claim_due → processClaimedEvent
```

`handleKapsoWebhook` no tiene ni una línea de negocio propia: es literalmente
la composición de las otras dos. Por eso el modo inline no puede divergir del
real — es el real, llamado antes en vez de después.

Detalle que salió al implementar: `runBusiness` trabaja desde el **payload
guardado**, no desde el request. Así el worker y el `after()` recorren el mismo
camino con los mismos datos, y una reentrega con el cuerpo alterado no puede
cambiar el comportamiento después de que la firma se verificara una vez.

`WEBHOOK_ASYNC_ACK` elige. Solo la cadena `'true'` enciende el modo nuevo;
ausente o cualquier otra cosa deja el comportamiento anterior a 5C.1.

1. **Variable de entorno** → procesamiento en línea, comportamiento de hoy.
2. **Revertir el despliegue** → las columnas nuevas quedan sin leer. Una
   migración aditiva no estorba al código viejo.
3. La migración **no** se revierte: no borra nada y no cambia el CHECK.

El fast-path del takeover **no** tiene interruptor: es síncrono en los dos
modos, porque en ninguno de los dos puede diferirse.

---

## 9. Pruebas necesarias

**ACK y durabilidad**
- El webhook responde sin haber llamado al modelo (doble de OpenAI que falla si
  lo invocan antes del 200).
- Si el INSERT durable falla, **no** hay 200.
- `after()` que nunca arranca → la fila queda `received` vencida y el recovery
  la recoge.

**Reclamo**
- Dos reclamos concurrentes sobre la misma fila → solo uno gana.
- `processing` con lease vigente → el recovery **no** la toca.
- `processing` con lease vencido → recuperable.
- `attempts` al tope → deja de seleccionarse.

**Plano de control**
- `business_app sent` deja la conversación pausada **antes** del 200.
- Un `received` que llega después ve la pausa ya escrita.
- El takeover sigue siendo idempotente por wamid.

**Barreras**
- Pausa entre aceptar y el texto final → `skipped_paused`/`pre_send`, sin envío.
- Pausa antes de `send_menu` → sin CTA y sin fila en `menu_send_deliveries`.
- Pausa **después** de un `send_menu` ya enviado → run `completed`, sin texto,
  sin segundo efecto.
- Con la conversación pausada, `location`, `nfm_reply` y `TESTMENU9842`
  **siguen funcionando igual** — la prueba de que no se coló un abort global.

**Idempotencia**
- Reentrega del mismo `event_id` → sin segundo procesamiento.
- Reintento tras crash post-OpenAI → sin segundo envío.

**Orden**
- Dos eventos de la misma conversación se procesan en orden de llegada.

---

## 10. Criterio de `PASS_LOCAL_ACK`

1. Suite verde, lint limpio, build compila.
2. Ningún camino responde 200 sin fila durable escrita.
3. Ningún camino llama a OpenAI antes del 200.
4. `business_app` aplica la pausa **antes** del 200, con test.
5. Las dos barreras cubiertas, incluida la de `send_menu` y el caso del CTA ya
   enviado.
6. Los determinísticos siguen funcionando con la conversación pausada, con test.
7. Reclamo atómico probado bajo concurrencia; recovery probado para
   `received` sin arrancar y `processing` con lease vencido.
8. Las cuatro capas de idempotencia siguen probadas.
9. Una sola función de procesamiento, invocable inline y async; el kill switch
   restituye el comportamiento actual, con test.
10. Sin `supabase db push`; migración preparada para aplicar a mano y **antes**
    del deploy de código.

Medición de ACK en Production **después** del despliegue, no como criterio
local: el objetivo es < 1 s de forma consistente. El log del webhook emite
`ack_duration_ms` y el del `after()` emite `processing_duration_ms`, separados a
propósito — la promesa de la fase es que el segundo no arrastre al primero.

---

## 11. Lo que queda fuera, y se sabe

- **La carrera residual de milisegundos** entre comprobar la pausa y la llamada
  HTTP al proveedor. Cerrarla exigiría un lock distribuido o un envío
  condicionado por la base: infraestructura considerable para una ventana cuyo
  peor caso es un mensaje de más, el mismo que ocurre si la persona escribe una
  décima después. Lo que sí se hace es dejar la comprobación pegada al efecto.
- **Lotes.** Sigue respondiendo 422: el soporte es 5C.2.

---

## 12. Quién despierta el recovery

Un **segundo Cloudflare Worker**, `cloudflare/webhook-events-recovery-cron/`,
con Cron `* * * * *` y un único `POST {}` con Bearer — el mismo patrón, y el
mismo token, que `notification-recovery-cron`.

**Dos Workers y no uno.** Podrían compartir despertador y no lo hacen: un evento
de este inbox puede llevar un turno completo del agente (11–12 s medidos), así
que encadenar los dos recoveries en la misma ventana de 55 s haría que uno le
comiera el presupuesto al otro y que un timeout tumbara a los dos el mismo
minuto. La durabilidad de los mensajes de clientes no debe depender de la salud
del worker de notificaciones. El Worker existente conserva intacto su invariante
de un solo POST.

**Vercel Cron quedó descartado**: invoca por GET y con `CRON_SECRET`, y el
endpoint responde 405 a GET por diseño. Adaptarlo significaría aceptar GET y un
segundo esquema de auth en un endpoint interno.

### Presupuesto del tick

| Concepto | Valor |
|---|---|
| Eventos por tick | **3** |
| Presupuesto de reloj | **42 s** |
| Timeout del Worker | 55 s |
| `maxDuration` de la ruta | 60 s |

Tres y no cinco porque cinco turnos no caben en 55 s, y un tick que muere a
mitad no recupera nada. El reloj acota el peor caso que el contador no ve.

Se reclama **de una en una**, comprobando el presupuesto antes de cada reclamo.
Pedir tres de golpe y procesar las que quepan dejaría filas reclamadas y sin
intentar, gastándoles un intento y reteniéndolas bajo lease hasta que venciera.

No se paraleliza para compensar: varios turnos a la vez contra el mismo teléfono
es justo lo que la idempotencia no debería tener que arbitrar. Y no hace falta —
esto es el camino de recuperación, no el normal.
