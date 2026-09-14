/**
 * EL PEDIDO EN EFECTIVO QUE NADIE CONFIRMÓ, AL VENCER — módulo PURO (14-09-2026).
 *
 * Lo consume `expireUnconfirmedCashOrders`. Vive aparte para poder probar sin
 * base las dos cosas que ese barrido hizo mal durante días sin que nada lo
 * delatara.
 *
 * ── La columna que no existía ───────────────────────────────────────────────
 *
 * El barrido pedía `phone_number_id` a `orders`, y `orders` no tiene esa
 * columna. La consulta fallaba en cada latido, el barrido devolvía "0
 * cancelados" y seguía como si nada: el 14-09-2026 había 24 pedidos en efectivo
 * sin CONFIRMO todavía vivos, el más antiguo del 09-09. La lista de columnas
 * está aquí para que un test la contraste con las migraciones.
 *
 * ── El aviso que llegaría días tarde ────────────────────────────────────────
 *
 * Arreglar la consulta no basta: el primer latido encontraría esos 24 pedidos y
 * les escribiría "tu pedido se canceló" a clientes que pidieron hace días. Así
 * que el aviso solo sale si el pedido venció hace poco; el viejo se cancela en
 * silencio, que es lo único que todavía tiene sentido hacer con él.
 */

/** Columnas que lee el barrido. Todas tienen que existir en `orders`. */
export const CASH_EXPIRY_ORDER_COLUMNS = 'id, order_number, customer_phone, confirmed_at, created_at';

/**
 * Hasta cuándo se le avisa al cliente, contado desde que se le mandó el total.
 *
 * Una hora: con el barrido corriendo cada minuto, un pedido normal vence a los
 * veinte y se avisa enseguida. Pasada la hora ya no es una respuesta a lo que
 * preguntó, es un mensaje que no espera nadie.
 */
export const CASH_EXPIRY_NOTICE_WINDOW_MS = 60 * 60 * 1000;

/** ¿Se le escribe al cliente al cancelar? Sin fecha legible, no. */
export function shouldNotifyCashExpiry(referenceMs: number, nowMs: number): boolean {
  if (!Number.isFinite(referenceMs)) return false;
  return nowMs - referenceMs <= CASH_EXPIRY_NOTICE_WINDOW_MS;
}
