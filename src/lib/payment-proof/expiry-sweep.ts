/**
 * El barrido de pedidos vencidos — módulo PURO.
 *
 * Decide QUÉ pedidos han agotado su ventana de gracia y deben cancelarse. No
 * escribe nada: quien lo hace es la Server Action del panel, y el barrido solo
 * responde a la pregunta.
 *
 * ── Por qué no hay cron ─────────────────────────────────────────────────────
 *
 * La expiración se DERIVA al leer: la puerta del KDS, el enrutado del intake y
 * este barrido aplican la misma regla sobre los mismos datos, así que nadie ve
 * un pedido vivo que ya venció aunque su `orders.status` todavía diga
 * `confirmed`.
 *
 * Materializar la cancelación es un acto aparte, y hay exactamente dos caminos
 * —ninguno de ellos un proceso que despierte solo a las tres de la mañana—:
 *
 *   1. Este barrido, cuando el encargado pulsa "Limpiar expirados".
 *   2. El webhook, cuando el cliente vuelve a escribir y el sistema ya tiene su
 *      pedido delante (`cancel-expired-service.ts`). Ese es el que cierra la
 *      mayoría, porque el cliente que abandonó un pago casi siempre vuelve.
 *
 * Los dos usan la misma regla; lo único que cambia es quién llega primero.
 *
 * ── Las TRES formas de vencer ───────────────────────────────────────────────
 *
 * Dos son del PAGO y las responde `shouldCancelForExpiry`: un rechazo cuya
 * gracia se agotó (`REJECTION_GRACE_MS`, quince minutos) y un comprobante que
 * nunca llegó (`PROOF_WINDOW_MS`, dos horas desde que se cotizó).
 *
 * La tercera es del PEDIDO y la responde `isAbandonedCart`: el carrito que
 * nunca llegó a cotizarse (`UNQUOTED_CART_WINDOW_MS`, 45 minutos). Existe
 * aparte porque las del pago no pueden alcanzar al pedido en efectivo —a ese la
 * puerta le responde `not_required`— y ese carrito también hay que cerrarlo.
 *
 * Por eso este barrido ya NO filtra por `payment_method = 'qr'`: dejaba fuera
 * justo los pedidos que solo la tercera regla puede cerrar.
 *
 * ── Y por qué NO toca lo que ya está en la plancha ──────────────────────────
 *
 * Solo se cancela lo que no ha entrado en cocina. Si alguien pulsó INICIAR
 * —cosa que hoy exige el pago aceptado, salvo con la base caída— la comida ya
 * está hecha, y cancelar el pedido no la devuelve al refrigerador: solo deja a
 * quien cocina sin saber qué estaba haciendo y sin poder cerrar el ticket.
 *
 * Es la misma regla que ya gobierna la entrada al tablero: frenar antes de
 * empezar sí, sacar algo empezado no.
 */
import type { DeliveryQuoteStatus, OrderStatus, PaymentMethod } from '@/types';
import type { PaymentView } from '@/lib/dashboard/attempt-review';
import { shouldCancelForExpiry } from './payment-gate';
import { isAbandonedCart } from '@/lib/orders/abandoned-cart';
import { parseIsoMs } from '@/lib/orders/opened-at';

/**
 * Estados que el barrido puede cancelar.
 *
 * `confirmed` es el pedido esperando cocina; `awaiting_location` no llegó ni a
 * cotizarse —y desde el 09-09-2026 también vence, contando desde que se creó,
 * porque un carrito abandonado sin ubicación le tapa el menú al cliente igual
 * que uno sin comprobante—. `preparing` y `ready` quedan fuera a propósito —ver
 * la cabecera— y `on_the_way`, `delivered` y `cancelled` ni se plantean.
 */
export const SWEEPABLE_STATUSES: readonly OrderStatus[] = ['confirmed', 'awaiting_location'];

/** Un pedido candidato, con lo justo para decidir. */
export interface ExpiryCandidate {
  orderId: string;
  orderNumber: string;
  status: OrderStatus;
  paymentMethod: PaymentMethod | null;
  /** Su pago. `null` = no se pudo leer, y entonces NO se cancela. */
  payment: PaymentView | null;
  /**
   * Cuándo se abrió el pedido (`confirmed_at ?? created_at`), en ISO.
   *
   * Es el reloj de la ventana del comprobante (`PROOF_WINDOW_MS`), y una fecha
   * ausente o ilegible se comporta como un pago que no se pudo consultar: no
   * cancela. Ver `paymentGateOf`.
   */
  openedAt: string | null;
  /**
   * `created_at` del pedido, en ISO.
   *
   * Viaja aparte de `openedAt` porque la regla del carrito abandonado necesita
   * las dos fechas para elegir cuál cuenta (`openedAtMsOf`), no el resultado ya
   * resuelto.
   */
  createdAt: string | null;
  /**
   * Cotización del envío. La mira `isAbandonedCart` para distinguir al que
   * nunca mandó su ubicación del que sí y falló Mapbox.
   */
  deliveryQuoteStatus: DeliveryQuoteStatus | null;
}

/**
 * Los pedidos que deben cancelarse ahora mismo.
 *
 * Un pago que no se pudo consultar NUNCA cancela: `shouldCancelForExpiry`
 * devuelve `false` ante `unknown`. Abrir la puerta ante la duda y cancelar ante
 * la duda son cosas opuestas, y solo la primera es segura.
 */
export function selectExpiredOrders(
  candidates: readonly ExpiryCandidate[],
  nowMs: number,
): ExpiryCandidate[] {
  return candidates.filter(
    (c) => SWEEPABLE_STATUSES.includes(c.status) && debeCancelarse(c, nowMs),
  );
}

/**
 * Las DOS razones por las que un pedido puede estar muerto.
 *
 * Son independientes y cualquiera basta. No se solapan por accidente: la del
 * carrito solo mira `awaiting_location` —donde todavía no hay ni total ni QR—
 * y la del pago gobierna todo lo que ya se cotizó. Un pedido por QR sin
 * ubicación las cumple las dos, y ahí manda la que llegue antes, que es la del
 * carrito (45 minutos contra 2 horas).
 */
function debeCancelarse(c: ExpiryCandidate, nowMs: number): boolean {
  // El carrito que nunca llegó a cotizarse. NO mira el método de pago: por eso
  // alcanza al pedido en efectivo, que la puerta del pago nunca puede vencer.
  if (
    isAbandonedCart({
      status: c.status,
      deliveryQuoteStatus: c.deliveryQuoteStatus,
      confirmedAt: c.openedAt,
      createdAt: c.createdAt,
      nowMs,
    })
  ) {
    return true;
  }

  // El pago vencido: rechazo sin reenvío, o comprobante que nunca llegó.
  // `openedAt` es `confirmed_at` a secas: sin cotizar no hay plazo de pago.
  return shouldCancelForExpiry(c.paymentMethod, c.payment, nowMs, parseIsoMs(c.openedAt));
}
