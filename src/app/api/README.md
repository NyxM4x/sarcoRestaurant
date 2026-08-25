# API Routes

Estructura de los Route Handlers (IDEA.md §10, §15).

| Endpoint | Método | Fase | Estado | Responsabilidad |
|---|---|---|---|---|
| `/api/flow/order-summary` | `POST` | 2 | ✅ implementado | Autenticar (Bearer), validar `data_exchange`, normalizar cantidades, consultar precios reales, calcular total, crear/actualizar borrador, devolver `ORDER_SUMMARY`. |
| `/api/kapso/webhook` | `POST` | 3 | 🟡 3.1 + 3.2 + 3.3A + 3.3B | Firma HMAC + idempotencia (`3.1`); `nfm_reply` → confirmación (`3.2`); delivery → envío idempotente de `location_request_message` (`3.3A`); `type=location` → asociación idempotente al pedido (`3.3B`). Falta: mensaje final "ubicación recibida". |
| `/api/orders` | `GET` | 5 | ⏳ pendiente | Listar pedidos para el dashboard, con filtros por estado y fecha. |
| `/api/orders/[id]` | `PATCH` | 5 | ⏳ pendiente | Cambiar el estado del pedido validando transiciones. |
| `/api/health` | `GET` | 4.1 | ✅ implementado | Comprobación mínima de que el deployment responde. **No** consulta Supabase, no lee env ni expone versiones. |

## Contrato · `POST /api/flow/order-summary` (Fase 2)

Lo llama la **Kapso Function** (Data Endpoint), no WhatsApp directamente.

**Correlación** (confirmado por Kapso Support): antes de enviar cada Flow se genera un
UUID único y el Flow usa `flow_token = order_{order_session_id}`. Los campos
`order_session_id`, `customer_phone` y `conversation_id` llegan desde
`flow_action_payload.data`. El mismo `flow_token` se repite en cada `data_exchange`
y en el `nfm_reply`, y es **único** por pedido (índice parcial `orders_flow_token_unique`).

- **Auth**: header `Authorization: Bearer <INTERNAL_API_TOKEN>` (comparación timing-safe).
- **Request** (JSON):
  ```jsonc
  {
    "flow_token": "order_9f1c...",      // único; order_{order_session_id}
    "order_session_id": "9f1c...",       // desde flow_action_payload.data
    "customer_phone": "59170000000",     // desde flow_action_payload.data (obligatorio)
    "conversation_id": "conv_123",       // desde flow_action_payload.data (opcional)
    "signature_valid": true,             // opcional; si es false -> 401
    "data": {
      "customer_name": "Juan",
      "notes": "sin cebolla",
      "delivery_type": "delivery",       // "delivery" | "pickup"
      "trancapecho": "2",                // cantidades por CODE de producto (0..10)
      "gaseosa_2l": "1"
    }
  }
  ```
  Las cantidades se mapean por el `code` real del menú activo (Supabase); los precios,
  totales y resúmenes provienen de la BD, **nunca** del payload de WhatsApp. El borrador
  se crea o actualiza correlacionando por `flow_token` único.
- **Response** (pantalla `ORDER_SUMMARY`):
  ```jsonc
  {
    "screen": "ORDER_SUMMARY",
    "data": {
      "order_draft_id": "uuid",
      "summary_lines": ["2x Trancapecho — Bs. 36", "1x Gaseosa 2 L — Bs. 18"],
      "total_text": "Bs. 54",
      "delivery_type": "delivery",
      "customer_name": "Juan",
      "notes": "sin cebolla"
    }
  }
  ```
- **Errores**: `400` JSON inválido · `401` auth/firma · `422` validación (Zod o
  pedido vacío/cantidad fuera de rango) · `500` interno.

## Base segura · `POST /api/kapso/webhook` (Fase 3.1)

Recibe los webhooks de Kapso. Esta fase implementa **solo** la seguridad y la
idempotencia; el procesamiento de negocio (`nfm_reply`, confirmación, ubicación,
envío de mensajes) llega en la Fase 3.2.

- **Body crudo**: se lee con `await req.text()` (necesario para el HMAC).
- **Headers**:
  - `X-Webhook-Signature`: HMAC SHA-256 del body crudo con `KAPSO_WEBHOOK_SECRET`.
    Formato Kapso **V2**: hexadecimal directo de **64 caracteres**, **sin** prefijo
    `sha256=`. Se valida el formato hex y se compara en tiempo constante.
  - `X-Webhook-Payload-Version`: debe ser `v2` (si no, `400`).
  - `X-Webhook-Event`: solo se procesa `whatsapp.message.received`; el resto se
    ignora con `200 { ok: true, ignored: true }`.
  - `X-Idempotency-Key`: clave de idempotencia (se guarda en `webhook_events.event_id`,
    único). Obligatoria (`400` si falta).
- **Idempotencia por estado** (según `webhook_events.status`):
  - `processed`  → `200 { ok: true, duplicate: true }` (no se reprocesa).
  - `processing` → `200 { ok: true, in_progress: true }` (otra ejecución lo tiene).
  - `failed`     → se **reintenta**: transición atómica `failed → processing`
    (`UPDATE … WHERE status='failed'`); solo una ejecución concurrente la gana. Si
    otra ya lo tomó → `200 { ok: true, in_progress: true }`. El registro fallido
    **no se elimina** (se conserva payload y diagnóstico).
  - nuevo → insert en `processing` (la unicidad de `event_id` cubre carreras).
- **Estados** en `webhook_events`: `processing` → `processed` | `failed`
  (y `failed` → `processing` en reintento).
- **Respuestas**: `200 { ok: true }` procesado · `200 { ok: true, ignored: true }` ·
  `200 { ok: true, duplicate: true }` · `200 { ok: true, in_progress: true }` ·
  `400` versión/idempotency · `401` firma · `500` interno.
- **Logs**: estructurados, sin firma, secreto ni payload completo.

### Formato del payload (Webhooks V2, sin buffering)

> ⚠️ El webhook de Kapso debe configurarse **SIN buffering**. Con buffering
> desactivado, el payload canónico de `whatsapp.message.received` llega en la raíz:
>
> ```jsonc
> { "message": {}, "conversation": {}, "is_new_conversation": false, "phone_number_id": "..." }
> ```

- Se leen **solo** `payload.message`, `payload.conversation` y `payload.phone_number_id`
  (sin fallback a `payload.data.*`).
- **Batch** (buffering activado) se detecta con `payload.batch === true` &&
  `Array.isArray(payload.data)`. No se procesa: se responde **`422 { ok: false,
  error: 'unsupported_batch' }`** y se registra `warn` estructurado (sin payload),
  para que la entrega **falle visiblemente** en Kapso en lugar de descartarse en
  silencio. Configurar el webhook sin buffering resuelve el 422.
- Nota: `context.phone_number` pertenece al contexto de los **Workflows** de Kapso y
  **no** existe como campo del webhook. En el webhook, `message.context` es el
  contexto de respuesta (`message.context.from`, `message.context.id`).

### Procesamiento de `nfm_reply` (Fase 3.2)

Cuando el mensaje es la respuesta final del Flow:

- **Detección**: `message.type === 'interactive'` y `message.interactive.type === 'nfm_reply'`.
- **Respuesta del Flow**: preferente `message.kapso.flow_response`; fallback
  `JSON.parse(message.interactive.nfm_reply.response_json)`.
- **Validación Zod**: `order_draft_id` (UUID) y `flow_token` (`order_<uuid>`). Payloads
  incompletos/ inválidos → `result: 'invalid'` (se marca `processed`, no se reintenta).
- **Cliente**: teléfono desde `conversation.phone_number` (fallback `message.from`).
  Se **normaliza a solo dígitos** el del webhook **y** el guardado en
  `orders.customer_phone` antes de comparar (tolera `+`, espacios y separadores; no
  se asume que vengan sin `+`). Nunca se loguea el número completo (versión
  enmascarada si hace falta).
- **Confirmación (`confirmOrderDraft`)**: busca por `order_draft_id`, valida
  `flow_token` y teléfono, exige ≥1 `order_item`, usa **solo** precios/total/
  delivery_type de Supabase (nunca del nfm_reply), guarda `source_message_id` y
  `confirmed_at`, conserva el `order_number` de PostgreSQL.
  - Transición: `pickup → confirmed`, `delivery → awaiting_location`.
  - **Atómico e idempotente**: `UPDATE … WHERE id=? AND status='draft' AND
    source_message_id IS NULL`. Resultados: `confirmed`, `already_confirmed`
    (mismo mensaje), `already_confirmed_by_another_message`/`conflict`, `not_found`,
    `flow_token_mismatch`, `phone_mismatch`, `empty_order`.
- **`webhook_events`**: se guarda `message.id` en `message_id`; el evento se marca
  `processed` en éxito o resultado idempotente/rechazo determinista; `failed` solo
  ante fallos reales de infraestructura.
- **Respuesta HTTP temporal** (aún no se envían mensajes por Kapso):
  ```jsonc
  { "ok": true, "handled": "nfm_reply", "order_id": "...", "order_number": "ORD-000123",
    "status": "confirmed", "result": "confirmed" }
  ```
  `status` = estado real (`confirmed` | `awaiting_location`); `result` ∈
  `confirmed | already_confirmed | conflict | ignored | invalid | rejected |
  location_requested`. No se devuelven `raw_flow_response`, `customer_phone`,
  precios internos, payload ni secretos.

### Solicitud de ubicación para delivery (Fase 3.3A)

Tras confirmar un `nfm_reply`, si el pedido quedó (o ya estaba) en
`awaiting_location` — decidido SOLO por el estado guardado en Supabase, nunca por
datos del Flow:

- Se envía el `location_request_message` por Kapso (payload exacto en
  `src/lib/kapso/messages.ts`) y el wamid de `response.messages[0].id` se guarda
  en `orders.location_request_message_id`.
- **Idempotencia**: si `location_request_message_id` ya tiene valor, NO se vuelve
  a llamar a Kapso (responde `already_confirmed` con el mismo estado). El guardado
  es condicional (`WHERE status='awaiting_location' AND location_request_message_id
  IS NULL`): solo una ejecución concurrente persiste; la otra relee y no sobrescribe.
- **Éxito**: respuesta `{ ok: true, handled: "nfm_reply", …, status:
  "awaiting_location", result: "location_requested" }`.
- **Fallo de envío** (HTTP error, respuesta sin `messages[0].id`, timeout): no se
  inventa wamid, el pedido permanece `awaiting_location`, el evento queda `failed`
  (reintentable) y se responde `500`. En el reintento, aunque la confirmación dé
  `already_confirmed`, si falta el wamid se vuelve a intentar el envío.
- Pickup (`confirmed`) nunca dispara la solicitud.
- **Endpoint oficial de Kapso** (confirmado por su documentación):
  `POST https://api.kapso.ai/meta/whatsapp/v24.0/{phone_number_id}/messages`,
  headers `Content-Type: application/json` y `X-API-Key: <KAPSO_API_KEY>`; el
  wamid se lee de `messages[0].id`. `KAPSO_API_BASE_URL` permite sobreescribir la
  base solo para pruebas locales (ver `src/lib/kapso/client.ts`).

### Procesamiento de `message.type = "location"` (Fase 3.3B)

Cuando el cliente responde al `location_request_message`:

- **Detección**: `message.type === "location"` (se comprueba antes que
  `nfm_reply`, ya que `location` no es un mensaje `interactive`).
- **Correlación** (confirmada por Kapso): `message.context.id` contiene el wamid
  del `location_request_message` saliente y se compara con
  `orders.location_request_message_id` (única, Fase 3.3A) — no con
  `source_message_id` ni `flow_token`.
- **Validación Zod** (`src/lib/flow/location-message.ts`): `message.id` y
  `message.context.id` no vacíos; `latitude` en [-90, 90]; `longitude` en
  [-180, 180]; `address`/`name` opcionales. Payload inválido → `result: "invalid"`,
  el evento se marca `processed` (no reintenta) y el pedido no se modifica.
- **Cliente**: teléfono desde `conversation.phone_number` (fallback
  `message.from`), normalizado a solo dígitos en ambos lados antes de comparar con
  `orders.customer_phone` (mismo mecanismo que en `nfm_reply`, Fase 3.2).
- **`attachLocation`** (`src/lib/orders/attach-location.ts`): busca el pedido por
  `location_request_message_id = message.context.id`, valida teléfono y
  `status = 'awaiting_location'`, exige que el pedido no tenga ubicación previa, y
  guarda `delivery_latitude/longitude/address/location_name` + `status =
  'confirmed'`. **No** modifica `order_number`, `total_amount`,
  `source_message_id`, `flow_token` ni `order_items`.
- **Atomicidad e idempotencia** (sin migraciones nuevas): el guardado es
  `UPDATE … WHERE location_request_message_id=? AND status='awaiting_location' AND
  delivery_latitude IS NULL AND delivery_longitude IS NULL` — las columnas de
  ubicación NULL son el "claim" implícito; solo una ejecución concurrente escribe.
  Si el pedido ya tiene ubicación guardada, se comparan las coordenadas: iguales →
  idempotente (`already_attached`); distintas → **no se sobrescribe**
  (`location_conflict`). No fue necesario guardar el `message.id` de la respuesta
  de ubicación: la idempotencia de evento ya la cubre `webhook_events.event_id`, y
  la comparación de coordenadas cubre reintentos con una idempotency key nueva.
- **Resultados tipados**: `attached | already_attached | not_found |
  phone_mismatch | invalid_status | location_conflict | concurrent_update`. Todos
  los rechazos deterministas marcan el evento `processed` (no reintentar); solo
  errores reales de infraestructura (excepciones del store) marcan `failed` y
  responden `500`.
- **Respuesta HTTP** (éxito): `{ ok: true, handled: "location", order_id, order_number,
  status: "confirmed", result: "attached" | "already_attached" }`. Conflicto:
  `{ ok: true, handled: "location", result: "conflict" }`. Nunca se devuelven
  coordenadas, dirección, teléfono, secretos ni el payload crudo.

## Reglas al implementar

- Toda la lógica de negocio vive en `src/lib/*` (server-only), no en los handlers.
- Los precios se leen SIEMPRE desde Supabase; nunca del payload del cliente.
- Secretos solo en el backend; nunca en el frontend ni en logs.
- Comparar tokens/secretos de forma segura (timing-safe).
