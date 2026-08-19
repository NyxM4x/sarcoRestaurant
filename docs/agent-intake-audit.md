# Conversation Intake — auditoría 6D.2F.5C

Documento **trackeado** de auditoría. No describe código escrito: describe el
código que hay, el contrato de Kapso confirmado y las decisiones pendientes.

Fecha: 2026-08-16. Base: `4d5dade` en Production.

---

## 1. El pipeline de hoy

```
POST /api/kapso/webhook
  │
  ├─ 1. HMAC SHA-256 sobre el body CRUDO         ← rawBody, comparación constante
  ├─ 2. X-Webhook-Payload-Version === 'v2'
  ├─ 3. isBatchedPayload() → 422 unsupported_batch
  ├─ 4. evento soportado (received | los 4 salientes)
  ├─ 5. X-Idempotency-Key obligatorio
  ├─ 6. webhook_events: findByKey → processed=DUPLICATE
  │                                 failed=claimFailedForRetry
  │                                 otro=IN_PROGRESS
  │                                 nuevo=insertProcessing
  └─ 7. procesamiento
        ├─ parseKapsoProvenance()
        ├─ human_outbound → handleHumanTakeover → PAUSA → fin
        └─ received
             ├─ persistInbound()          ← fail-before-side-effect, propaga
             ├─ processMessage()          ← menú / location / nfm_reply
             │    └─ si ninguno: DETERMINISTIC_DECLINED
             └─ si declinó → runAgentTurn()
```

Los puntos que 5C toca están en [kapso.ts:592](../src/lib/webhook/kapso.ts#L592)
(el 422), [nfm.ts `isBatchedPayload`](../src/lib/flow/nfm.ts) y
[`extractMessageContext`](../src/lib/flow/nfm.ts), que lee **solo la raíz** del
payload sin ningún fallback a `data[]`.

### El gate de contenido ya existe y va ANTES del claim

[run.ts:127](../src/lib/agent/core/run.ts#L127):

```ts
if (message.contentType !== 'text' || message.content === null || message.content.trim() === '') {
  return { result: 'skipped', reason: 'unsupported_content' };
}
```

Está **antes** de reclamar `agent_runs`. Consecuencia importante para 5C: hoy
una reacción o una foto no crean ni fila de run, ni llamada a OpenAI, ni coste.

---

## 2. Contrato de Kapso — confirmado y no confirmado

### Confirmado en documentación oficial

| | |
|---|---|
| Eventos con buffering | **solo** `whatsapp.message.received` |
| Sobre del lote | `{ type, batch: true, data: [...], batch_info: { size, window_ms, first_sequence, last_sequence, conversation_id } }` |
| Cabeceras | `X-Webhook-Batch: true`, `X-Batch-Size`, más las de siempre |
| Ventana | 1–60 s, por defecto 5 |
| Tamaño máximo | 1–100, por defecto 50 |
| Reintentos | inmediato, 10 s, 40 s, 90 s |
| **Agotados los reintentos** | **el lote cae a entrega individual** |
| **ACK** | **200 OK en menos de 10 segundos** |

Los 10 eventos: `message.received/sent/delivered/read/failed`,
`conversation.created/ended/inactive`, `contact.identity_changed`.

**El buffering solo agrupa `received`.** Queda confirmada la sospecha: un
saliente `business_app` mantiene su propio camino y el human takeover no viaja
mezclado dentro de un lote de entrantes.

### Confirmado en la revisión de 5C.1

**A. Cada elemento de `data[]` trae su propio sobre**: `message`,
`conversation`, `is_new_conversation` y `phone_number_id`. No es una incógnita.

Consecuencia directa: **la identidad de cada mensaje del lote no depende del
sobre exterior**. `conversation.phone_number` sigue siendo la fuente, elemento
a elemento, exactamente como hoy. La deuda de identidad que se temía en §8 no
existe: procesar un elemento de `data[]` es procesar el mismo objeto que llega
hoy suelto.

**B. Kapso firma el JSON crudo del webhook.** La verificación HMAC debe seguir
ocurriendo sobre el cuerpo crudo **antes** de interpretar si es single o batch.
Ese orden ya es el del código —`verifyHmacSha256(rawBody, …)` es el paso 1 y
`isBatchedPayload` el 3— y no debe invertirse nunca: interpretar antes de
verificar es parsear datos no confiables.

### Confirmado con payload REAL — reacciones (16-08-2026, Production)

**La reacción SÍ tiene wamid propio.** Capturado con
`docs/smoke-5c4-reaction-capture-prod.sql`. Cierra el bloqueante del §5:

| | AGREGAR | QUITAR |
|---|---|---|
| `message.type` | `reaction` | `reaction` |
| `message.id` | WAMID propio | **OTRO** WAMID propio |
| `reaction.message_id` | wamid objetivo | el mismo objetivo |
| `reaction.emoji` | presente (`❤️`) | **AUSENTE** (no vacío) |
| `kapso.message_type_data` | `{ message_id, emoji }` | `{ message_id }` |
| `kapso.content` | `"Reacted with ❤️ to message <wamid>"` | `"Reaction removed from message <wamid>"` |

Los dos llegan como `whatsapp.message.received`, `batch_size=1`,
`silent_count=1`, `outcome=processed`, sin `agent_action_selected`, sin
`agent_tool_call` y sin saliente de IA.

Dos consecuencias que solo se ven con el payload delante:

1. **Add y remove son eventos distintos**, con WAMID distintos. Los dos se
   persisten, los dos deduplican solos, y **no** se deduplica por
   `target_message_id`: poner, quitar y volver a poner es legítimo.
2. **`kapso.content` trae una frase en inglés redactada por Kapso.** Ver §5: es
   la contaminación que 5C.4 corta.

### NO confirmado — hace falta payload real
1. **`kapso.media_url`: no asumir caducidad.** La API de obtención de media
   documenta URLs temporales, pero eso es la API de media, no necesariamente el
   helper `kapso.media_url` del webhook. Son dos cosas distintas y no se puede
   afirmar la expiración de una citando la otra. Pendiente de confirmar antes de
   diseñar cualquier descarga.
2. **`X-Batch-Size`** aparece en overview y no en la página de buffering. La
   autoridad sigue siendo `batch === true`, que es lo que ya mira
   `isBatchedPayload`.

---

## 3. El riesgo real: el ACK de 10 segundos

Medido en Production hoy, entre el inicio del request y `webhook_handled`:

| Turno | Duración |
|---|---|
| Sin agente (determinístico u otro teléfono) | 2,1 – 3,5 s |
| Agente, solo texto | **9,55 s** |
| Agente + `send_menu` (2 llamadas a OpenAI + envío) | **11,4 s** y **12,0 s** |

Los dos turnos con herramienta **ya superan el ACK documentado**. No se ha
observado ni un reintento, así que en la práctica Kapso está siendo más
tolerante que su documentación — pero eso es suerte, no diseño.

Y todo lo que trae 5C empuja en la dirección equivocada: el lote mete N
persistencias en una sola invocación, y la visión añade descarga de media más
una llamada multimodal.

**Esta es la decisión que ordena la fase.** Mientras el procesamiento sea
síncrono, cada función nueva se paga en el mismo presupuesto que ya está
agotado.

---

## 4. Semántica del lote y `source_message_id`

### Lo que no se negocia

Cada WAMID sigue siendo individual: N filas en `agent_messages`, con su
timestamp y su orden. Nada se fusiona ni se borra.

### Propuesta: `turn_anchor_message_id`

**No** "el último elemento del lote". El ancla es el **último WAMID ELEGIBLE
del turno lógico, después de clasificar los elementos**.

Primero se clasifica cada elemento, y caen en tres clases:

| Clase | Tipos | Papel en el turno |
|---|---|---|
| **Determinística** | `location`, `interactive/nfm_reply`, `TESTMENU9842` | ruta propia, con su **propio** WAMID; NO forma parte del turno del agente |
| **Silenciosa** | `reaction`, y hoy también media sin texto | se persiste; nunca puede ser ancla |
| **Elegible** | `text` con contenido real (y `image` a partir de 5C.5) | forma el turno lógico |

`turn_anchor_message_id` = WAMID del **último elegible**, ordenando por
`message_timestamp` (no por posición en el array: si discrepan, manda el
timestamp, que es lo que usa la ventana de contexto).

`agent_runs.source_message_id` y `menu_send_deliveries.source_message_id` usan
ese ancla. Un CTA por turno lógico.

Por qué el último elegible:

- Es el mensaje que **cierra** la ráfaga y el que el agente contesta. En
  `"hola" / "quería saber" / "qué hamburguesas tienen?"`, la pregunta es la
  tercera.
- Si el lote cae a entrega individual, ese mismo mensaje llega solo y choca con
  el UNIQUE que ya existe: el turno no se repite.

Casos que la regla resuelve y "el último del lote" no:

- **Lote que termina en reacción** — `["qué hamburguesas hay?", ❤️]`. El ancla
  es la pregunta, no la reacción. Con la regla ingenua el ancla sería un
  elemento que ni siquiera puede abrir turno.
- **Lote sin ningún elegible** — tres reacciones seguidas. **No hay turno**: ni
  ancla, ni run, ni OpenAI. Sale gratis del gate que ya existe en
  [run.ts:127](../src/lib/agent/core/run.ts#L127), aplicado tras clasificar.
- **Lote mixto** — `["hola", <location>, "y bebidas?"]`. La ubicación va por su
  ruta determinística con su propio WAMID; el turno se ancla en `"y bebidas?"`.

Este último caso es el que protege el invariante más delicado del sistema: *el
agente habla solo donde el pipeline determinístico declinó*. Con lotes, ese
invariante pasa a evaluarse **por elemento**, no por entrega.

### Los demás WAMID: no hace falta esquema nuevo

Los N se persisten igual, y el contexto del modelo se construye **por
conversación y ventana de 24 h**, no por run. Es decir: los tres mensajes
entran en el contexto por sí solos, en orden, sin ningún vínculo explícito.
La agrupación es implícita.

`agent_runs.source_agent_message_id` ya apunta al mensaje que disparó el turno.
Lo único que se pierde es poder preguntar *"qué mensajes pertenecían a este
run"*, que es observabilidad, no corrección. **Recomendación: cero migraciones
en 5C.1.** Si más adelante la observabilidad lo pide, lo barato es
`batch_size int` en `agent_runs`, no una tabla.

### Riesgo a decidir: doble respuesta tras agotar reintentos

Si un lote falla las cuatro veces y Kapso cae a entrega individual, los
mensajes 1..N-1 **no tienen run reclamado**. Cada uno abriría su propio turno:
hasta N respuestas a una ráfaga que no supimos contestar.

Es raro —exige fallo total previo— y no corrompe datos, pero es la única forma
en que el batch puede producir más respuestas que el estado actual. Hay que
decidir si se acepta o se suprime.

### Coexistencia: el buffering no la empeora

Como solo se agrupan `received`, la pausa por `business_app` conserva su
entrega propia. Además el lote **añade** latencia antes de que el agente hable,
lo que da más margen a que la pausa llegue primero. El caso malo —el agente
responde y justo después escribe una persona— existe hoy exactamente igual.

---

## 5. Clasificación de eventos: qué pasa HOY

| `message.type` | Hoy | ¿Cambia en 5C? |
|---|---|---|
| `text` | determinístico o agente | participa del turno |
| `image` | persistido, `caption` como content; agente lo salta | **sí**: 5C.5 |
| `audio` `video` `document` `sticker` | persistido; agente lo salta | no |
| `reaction` | evento de canal: `content=NULL`, semántica en `metadata` | **resuelto en 5C.4** |
| `location` | ruta determinística | no |
| `interactive` / `nfm_reply` | ruta determinística | no |

**Las reacciones ya son silenciosas.** No llegan a Agent Core, no gastan
OpenAI, no usan tools, no responden y ni siquiera crean fila en `agent_runs`
—el gate está antes del claim—. Lo que falta no es callarlas: es **guardarlas
con sentido** (emoji + WAMID al que reaccionan) en vez de como `unknown`, y
dejar escrito que un Conversation Guard futuro no debe contarlas como flood.

**El bloqueante del wamid quedó resuelto:** la reacción trae `message.id`
propio, así que deduplica por la vía normal sin clave inventada.

Lo que el payload real destapó, y no estaba en esta auditoría, es otra cosa:
**`kapso.content` traía una frase redactada por Kapso.** Para
`content_type='unknown'`, `extractContent` aceptaba ese campo como cuerpo
textual, y las dos ventanas de contexto seleccionaban por presencia de texto,
no por tipo. La reacción nunca abría turno —eso siempre fue cierto— pero su
frase habría entrado al contexto del turno SIGUIENTE como palabras del cliente,
en inglés.

Lo que 5C.4 dejó escrito, y vale para 5C.5:

> Texto generado por el PROVEEDOR en un tipo de mensaje NO TEXTUAL no se
> convierte automáticamente en palabras del usuario.

El filtro es por `content_type`, no por las palabras, y es fail-closed: las dos
reacciones que ya estaban persistidas en Production quedaron fuera del contexto
sin tocar una sola fila.

Riesgo transversal del batch: al aceptar lotes, `processMessage` pasa a
ejecutarse N veces por invocación. Hay que garantizar que `location`,
`nfm_reply` y `TESTMENU9842` siguen entrando por su ruta determinística y que
ninguno se cuela al modelo por el camino nuevo.

---

## 6. Imágenes

Contrato documentado:

```json
{ "message": {
    "id": "wamid.789", "type": "image",
    "image": { "id": "media_id_123", "caption": "Photo description" },
    "kapso": {
      "has_media": true,
      "media_url": "https://api.kapso.ai/media/...",
      "media_data": { "url": "...", "filename": "photo.jpg",
                      "content_type": "image/jpeg", "byte_size": 204800 },
      "message_type_data": { "caption": "Photo description" } } } }
```

**El caption ya viaja dentro del mismo mensaje.** "Foto + caption en el mismo
turno" no necesita buffering: es un solo `received`. El buffering hace falta
solo para foto y pregunta como **dos** mensajes separados.

Dos decisiones nuevas que no existían antes:

1. **`media_url` es una URL con acceso a contenido del cliente.** Le aplica la
   misma regla que al token del menú: no puede aparecer en
   `agent_messages.content`, ni en `metadata`, ni en logs, ni en errores.
2. **Mandar una foto a OpenAI saca datos del cliente de nuestro perímetro.**
   Una foto de WhatsApp puede traer una cara, un carnet o un comprobante. Es
   una decisión de producto y privacidad, no un detalle técnico.

Regla de grounding, continuación de la que ya existe: la visión **entiende** la
imagen; los hechos siguen viniendo de tools. Nunca inferir de una foto
disponibilidad, precio, ingredientes oficiales, gluten, alergias ni seguridad
alimentaria. Encaja con las prohibiciones que ya están en el prompt.

---

## 7. Mark as read y typing

Política deseada: marcar leído cuando la IA va a llevar el turno; **nunca** con
la conversación pausada.

Obstáculo de orden: hoy el estado de pausa se consulta **dentro** de
`runAgentTurn`, después de `persistInbound` y de `processMessage`. Marcar leído
pronto —que es justo lo que le da sentido— exige conocer la pausa antes. Es un
cambio de orden en el webhook, no una función suelta.

El typing indicator, con turnos de 11 s, aportaría de verdad. Pero se envía
antes de llamar al modelo y suma latencia al mismo presupuesto del §3: solo
tiene sentido después de resolver el ACK.

Falta el contrato de ambos endpoints; no estaban en las páginas consultadas.

---

## 8. Identidad (solo documentar)

`customerPhone` sale de `conversation.phone_number` y es la identidad durable;
`conversation.id` es referencia volátil. Existe el evento
`whatsapp.contact.identity_changed`, que hoy cae en `ignored`.

**Deuda nueva que sí crearía 5C**: si los elementos de `data[]` no traen su
propio `conversation`, la identidad de cada mensaje del lote pasaría a depender
del sobre. Eso acopla identidad y transporte justo en la capa que el refactor
BSUID tendrá que tocar. Es la razón práctica para resolver el desconocido §2.1
antes de escribir código.

### Evidencia BSUID capturada en 5C.4 (solo documentar)

El payload real de la reacción confirmó que el identificador estable del
contacto viaja en DOS sitios:

```
message.from_user_id                       = "BO…"
conversation.business_scoped_user_id       = "BO…"
```

Es lo que la futura fase BSUID necesitaba observar: existe, viene en cada
sobre —también dentro de `data[]`— y no depende del envoltorio del lote. Sigue
sin usarse: 5C.4 resuelve identidad por `conversation.phone_number`, igual que
todo lo demás.

Sin refactor BSUID en 5C.

---

## 9. Subfases propuestas

Reordenadas respecto al borrador, por lo que dice la evidencia del §3.

| | Subfase | Contenido |
|---|---|---|
| **5C.0** | Captura de contrato | Payload real de lote, reacción e imagen. Sin código. |
| **5C.1** | Decisión de ACK | Con la medición ya hecha: ¿síncrono o ACK + proceso durable? Es un gate, no necesariamente implementación. |
| **5C.2** | Soporte de lote | El webhook acepta 1 o N `received`. **Buffering sigue apagado.** |
| **5C.3** | Activar buffering | Flip en Kapso + smokes de ráfaga. |
| **5C.4** | Reacciones | Persistencia con emoji y target. Silencio ya garantizado. |
| **5C.5** | Imágenes / visión | Depende de 5C.1. |
| **5C.6** | mark-as-read / typing | Typing depende de 5C.1. |

El cambio frente al borrador es que **el ACK sube al principio**: es lo único
que hoy ya incumple el contrato publicado, y cada subfase posterior lo empeora.

---

## 10. El momento EXACTO de activar el buffering

**Nunca antes de que 5C.2 esté desplegado y verificado en Production.**

Hoy, buffering activado = `422 unsupported_batch` en cada ráfaga; agotados los
reintentos, Kapso cae a entrega individual, así que los mensajes probablemente
no se pierden — pero durante los cuatro intentos el cliente no recibe nada y el
evento queda `failed`. No hay razón para pasar por ahí.

El orden es el mismo que el de las migraciones: **primero el código, después el
interruptor.**

La secuencia:

1. 5C.2 en Production.
2. Comprobar que un `received` **individual** se sigue atendiendo exactamente
   igual — el camino de lote está vivo pero sin ejercitar.
3. Activar en Kapso con **ventana 5 s y tamaño máximo 10**, no 50: un lote de
   50 en una invocación que ya va justa de ACK no es una prueba, es una caída.
4. Ráfaga inmediata desde `AI_TEST_PHONE`: tres mensajes seguidos.
5. Verificar 3 `agent_messages`, **1** `agent_run`, y que el CTA salió una sola
   vez.

Si algo falla: desactivar el buffering en Kapso primero. Es reversible en un
clic y el código de lote no estorba con el buffering apagado.

---

## 11. Pruebas reales que harán falta

- **Ráfaga de 3 mensajes** → 3 `agent_messages`, 1 `agent_run`, 1 respuesta.
- **Ráfaga con petición de menú al final** → 1 solo CTA.
- **Reintento de lote** → sin mensajes duplicados y sin segundo turno.
- **Lote + takeover humano** durante la ventana → el agente calla.
- **Reacción sola** → 0 runs, 0 respuesta.
- **Foto sola** y **foto + caption** → un turno, y ningún hecho de negocio
  afirmado desde la imagen.
- **Medición de ACK** en cada subfase: es el número que decide si se puede
  seguir añadiendo.
