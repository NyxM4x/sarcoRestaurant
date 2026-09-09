import type { DeliveryQuoteStatus, OrderStatus } from '@/types';
import { openedAtMsOf } from './opened-at';

/**
 * EL CARRITO QUE NUNCA LLEGÓ A COTIZARSE — módulo PURO (09-09-2026).
 *
 * Un pedido que se queda esperando la ubicación del cliente y no la recibe
 * nunca. No entra al tablero de cocina —`stageFromOrderStatus` solo admite
 * `confirmed`, `preparing` y `ready`—, así que nadie lo ve; y mientras tanto es
 * el "pedido abierto" de ese cliente, lo que le tapa el menú durante 24 h.
 *
 * ── Por qué es una regla del PEDIDO y no del pago ───────────────────────────
 *
 * La primera versión de esta idea vivió dentro de la puerta del pago, que era
 * donde había un reloj a mano. El efecto fue una incoherencia: un carrito
 * abandonado por QR vencía —el gate lo leía como `no_proof` sin comprobante— y
 * uno idéntico en efectivo no, porque para el efectivo el gate responde
 * `not_required` y debe seguir haciéndolo. El mismo pedido abandonado, dos
 * desenlaces, según cómo pensaba pagarlo alguien que no llegó a pagar nada.
 *
 * "Nunca llegó a cotizarse" no es un hecho sobre el pago: es un hecho sobre el
 * pedido. Por eso esta regla no mira `payment_method` en ninguna parte.
 *
 * ── Los números que la trajeron ─────────────────────────────────────────────
 *
 * Consulta a producción del 09-09-2026, pedidos en `awaiting_location`:
 *
 *     pending          / qr     14   (03-09 → 09-09)
 *     out_of_coverage  / cash    2   (06-09 → 09-09)
 *     pending          / cash    1   (07-09)
 *
 * Diecisiete carritos colgados en seis días, unos tres por día, y ninguno de
 * ellos visible para nadie.
 */

/**
 * Cuánto vive un carrito que nunca se cotizó.
 *
 * Menos que la ventana del comprobante (`PROOF_WINDOW_MS`, dos horas) y a
 * propósito: mandar la ubicación es tocar un botón del teléfono, no ir al
 * banco. Quien va a hacerlo lo hace en minutos, así que a los cuarenta y cinco
 * el pedido ya no está esperando a nadie — y cuanto antes muera, antes vuelve
 * ese cliente a recibir el menú para pedir de nuevo.
 */
export const UNQUOTED_CART_WINDOW_MS = 45 * 60 * 1000;

export interface AbandonedCartInput {
  status: OrderStatus;
  /** Cotización del envío. Ver `DELIVERY_QUOTE_STATUSES`. */
  deliveryQuoteStatus: DeliveryQuoteStatus | null;
  /** `confirmed_at` del pedido, en ISO. */
  confirmedAt: string | null;
  /** `created_at` del pedido, en ISO. */
  createdAt: string | null;
  nowMs: number;
}

/**
 * ¿Este pedido es un carrito abandonado que ya venció?
 *
 * NO mira el método de pago: ver la cabecera.
 */
export function isAbandonedCart(input: AbandonedCartInput): boolean {
  // Solo el pedido que sigue esperando su ubicación. Uno ya cotizado tiene su
  // total, su QR y su sitio en el tablero: lo que le pase a partir de ahí es
  // asunto del pago, no de esta regla.
  if (input.status !== 'awaiting_location') return false;

  // ── El fallo técnico NO mata el pedido ────────────────────────────────────
  //
  // `failed` es Mapbox caído: el cliente mandó su ubicación e hizo todo bien, y
  // lo que falló fue nuestro. Cancelarle el pedido por eso sería cobrarle a él
  // nuestra avería. Ese caso necesita un aviso, no una cancelación.
  //
  // Se comprobó además que hoy no ocurre: la consulta del 09-09-2026 devolvió
  // CERO pedidos en `failed`. Se deja fuera explícitamente y no se construye
  // nada para él mientras siga siendo así.
  if (input.deliveryQuoteStatus === 'failed') return false;

  // Ya cotizado: no es un carrito abandonado, aunque su `status` se haya
  // quedado atrás. No se cancela lo que sí llegó a tener precio.
  if (input.deliveryQuoteStatus === 'quoted') return false;

  // `pending` (nunca mandó la ubicación), `out_of_coverage` (está fuera de los
  // 18 km y ya se le dijo, así que ese pedido no se va a servir nunca) y `null`
  // (pedidos legacy sin pricing dinámico) sí vencen.
  const abiertoMs = openedAtMsOf(input.confirmedAt, input.createdAt);
  // Sin fecha legible no se inventa un vencimiento, igual que en la puerta del
  // pago: matar un pedido por un dato roto nuestro sería peor que dejarlo vivo.
  if (abiertoMs === null) return false;

  return input.nowMs >= abiertoMs + UNQUOTED_CART_WINDOW_MS;
}
