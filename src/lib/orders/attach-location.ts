import type { DeliveryPricing, OrderStatus } from '@/types';
import { normalizePhone } from '@/lib/phone';

/**
 * Asociación de ubicación (message.type = "location") a un pedido — lógica
 * pura con store inyectable (Fase 3.3B).
 *
 * Idempotencia y concurrencia (sin migraciones nuevas):
 *  - Correlación exacta por `location_request_message_id` (ya única, Fase 3.3A).
 *  - El guardado es atómico: UPDATE … WHERE location_request_message_id=? AND
 *    status='awaiting_location' AND delivery_latitude IS NULL AND
 *    delivery_longitude IS NULL. Las columnas de ubicación NULL son el "claim"
 *    implícito: solo una ejecución concurrente puede escribir.
 *  - Si el pedido ya tiene ubicación guardada (delivery_latitude/longitude no
 *    nulos), se compara con las coordenadas entrantes: iguales -> idempotente
 *    (already_attached); distintas -> NO se sobrescribe (location_conflict).
 *  - No se requiere guardar el message.id de la respuesta de ubicación: la
 *    idempotencia de evento ya la cubre `webhook_events.event_id`, y la
 *    comparación de coordenadas cubre reintentos con una idempotency key nueva.
 *
 * 6D.2C — delivery DINÁMICO: `delivery_pricing='dynamic'` NO confirma al recibir
 * la ubicación. Guarda el GPS y CONSERVA `status='awaiting_location'` (la
 * cotización con Mapbox decide después). Legacy (`delivery_pricing IS NULL`)
 * mantiene EXACTAMENTE el comportamiento anterior: GPS + awaiting_location →
 * confirmed. La rama la elige `delivery_pricing`, no el tipo de pedido.
 */

export interface LocationOrderRow {
  id: string;
  order_number: string;
  status: OrderStatus;
  customer_phone: string;
  location_request_message_id: string | null;
  delivery_latitude: number | null;
  delivery_longitude: number | null;
  confirmed_at: string | null;
  /** Modo de tarificación (6D.2B). `'dynamic'` → NO confirmar al adjuntar GPS. */
  delivery_pricing: DeliveryPricing | null;
}

export interface AttachLocationStore {
  findByLocationRequestMessageId(contextId: string): Promise<LocationOrderRow | null>;
  /**
   * Atómico: UPDATE … SET …, status='confirmed', confirmed_at=? WHERE id=? AND
   * location_request_message_id=? AND status='awaiting_location' AND
   * delivery_latitude IS NULL AND delivery_longitude IS NULL. Devuelve la fila
   * actualizada o `null` si la condición ya no se cumplía (perdió la carrera).
   *
   * `confirmedAt` viene ya resuelto por el llamador con semántica coalesce
   * (conserva el `confirmed_at` previo si existía; usa "ahora" solo si era NULL).
   */
  attachIfPending(input: {
    orderId: string;
    contextId: string;
    latitude: number;
    longitude: number;
    address: string | null;
    name: string | null;
    confirmedAt: string;
  }): Promise<LocationOrderRow | null>;
  /**
   * 6D.2C — variante DINÁMICA: guarda el GPS SIN tocar `status` ni
   * `confirmed_at`. Atómico: UPDATE … SET delivery_latitude/longitude/address/
   * name WHERE id=? AND location_request_message_id=? AND
   * status='awaiting_location' AND delivery_latitude IS NULL AND
   * delivery_longitude IS NULL. Devuelve la fila actualizada (que sigue en
   * `awaiting_location`) o `null` si perdió la carrera. NO confirma: la
   * cotización lo hará después vía `apply_delivery_quote`.
   */
  attachIfPendingDynamic(input: {
    orderId: string;
    contextId: string;
    latitude: number;
    longitude: number;
    address: string | null;
    name: string | null;
  }): Promise<LocationOrderRow | null>;
}

export interface AttachLocationInput {
  contextId: string;
  /** Teléfono del webhook ya normalizado a solo dígitos. */
  customerPhoneDigits: string;
  latitude: number;
  longitude: number;
  address?: string | null;
  name?: string | null;
}

export interface AttachedOrderView {
  id: string;
  order_number: string;
  status: OrderStatus;
}

export type AttachLocationResult =
  | { result: 'attached'; order: AttachedOrderView }
  | { result: 'already_attached'; order: AttachedOrderView }
  | { result: 'not_found' }
  | { result: 'phone_mismatch' }
  | { result: 'invalid_status' }
  | { result: 'location_conflict' }
  | { result: 'concurrent_update' };

function toView(row: LocationOrderRow): AttachedOrderView {
  return { id: row.id, order_number: row.order_number, status: row.status };
}

function hasLocation(row: LocationOrderRow): boolean {
  return row.delivery_latitude !== null && row.delivery_longitude !== null;
}

function coordsMatch(row: LocationOrderRow, input: AttachLocationInput): boolean {
  return row.delivery_latitude === input.latitude && row.delivery_longitude === input.longitude;
}

/**
 * Asocia la ubicación recibida a un pedido, buscando por
 * `location_request_message_id = contextId`. No usa datos del Flow: solo el
 * pedido guardado y el teléfono/coordenadas del webhook.
 */
export async function attachLocation(
  store: AttachLocationStore,
  input: AttachLocationInput,
): Promise<AttachLocationResult> {
  const order = await store.findByLocationRequestMessageId(input.contextId);
  if (!order) return { result: 'not_found' };

  // Idempotencia: si ya tiene ubicación, no se sobrescribe.
  if (hasLocation(order)) {
    return coordsMatch(order, input)
      ? { result: 'already_attached', order: toView(order) }
      : { result: 'location_conflict' };
  }

  if (normalizePhone(order.customer_phone) !== input.customerPhoneDigits) {
    return { result: 'phone_mismatch' };
  }
  if (order.status !== 'awaiting_location') {
    return { result: 'invalid_status' };
  }

  // 6D.2C: delivery dinámico guarda el GPS pero NO confirma; el pedido sigue
  // `awaiting_location` hasta que la cotización lo confirme.
  const updated =
    order.delivery_pricing === 'dynamic'
      ? await store.attachIfPendingDynamic({
          orderId: order.id,
          contextId: input.contextId,
          latitude: input.latitude,
          longitude: input.longitude,
          address: input.address ?? null,
          name: input.name ?? null,
        })
      : // Legacy: GPS + confirmación en el mismo UPDATE atómico. Coalesce: si el
        // pedido ya tenía `confirmed_at` (lo fijó el Flow al pasar a
        // awaiting_location) se conserva; si era NULL (camino web) se sella
        // ahora. Nunca se sobrescribe.
        await store.attachIfPending({
          orderId: order.id,
          contextId: input.contextId,
          latitude: input.latitude,
          longitude: input.longitude,
          address: input.address ?? null,
          name: input.name ?? null,
          confirmedAt: order.confirmed_at ?? new Date().toISOString(),
        });

  if (updated) return { result: 'attached', order: toView(updated) };

  // Perdió la carrera: releer y no sobrescribir.
  const fresh = await store.findByLocationRequestMessageId(input.contextId);
  if (fresh && hasLocation(fresh)) {
    return coordsMatch(fresh, input)
      ? { result: 'already_attached', order: toView(fresh) }
      : { result: 'location_conflict' };
  }
  return { result: 'concurrent_update' };
}
