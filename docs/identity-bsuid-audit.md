# Auditoría de identidad — ¿recibimos BSUID?

Hallazgo de la Fase 6D.2F.5B §0. **Solo informe**: no se refactorizó nada, no
hay migración y la identidad sigue siendo `customer_phone`.

## Respuesta corta

**No recibimos BSUID.** No existe `user_id`, `bsuid`, `business_scoped_id` ni
`wa_id` en ningún punto del código, de los fixtures ni de los payloads que
parseamos. No es que lo descartemos: es que no está.

Búsqueda ejecutada sobre todo `src/`:

```
bsuid | user_id | business_scoped | wa_id   →  0 coincidencias
```

## Qué SÍ trae el payload y qué hacemos con ello

Todo lo que se extrae vive en `parseKapsoProvenance`
([provenance.ts](../src/lib/kapso/channel/provenance.ts)):

| Campo del payload | Dónde acaba | Papel |
|---|---|---|
| `message.id` | `providerMessageId` | WAMID — idempotencia semántica |
| `conversation.phone_number` | `customerPhone` (normalizado) | **identidad durable** |
| `conversation.id` | `providerConversationId` | referencia técnica **volátil**, nunca identidad |
| `phone_number_id` (raíz o conversación) | `providerPhoneNumberId` | número del negocio por el que responder |
| `message.timestamp` | `messageTimestamp` | instante real, nunca "ahora" en silencio |
| `kapso.direction/origin/status` | procedencia | decide takeover vs. cloud_api |

`customerPhone` sale **siempre** de `conversation.phone_number`, con
`message.from` solo como respaldo en entrantes: en un saliente, `message.from`
es el número del negocio, y usarlo como identidad mezclaría al restaurante con
el cliente.

Si un BSUID llegara mañana en el payload, hoy **no sobreviviría**:
`extractMetadata` es una lista blanca estricta que solo conserva coordenadas de
`location` y el `interactive_type`. Todo lo demás se descarta por diseño.

## Qué depende hoy exclusivamente de `customer_phone`

Esto es lo que habría que tocar el día que la identidad cambie:

- `agent_conversations.customer_phone` — **UNIQUE**; es la identidad durable del
  agente y la clave de todo el historial.
- `menu_sessions.customer_phone` — reutilización de sesión vigente.
- `menu_send_deliveries.customer_phone` — clave del cooldown (0015).
- `orders.customer_phone` — pedidos y sus notificaciones.
- `AI_TEST_PHONE` — elegibilidad por coincidencia exacta de dígitos.
- `POST /api/internal/agent/resume` — recibe `customer_phone`.
- Reconciliación de notificaciones — `resolveOrder` devuelve
  `customerPhoneDigits`.

## Por qué esto importa para una microfase futura

Un teléfono es una identidad **reasignable**: la gente cambia de número y las
operadoras reciclan los que quedan libres. El día que eso pase, el historial de
conversación de una persona quedaría accesible para otra.

Un identificador estable del proveedor resolvería eso, pero **hoy no lo
tenemos**, así que la microfase tendría que empezar por confirmar si Kapso puede
emitirlo. Sin ese dato, migrar la identidad sería cambiar una clave conocida por
una que no existe.

Nada de esto es urgente ni bloquea el agente: se deja escrito para que la
decisión se tome con el hallazgo delante y no de memoria.
