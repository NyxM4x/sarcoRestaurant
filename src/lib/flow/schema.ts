import { z } from 'zod';
import { DELIVERY_TYPES } from '@/types';

/**
 * Formato del `flow_token`: `order_<uuid>` (ver Fase 2.1). Se usa tanto en el
 * Data Endpoint como al procesar el `nfm_reply`.
 */
export const FLOW_TOKEN_RE =
  /^order_[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Contrato de entrada de `POST /api/flow/order-summary`.
 *
 * Este endpoint es llamado por la **Kapso Function** (Data Endpoint), no
 * directamente por WhatsApp. La Kapso Function envía el `data_exchange` del Flow
 * y añade datos de contexto que el Flow no maneja (teléfono, validez de firma).
 *
 * Correlación (confirmado por Kapso Support): antes de enviar cada Flow se
 * genera un UUID único y el Flow usa `flow_token = order_{order_session_id}`.
 * Los campos de correlación (`order_session_id`, `customer_phone`,
 * `conversation_id`) llegan desde `flow_action_payload.data`; el mismo
 * `flow_token` se repite en cada `data_exchange` y en el `nfm_reply`.
 *
 * `data` es un mapa plano de los campos `${form.campo}` del Flow: incluye
 * `customer_name`, `notes`, `delivery_type` y las cantidades por producto, donde
 * cada clave de cantidad es el `code` del producto (p. ej. `trancapecho: "2"`).
 */
export const orderSummaryRequestSchema = z.object({
  /** Token del Flow para correlacionar el borrador (único; `order_{order_session_id}`). */
  flow_token: z.string().min(1),
  /** Id de sesión del pedido (UUID, desde `flow_action_payload.data`). */
  order_session_id: z.uuid(),
  /** Teléfono del cliente (desde `flow_action_payload.data`). Obligatorio. */
  customer_phone: z.string().min(1),
  /** Id de conversación de WhatsApp (desde `flow_action_payload.data`). */
  conversation_id: z.string().min(1).optional(),
  /** Validez de firma del Data Endpoint (IDEA.md §9). Si viene, debe ser true. */
  signature_valid: z.boolean().optional(),
  /** Campos planos del formulario del Flow. */
  data: z
    .object({
      customer_name: z.string().optional(),
      notes: z.string().optional(),
      delivery_type: z.enum(DELIVERY_TYPES),
    })
    // Las cantidades por producto llegan como claves adicionales (code -> valor).
    .catchall(z.unknown()),
}).refine((v) => v.flow_token === `order_${v.order_session_id}`, {
  // Coherencia de correlación: el token debe derivar del order_session_id.
  // Si no coinciden, se rechaza y no se crea/actualiza el borrador.
  error: 'flow_token debe ser exactamente `order_${order_session_id}`.',
  path: ['flow_token'],
});

export type OrderSummaryRequest = z.infer<typeof orderSummaryRequestSchema>;
