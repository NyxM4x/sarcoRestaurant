import type { OrderStatus, PaymentMethod } from '@/types';

/**
 * EL PEDIDO POR QR AL QUE NUNCA LLEGÓ EL COMPROBANTE — módulo PURO (09-09-2026).
 *
 * El cliente armó su pedido, mandó su ubicación, recibió su total y su QR… y no
 * pagó. Nunca llegó nada: ni comprobante bueno, ni malo, ni ilegible.
 *
 * ── El caso que lo trajo, y que abrió toda esta serie ───────────────────────
 *
 *   00:32  pedido #21 cotizado  →  "Total: Bs. 73" + el QR
 *          (el cliente no manda nada)
 *   12:17  escribe "Mande menu" →  "Tu pedido #21 está guardado por Bs. 73 🙌
 *                                   Falta que nos mandes la foto del
 *                                   comprobante"
 *
 * Doce horas después, a alguien que solo quería ver el menú. Y no era un caso
 * raro: `no_proof` era el único estado del pago sin reloj, así que ese pedido
 * seguía vivo hasta que su ventana de 24 h lo sacaba de la vista, tapándole el
 * menú al cliente todo ese tiempo.
 *
 * ── Por qué NO vive dentro de `paymentGateOf` ───────────────────────────────
 *
 * Porque la puerta del pago responde a otra pregunta: "¿se puede cocinar esto
 * AHORA?". Y su respuesta para este pedido —`no_proof`, no se cocina— es
 * correcta desde el primer minuto hasta el último. Lo que cambia con el tiempo
 * no es si se puede cocinar, sino si el pedido sigue existiendo.
 *
 * Meter el reloj ahí obligaba además a que cinco llamadores —el KDS, el intake,
 * el webhook, el barrido y el panel— pasaran una fecha nueva para una pregunta
 * que solo le importa a uno. Aquí es una regla suelta que solo consume el
 * barrido, y en cuanto la fila queda `cancelled` el resto del sistema se
 * comporta bien SOLO: deja de ser el pedido abierto del cliente, sale del
 * tablero, y un comprobante que llegue tarde cae en `closed_order`.
 *
 * Es la misma forma que `isAbandonedCart`, y por la misma razón.
 */

/**
 * Cuánto vive un pedido cotizado por QR al que no llega ningún comprobante.
 *
 * Más que el carrito sin cotizar (`UNQUOTED_CART_WINDOW_MS`, 45 minutos) y más
 * que el CONFIRMO en efectivo (`CASH_CONFIRM_TIMEOUT_MS`, 20): a este cliente
 * se le está pidiendo que vaya al banco, abra su app, transfiera y saque una
 * foto. Los otros dos solo tienen que tocar un botón o contestar una palabra.
 *
 * Dos horas es lo que el dueño consideró suficiente el 09-09-2026: da de sobra
 * para pagar y volver, y no llega a la mañana siguiente.
 */
export const UNPAID_ORDER_WINDOW_MS = 2 * 60 * 60 * 1000;

export interface UnpaidOrderInput {
  status: OrderStatus;
  paymentMethod: PaymentMethod | null;
  /** `confirmed_at`: el instante en que se le mandó el total y el QR. */
  confirmedAt: string | null;
  /**
   * ¿Llegó ALGO relacionado con el pago de este pedido?
   *
   * Cualquier fila cuenta: un intento en revisión, uno aceptado, uno rechazado,
   * o un comprobante que ni siquiera se pudo capturar. Todas significan lo
   * mismo —el cliente hizo algo— y esta regla solo se ocupa del que no hizo
   * nada. Los que sí mandaron algo los gobierna la puerta del pago y su ventana
   * de gracia tras un rechazo.
   */
  hasAnyPaymentRow: boolean;
  nowMs: number;
}

/**
 * ¿Este pedido murió por no haber pagado nunca?
 */
export function isUnpaidAbandonedOrder(input: UnpaidOrderInput): boolean {
  // Solo el pedido que espera cocina. `preparing` y `ready` quedan fuera: ahí la
  // comida ya está hecha y cancelar el pedido no la devuelve al refrigerador,
  // solo deja a quien cocina sin saber qué estaba haciendo. Es la misma regla
  // que gobierna la entrada al tablero: frenar antes de empezar sí, sacar algo
  // empezado no.
  if (input.status !== 'confirmed') return false;

  // Solo QR. El efectivo no espera ningún comprobante —la puerta del pago le
  // responde `not_required`, y debe seguir haciéndolo—: a ese pedido lo cierra
  // el barrido del CONFIRMO, con su propio plazo y su propio aviso.
  if (input.paymentMethod !== 'qr') return false;

  // Llegó algo: no es este caso. Lo que pase con un comprobante rechazado o en
  // revisión es asunto de `paymentGateOf` y su ventana de gracia.
  if (input.hasAnyPaymentRow) return false;

  // Sin `confirmed_at` no se le pidió pagar nada todavía, así que no hay plazo
  // que agotar — y un pedido `confirmed` sin esa fecha es además un dato roto
  // nuestro. En los dos casos, abstenerse.
  const cotizadoMs = input.confirmedAt === null ? NaN : Date.parse(input.confirmedAt);
  if (Number.isNaN(cotizadoMs)) return false;

  return input.nowMs >= cotizadoMs + UNPAID_ORDER_WINDOW_MS;
}
