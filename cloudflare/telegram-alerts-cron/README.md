# sarco-telegram-alerts-cron

> **Tenencia.** Este Worker despierta EXCLUSIVAMENTE a Sarco
> (`https://sarco-restaurant.vercel.app`) y su nombre desplegable lleva el
> prefijo `sarco-` para no colisionar con los Workers de otro restaurante en la
> misma cuenta de Cloudflare. `test/no-cross-tenant.test.ts` falla si alguna
> configuración ejecutable vuelve a apuntar a otro despliegue — o al tick de
> otro worker, que es el error fácil en un paquete que nace copiado.

Cloudflare Worker que despierta, mediante un **Cron Trigger**, el **outbox de
alertas de Telegram** (`telegram_alerts`, migración 0028) desplegado en Vercel.

> **Despliegue INDEPENDIENTE** de `sarco-webhook-events-recovery-cron` y de
> `sarco-notification-recovery-cron`. Son tres Workers, tres Crons y tres
> endpoints. No se fusionan, y el porqué está más abajo.

## Qué recupera

Dos avisos que hasta la migración 0028 **se perdían en silencio** cuando
Telegram fallaba:

| Alerta | Qué pasaba antes |
| --- | --- |
| `delivery_notice` | El claim `delivery_notice_sent_at` se escribía ANTES de llamar a Telegram. Si Telegram fallaba después, el pedido quedaba marcado como avisado para siempre: nadie salía a repartirlo y solo quedaba un `log.warn`. |
| `handoff_notice` | No tenía ni columna. El agente se pausaba dos horas, el cliente quedaba esperando a una persona, y si Telegram fallaba nadie se enteraba nunca. |

Cada minuto, Cloudflare invoca:

```
POST https://sarco-restaurant.vercel.app/api/internal/telegram-alerts/worker/tick
Authorization: Bearer <WORKER_INTERNAL_TOKEN>
Content-Type: application/json

{}
```

y registra un log saneado con el resultado. No conoce Supabase, Telegram,
teléfonos ni el texto de ninguna alerta.

## Por qué no comparte Worker con los otros dos

Por el mismo motivo por el que aquellos son dos y no uno. El peor caso de este
tick son **cuatro alertas con timeout de 10 s cada una** (40 s), y un evento del
inbox de webhooks puede llevar **un turno completo del agente** —11–12 s medidos
en Production—. Encadenarlos en la misma ventana de 55 s tiene dos problemas:
uno le come el presupuesto al otro, y si la invocación se pasa de tiempo
**fallan los dos** ese minuto.

Un aviso de reparto que no sale a tiempo es un repartidor que no sale. Eso no
debe depender de la salud del recovery de webhooks.

## Este Worker NO es el camino normal

El camino normal es el **fast path**: quien encola la alerta —aceptar un pago,
pausar al agente por handoff— intenta mandarla en el acto. La fila durable ya
está escrita antes de ese intento, así que el fast path es **latencia, no
durabilidad**.

Este Worker recoge lo que aquel no consiguió mandar. **En reposo no hace nada, y
eso es lo normal**: un tick con `claimed: 0` es un no-op sano.

## Arquitectura

```
Cloudflare Cron (* * * * *)
   └─ scheduled(controller, env, ctx)
        └─ ctx.waitUntil(runAlertOutboxTick(env, deps))
             └─ UN POST {} con Bearer y timeout ~55 s
                  └─ traduce la respuesta a UN log saneado
                       └─ termina (el siguiente minuto es la recuperación)
```

- **Como máximo un POST por ejecución.** Sin bucles, sin retry, sin fallback.
- **Timeout ≈ 55 s**, por debajo del `maxDuration = 60` del endpoint y por
  encima de su peor caso real (40 s).
- La concurrencia la resuelven los *claims* atómicos de la base
  (`claim_due_telegram_alerts`, con `FOR UPDATE SKIP LOCKED` y lease), no este
  Worker.

Archivos:

- `src/cron.ts` — núcleo puro y testeable (`runAlertOutboxTick`).
- `src/index.ts` — Module Worker: `scheduled()` + `fetch()` (health check inerte).
- `wrangler.jsonc` — nombre, entrypoint, **un** Cron, `vars`.
- `test/cron.test.ts` — pruebas sin red real.
- `test/no-cross-tenant.test.ts` — guardián de tenencia y de destino.

## Dependencias antes de que sirva de algo

Este Worker **no funciona solo**. Necesita, en este orden:

1. **Migración `0028`** aplicada a mano en Supabase (tabla `telegram_alerts`, la
   RPC `claim_due_telegram_alerts` y el índice único `(kind, target_ref)`).
2. El endpoint `/api/internal/telegram-alerts/worker/tick` **desplegado** en
   Production.
3. `INTERNAL_API_TOKEN` configurado en Vercel.

Desplegarlo antes no rompe nada —el endpoint devolverá 404 y el log dirá
`cron_contract_error`— pero tampoco sirve.

## Variables y secretos

| Nombre | Tipo | Dónde |
| --- | --- | --- |
| `WORKER_TICK_URL` | variable pública | `wrangler.jsonc → vars` |
| `WORKER_INTERNAL_TOKEN` | **secreto** | Cloudflare secret (nunca en el repo) |

`WORKER_INTERNAL_TOKEN` debe coincidir con `INTERNAL_API_TOKEN` del endpoint.
Es el **mismo valor** que usan los otros dos Workers, guardado por separado en
cada uno. **Nunca** se escribe en `wrangler.jsonc`, código, tests, README ni
logs.

## Instalar

```bash
cd cloudflare/telegram-alerts-cron
npm install
```

## Probar

```bash
npm test
```

Las pruebas no llaman a Vercel, Supabase ni Telegram, y no usan secretos reales.

## Ejecutar localmente

```bash
cp .dev.vars.example .dev.vars   # rellenar el token SOLO para local

npx wrangler dev --test-scheduled
# En otra terminal:
curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"
```

`.dev.vars` está en `.gitignore`: nunca se versiona.

## Guardar el secreto

```bash
npx wrangler secret put WORKER_INTERNAL_TOKEN
```

> El valor NO se incluye aquí ni en ningún archivo versionado.

## Desplegar

```bash
npx wrangler deploy
```

## Verificar

- Estado: `npx wrangler deployments status` y `npx wrangler versions list`.
- Health check inerte (**no** dispara el tick):
  `GET https://<worker>.workers.dev/` → `{"service":"sarco-telegram-alerts-cron","status":"ok"}`.
- Contrato del endpoint:
  - `POST .../worker/tick` sin Bearer → **401**.
  - `GET  .../worker/tick` → **405**.

```bash
npx wrangler tail sarco-telegram-alerts-cron --format json
```

En reposo, cada minuto debe verse `cron_started` y luego `cron_completed` con
`claimed: 0, sent: 0, rescheduled: 0, failed: 0`.

## Eventos del log

| Evento | Significado |
| --- | --- |
| `cron_started` | arranca la ejecución |
| `cron_completed` | 200 con `ok`, `claimed`, `sent`, `rescheduled`, `failed`, `duration_ms` |
| `cron_unauthorized` | 401: el Bearer no coincide con `INTERNAL_API_TOKEN` |
| `cron_contract_error` | 400/404/405/422, config ausente o estado inesperado |
| `cron_rate_limited` | 429 |
| `cron_upstream_error` | 5xx del endpoint |
| `cron_timeout` | venció nuestro timeout; **no** se reintenta aquí |
| `cron_fetch_error` | fallo de red genuino |
| `cron_invalid_response` | 200 ilegible o con forma inesperada |

Ningún log lleva token, `Authorization`, URL, teléfono ni el texto de ninguna
alerta.

### Cómo leer `rescheduled` y `failed`

Ninguno de los dos es una avería del tick:

- **`rescheduled`** — Telegram falló de forma transitoria y la alerta vuelve a la
  cola con backoff (30 s → 2 min → 8 min → 30 min). Es el sistema funcionando.
- **`failed`** — la alerta agotó sus intentos, o chocó con un fallo permanente
  (chat inexistente, token mal puesto) o con una respuesta ilegible. Queda
  visible en la base con su `last_error` **para que una persona avise a mano**.

Un `failed` recurrente sí merece mirarse: casi siempre es
`TELEGRAM_BOT_TOKEN` o `TELEGRAM_CHAT_ID` mal configurados, y el `last_error` de
la fila lo dice.

## Pausar el Cron

El Cron es un trigger declarado en `wrangler.jsonc` (`"crons": ["* * * * *"]`).

1. Preferido (dashboard): Workers & Pages → `sarco-telegram-alerts-cron` →
   Triggers → Cron Triggers → eliminar/deshabilitar.
2. Por código: comentar `crons` en `wrangler.jsonc` y `npx wrangler deploy`.

Pausarlo **no** pierde trabajo: las alertas pendientes siguen en
`telegram_alerts` y se recogen al reactivarlo. Lo que se pierde mientras está
pausado es la red de seguridad: el fast path sigue mandando los avisos, pero lo
que falle se queda en la cola sin que nadie lo reintente.

## Límites

| Concepto | Valor | Dónde |
| --- | --- | --- |
| Alertas por tick | 4 | `ALERT_TICK_BUDGET` |
| Lease del reclamo | 60 s | `ALERT_LEASE_SECONDS` |
| Timeout del transporte | 10 s | `createTelegramAlertSender` |
| Timeout del Worker | 55 s | `TICK_TIMEOUT_MS` |
| `maxDuration` endpoint Vercel | 60 s | ruta `worker/tick` |
| Intentos por alerta | 5 | `max_attempts` (0028) |
