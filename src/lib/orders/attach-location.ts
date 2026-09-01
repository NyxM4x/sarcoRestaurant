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
   * 0028 — el pedido de ESTE teléfono que sigue esperando ubicación, si lo hay.
   *
   * Busca por teléfono porque el pin que llega por aquí no trae `context.id`:
   * no responde a nuestro botón, así que no hay wamid con el que correlacionar.
   * El teléfono llega ya normalizado a dígitos; la implementación es la que
   * sabe cómo está guardado el suyo.
   *
   * Devuelve el MÁS RECIENTE dentro de una ventana corta y solo si sigue sin
   * GPS. Opcional: sin este método el pin sin contexto se comporta como antes.
   */
  findAwaitingLocationByPhone?(customerPhoneDigits: string): Promise<LocationOrderRow | null>;
  /**
   * Atómico: UPDATE … SET …, status='confirmed', confirmed_at=? WHERE id=? AND
   * status='awaiting_location' AND delivery_latitude IS NULL AND
   * delivery_longitude IS NULL. Devuelve la fila actualizada o `null` si la
   * condición ya no se cumplía (perdió la carrera).
   *
   * `contextId` es un guard ADICIONAL, para el pin que sí respondía a nuestra
   * petición (`location_request_message_id=?`). Con `null` —un pin suelto— el
   * claim se sostiene sobre `status` + coordenadas NULL, que es lo que impide
   * la doble escritura.
   *
   * `confirmedAt` viene ya resuelto por el llamador con semántica coalesce
   * (conserva el `confirmed_at` previo si existía; usa "ahora" solo si era NULL).
   */
  attachIfPending(input: {
    orderId: string;
    contextId: string | null;
    latitude: number;
    longitude: number;
    address: string | null;
    name: string | null;
    confirmedAt: string;
  }): Promise<LocationOrderRow | null>;
  /**
   * 6D.2C — variante DINÁMICA: guarda el GPS SIN tocar `status` ni
   * `confirmed_at`. Atómico: UPDATE … SET delivery_latitude/longitude/address/
   * name WHERE id=? AND status='awaiting_location' AND delivery_latitude IS NULL
   * AND delivery_longitude IS NULL (más `location_request_message_id=?` cuando
   * hay contexto). Devuelve la fila actualizada (que sigue en
   * `awaiting_location`) o `null` si perdió la carrera. NO confirma: la
   * cotización lo hará después vía `apply_delivery_quote`.
   */
  attachIfPendingDynamic(input: {
    orderId: string;
    contextId: string | null;
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

/** Las coordenadas del pin, sin el cómo se encontró el pedido. */
interface PinCoords {
  latitude: number;
  longitude: number;
  address?: string | null;
  name?: string | null;
}

function toView(row: LocationOrderRow): AttachedOrderView {
  return { id: row.id, order_number: row.order_number, status: row.status };
}

function hasLocation(row: LocationOrderRow): boolean {
  return row.delivery_latitude !== null && row.delivery_longitude !== null;
}

function coordsMatch(row: LocationOrderRow, pin: PinCoords): boolean {
  return row.delivery_latitude === pin.latitude && row.delivery_longitude === pin.longitude;
}

/**
 * Escribe el GPS en un pedido ya elegido y traduce el desenlace.
 *
 * Es el tramo que comparten los dos caminos —el pin que responde a nuestro
 * botón y el que no—, y está separado justo por eso: entre ellos lo único que
 * cambia es CÓMO se encontró el pedido, no qué se hace con él. Tenerlo dos
 * veces sería la forma más fácil de que un cliente acabara atendido distinto
 * según el botón que tocó.
 *
 * `reread` es la relectura ante una carrera perdida: cada camino relee por
 * donde buscó.
 */
async function attachToOrder(
  store: AttachLocationStore,
  order: LocationOrderRow,
  pin: PinCoords,
  contextId: string | null,
  reread: () => Promise<LocationOrderRow | null>,
): Promise<AttachLocationResult> {
  // 6D.2C: delivery dinámico guarda el GPS pero NO confirma; el pedido sigue
  // `awaiting_location` hasta que la cotización lo confirme.
  const updated =
    order.delivery_pricing === 'dynamic'
      ? await store.attachIfPendingDynamic({
          orderId: order.id,
          contextId,
          latitude: pin.latitude,
          longitude: pin.longitude,
          address: pin.address ?? null,
          name: pin.name ?? null,
        })
      : // Legacy: GPS + confirmación en el mismo UPDATE atómico. Coalesce: si el
        // pedido ya tenía `confirmed_at` (lo fijó el Flow al pasar a
        // awaiting_location) se conserva; si era NULL (camino web) se sella
        // ahora. Nunca se sobrescribe.
        await store.attachIfPending({
          orderId: order.id,
          contextId,
          latitude: pin.latitude,
          longitude: pin.longitude,
          address: pin.address ?? null,
          name: pin.name ?? null,
          confirmedAt: order.confirmed_at ?? new Date().toISOString(),
        });

  if (updated) return { result: 'attached', order: toView(updated) };

  // Perdió la carrera: releer y no sobrescribir.
  const fresh = await reread();
  if (fresh && hasLocation(fresh)) {
    return coordsMatch(fresh, pin)
      ? { result: 'already_attached', order: toView(fresh) }
      : { result: 'location_conflict' };
  }
  return { result: 'concurrent_update' };
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

  return attachToOrder(store, order, input, input.contextId, () =>
    store.findByLocationRequestMessageId(input.contextId),
  );
}

// ── El pin que no responde al botón (0028) ──────────────────────────────────

/**
 * El cliente armó su pedido, le pedimos la ubicación con el botón… y la mandó
 * con el clip de WhatsApp de toda la vida.
 *
 * Para nosotros son dos mensajes distintos —uno trae `context.id` y el otro
 * no—, pero para quien lo manda es el mismo gesto: acabo de pedir, aquí vivo.
 * Sin esto, ese pin se leía como "¿cuánto sale el envío?": el cliente recibía
 * una tarifa suelta y un "armá tu pedido en el menú" que ya había hecho, y su
 * pedido se quedaba en `awaiting_location` para siempre — sin total, sin QR y
 * sin nadie esperándolo.
 *
 * Lo que NO cambia: el pin de quien no tiene pedido pendiente se sigue
 * cotizando como antes. Aquí solo se recupera el caso en el que hay un pedido
 * esperando exactamente este dato.
 */
export interface AttachLooseLocationInput {
  /** Teléfono del webhook ya normalizado a solo dígitos. */
  customerPhoneDigits: string;
  latitude: number;
  longitude: number;
  address?: string | null;
  name?: string | null;
}

export async function attachLooseLocation(
  store: AttachLocationStore,
  input: AttachLooseLocationInput,
): Promise<AttachLocationResult> {
  // Sin búsqueda por teléfono no hay nada que intentar: el llamador seguirá por
  // donde iba, cotizando el pin como suelto.
  if (!store.findAwaitingLocationByPhone) return { result: 'not_found' };
  if (!input.customerPhoneDigits) return { result: 'not_found' };

  const order = await store.findAwaitingLocationByPhone(input.customerPhoneDigits);
  if (!order) return { result: 'not_found' };

  // Estas tres comprobaciones se repiten aunque la consulta ya filtre por
  // ellas: lo que protege a un pedido de una escritura equivocada no debería
  // depender de una cláusula SQL que vive en otro archivo.
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

  // `contextId: null` — este pin no responde a ninguna petición nuestra, así
  // que no hay wamid que exigir en el UPDATE. El claim lo sostienen el estado y
  // las coordenadas NULL, que es lo que impide la doble escritura.
  return attachToOrder(store, order, input, null, () =>
    store.findAwaitingLocationByPhone!(input.customerPhoneDigits),
  );
}
