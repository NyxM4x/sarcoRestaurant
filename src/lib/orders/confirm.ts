import type { DeliveryType, OrderStatus } from '@/types';
import { normalizePhone } from '@/lib/phone';

/**
 * Confirmación de un borrador de pedido — lógica pura con store inyectable
 * (la implementación real sobre Supabase vive en `service.ts`).
 *
 * Solo usa productos, cantidades, precios, total y delivery_type ya guardados en
 * Supabase: NO confía en nada enviado en el nfm_reply salvo la correlación
 * (order_draft_id, flow_token) y el teléfono del webhook.
 */

/** Fila mínima del pedido necesaria para confirmar. */
export interface DraftOrderRow {
  id: string;
  order_number: string;
  flow_token: string | null;
  customer_phone: string;
  delivery_type: DeliveryType;
  status: OrderStatus;
  source_message_id: string | null;
}

/** Resultado del UPDATE condicional atómico. */
export type ConfirmIfDraftResult =
  | DraftOrderRow // ganó la actualización (fila ya con nuevo estado)
  | null // no matcheó la condición (0 filas)
  | { uniqueViolation: true }; // source_message_id ya usado por otro pedido

export interface OrderConfirmationStore {
  findById(orderId: string): Promise<DraftOrderRow | null>;
  countItems(orderId: string): Promise<number>;
  /**
   * Atómico: SET status/source_message_id/confirmed_at
   * WHERE id = ? AND status = 'draft' AND source_message_id IS NULL.
   */
  confirmIfDraft(input: {
    orderId: string;
    newStatus: 'confirmed' | 'awaiting_location';
    sourceMessageId: string;
    confirmedAt: string;
  }): Promise<ConfirmIfDraftResult>;
}

export interface ConfirmOrderInput {
  orderDraftId: string;
  flowToken: string;
  /** Teléfono del webhook ya normalizado a solo dígitos. */
  customerPhoneDigits: string;
  sourceMessageId: string;
}

/** Pedido confirmado (o ya confirmado) para la respuesta. */
export interface ConfirmedOrderView {
  id: string;
  order_number: string;
  status: OrderStatus;
}

export type ConfirmResultKind =
  | 'confirmed'
  | 'already_confirmed'
  | 'already_confirmed_by_another_message'
  | 'conflict'
  | 'not_found'
  | 'flow_token_mismatch'
  | 'phone_mismatch'
  | 'empty_order';

export type ConfirmOrderResult =
  | { result: 'confirmed'; order: ConfirmedOrderView }
  | { result: 'already_confirmed'; order: ConfirmedOrderView }
  | { result: 'already_confirmed_by_another_message'; order: ConfirmedOrderView }
  | { result: 'conflict'; reason: string }
  | { result: 'not_found' }
  | { result: 'flow_token_mismatch' }
  | { result: 'phone_mismatch' }
  | { result: 'empty_order' };

function toView(row: DraftOrderRow): ConfirmedOrderView {
  return { id: row.id, order_number: row.order_number, status: row.status };
}

/**
 * Confirma un borrador de forma atómica e idempotente.
 */
export async function confirmOrderDraft(
  store: OrderConfirmationStore,
  input: ConfirmOrderInput,
): Promise<ConfirmOrderResult> {
  const order = await store.findById(input.orderDraftId);
  if (!order) return { result: 'not_found' };

  // Idempotencia: si ya tiene source_message_id, no se re-modifica.
  if (order.source_message_id !== null) {
    return order.source_message_id === input.sourceMessageId
      ? { result: 'already_confirmed', order: toView(order) }
      : { result: 'already_confirmed_by_another_message', order: toView(order) };
  }

  // Correlación (solo si aún no está confirmado).
  if (order.flow_token !== input.flowToken) return { result: 'flow_token_mismatch' };
  if (normalizePhone(order.customer_phone) !== input.customerPhoneDigits) {
    return { result: 'phone_mismatch' };
  }
  if (order.status !== 'draft') {
    return { result: 'conflict', reason: `unexpected_status:${order.status}` };
  }

  const itemCount = await store.countItems(order.id);
  if (itemCount < 1) return { result: 'empty_order' };

  const newStatus = order.delivery_type === 'delivery' ? 'awaiting_location' : 'confirmed';

  const updated = await store.confirmIfDraft({
    orderId: order.id,
    newStatus,
    sourceMessageId: input.sourceMessageId,
    confirmedAt: new Date().toISOString(),
  });

  if (updated && typeof updated === 'object' && 'uniqueViolation' in updated) {
    // El mismo source_message_id ya está en otro pedido.
    return { result: 'conflict', reason: 'source_message_id_conflict' };
  }

  if (updated === null) {
    // Perdió la carrera: otra ejecución confirmó entremedio. Releer para dar un
    // resultado idempotente/controlado sin modificar datos.
    const fresh = await store.findById(order.id);
    if (fresh && fresh.source_message_id === input.sourceMessageId) {
      return { result: 'already_confirmed', order: toView(fresh) };
    }
    if (fresh && fresh.source_message_id !== null) {
      return { result: 'already_confirmed_by_another_message', order: toView(fresh) };
    }
    return { result: 'conflict', reason: 'concurrent_update' };
  }

  return { result: 'confirmed', order: toView(updated) };
}
