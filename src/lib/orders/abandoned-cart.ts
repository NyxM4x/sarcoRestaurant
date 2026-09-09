import type { DeliveryQuoteStatus, OrderStatus } from '@/types';

/**
 * EL CARRITO QUE NUNCA LLEGÓ A COTIZARSE — módulo PURO (09-09-2026).
 *
 * Un pedido que se queda esperando la ubicación del cliente y no la recibe
 * nunca. No tiene total, ni QR, ni nada que cobrar: solo un número.
 *
 * ── El caso que lo trajo ────────────────────────────────────────────────────
 *
 * Probando el flujo el 09-09-2026:
 *
 *   12:19  el cliente rearma su pedido  →  #1 creado, se le pide la ubicación
 *          (no la manda)
 *   18:20  escribe "Hola Zarco menu"    →  "Tu pedido #1 está guardado 🙌 Para
 *                                           seguir nos falta tu ubicación"
 *
 * Seis horas después, un carrito que el cliente ya había abandonado le seguía
 * tapando el menú. El mensaje en sí es correcto —lo puso `ec72acc`, y a los
 * cinco minutos es justo lo que ese cliente necesita— pero a las seis horas ya
 * no le habla a nadie: quien escribe "menu" seis horas después quiere pedir de
 * nuevo, no retomar lo de la tarde.
 *
 * ── Por qué es una regla del PEDIDO y no del pago ───────────────────────────
 *
 * Porque el pedido sin cotizar no espera ningún pago. La puerta del pago le
 * responde `not_required` al de efectivo y `no_proof` al de QR, y ninguna de las
 * dos cosas puede vencer: exigirle el comprobante de un importe que todavía no
 * se le ha dicho es una regla imposible de cumplir.
 *
 * "Nunca llegó a cotizarse" es un hecho sobre el PEDIDO. Por eso esta regla no
 * mira `payment_method` en ninguna parte, y por eso alcanza por igual al carrito
 * de efectivo y al de QR.
 *
 * ── Los números de producción (09-09-2026) ──────────────────────────────────
 *
 *     pending          / qr     14   (03-09 → 09-09)
 *     out_of_coverage  / cash    2   (06-09 → 09-09)
 *     pending          / cash    1   (07-09)
 *
 * Diecisiete carritos colgados en seis días —unos tres por noche— y ninguno
 * visible para nadie: `awaiting_location` no entra al tablero de cocina.
 */

/**
 * Cuánto vive un carrito que nunca se cotizó.
 *
 * Menos que la ventana del comprobante y menos que la del CONFIRMO en efectivo
 * (`CASH_CONFIRM_TIMEOUT_MS`, veinte minutos), pero no tan poco: mandar la
 * ubicación es tocar un botón del teléfono, no ir al banco ni decidir si un
 * precio te parece caro. Quien va a hacerlo lo hace en minutos.
 *
 * Cuarenta y cinco deja margen al que arma su pedido, se distrae con algo y
 * vuelve — y aun así libera al cliente la misma noche, que es lo que importa:
 * cuanto antes muera el carrito, antes vuelve a recibir el menú para pedir.
 */
export const UNQUOTED_CART_WINDOW_MS = 45 * 60 * 1000;

export interface AbandonedCartInput {
  status: OrderStatus;
  /** Cotización del envío. Ver `DELIVERY_QUOTE_STATUSES`. */
  deliveryQuoteStatus: DeliveryQuoteStatus | null;
  /** `created_at` del pedido, en ISO. Es el único reloj que este pedido tiene. */
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
  // asunto del pago o del CONFIRMO, no de esta regla.
  if (input.status !== 'awaiting_location') return false;

  // ── El fallo técnico NO mata el pedido ────────────────────────────────────
  //
  // `failed` es Mapbox caído: el cliente mandó su ubicación e hizo todo bien, y
  // lo que falló fue nuestro. Cancelárselo por eso sería cobrarle a él nuestra
  // avería, y encima en silencio. Ese caso necesita un aviso, no una
  // cancelación.
  //
  // Se comprobó además que hoy no ocurre: la consulta del 09-09-2026 devolvió
  // CERO pedidos en `failed`. Queda fuera explícitamente, y mientras siga
  // saliendo cero no se construye nada para él.
  if (input.deliveryQuoteStatus === 'failed') return false;

  // Ya cotizado: no es un carrito abandonado, aunque su `status` se haya
  // quedado atrás. No se cancela lo que sí llegó a tener precio.
  if (input.deliveryQuoteStatus === 'quoted') return false;

  // Vencen `pending` (nunca mandó la ubicación), `out_of_coverage` (está fuera
  // de los 18 km, ya se le dijo, y ese pedido no se va a servir nunca) y `null`
  // (pedidos legacy sin pricing dinámico).
  const creadoMs = input.createdAt === null ? NaN : Date.parse(input.createdAt);
  // Sin fecha legible no se inventa un vencimiento: matar un pedido por un dato
  // roto nuestro sería peor que dejarlo vivo.
  if (Number.isNaN(creadoMs)) return false;

  return input.nowMs >= creadoMs + UNQUOTED_CART_WINDOW_MS;
}
