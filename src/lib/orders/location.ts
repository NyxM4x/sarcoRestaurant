import type { OrderStatus } from '@/types';
import type { SendLocationResult } from '@/lib/kapso/transport';

/**
 * Solicitud de ubicación para pedidos delivery — lógica pura (Fase 3.3A).
 *
 * Idempotencia y concurrencia (defensa en capas, sin migraciones):
 *  1. Capa evento (webhook 3.1): un mismo X-Idempotency-Key nunca se procesa en
 *     paralelo; el reintento de `failed` usa un claim atómico.
 *  2. Capa lectura: aquí se relee el pedido y solo se envía si
 *     `status = 'awaiting_location'` y `location_request_message_id IS NULL`.
 *  3. Capa guardado (exactamente-una-vez): el UPDATE condicional del store solo
 *     escribe si `location_request_message_id` sigue NULL; la ejecución que
 *     pierde relee y NO sobrescribe.
 * Riesgo residual documentado: dos eventos distintos simultáneos podrían llamar
 * a Kapso dos veces (sin corrupción de datos: un solo wamid se persiste).
 */

export interface LocationOrderRow {
  id: string;
  status: OrderStatus;
  customer_phone: string;
  location_request_message_id: string | null;
}

export interface LocationRequestStore {
  findForLocationRequest(orderId: string): Promise<LocationOrderRow | null>;
  /**
   * Guardado condicional: UPDATE … WHERE id = ? AND status = 'awaiting_location'
   * AND location_request_message_id IS NULL. Devuelve 'saved' si esta ejecución
   * escribió, 'no_rows' si la condición ya no se cumplía.
   */
  saveLocationRequestMessageId(orderId: string, wamid: string): Promise<'saved' | 'no_rows'>;
}

/** Enviador inyectable (la implementación real es el cliente de Kapso). */
export type LocationSender = (customerPhone: string) => Promise<SendLocationResult>;

export type EnsureLocationResult =
  | { result: 'requested' }
  | { result: 'already_requested' }
  | { result: 'not_applicable' }
  | { result: 'send_failed'; error: string };

/**
 * Garantiza (idempotentemente) que un pedido `awaiting_location` tenga su
 * solicitud de ubicación enviada y el wamid persistido.
 *
 * - Usa SOLO el estado guardado del pedido (nunca el delivery_type del Flow).
 * - No inventa wamid: si el envío falla, no marca nada y devuelve `send_failed`
 *   (el caller marca el webhook_event como failed para permitir reintento).
 */
export async function ensureLocationRequest(
  store: LocationRequestStore,
  sender: LocationSender,
  orderId: string,
): Promise<EnsureLocationResult> {
  const order = await store.findForLocationRequest(orderId);

  // Pickup, ya confirmado sin ubicación pendiente, o estado posterior: nada que hacer.
  if (!order || order.status !== 'awaiting_location') return { result: 'not_applicable' };

  // Idempotencia: si ya hay solicitud enviada, no volver a llamar a Kapso.
  if (order.location_request_message_id !== null) return { result: 'already_requested' };

  const sent = await sender(order.customer_phone);
  if (!sent.ok) {
    // Sin wamid inventado; el pedido permanece awaiting_location.
    return { result: 'send_failed', error: sent.error };
  }

  const saved = await store.saveLocationRequestMessageId(orderId, sent.wamid);
  if (saved === 'saved') return { result: 'requested' };

  // Otra ejecución guardó primero: releer y no sobrescribir.
  const fresh = await store.findForLocationRequest(orderId);
  if (fresh?.location_request_message_id) return { result: 'already_requested' };
  return { result: 'send_failed', error: 'save_conflict' };
}
