/**
 * Cuándo se abrió un pedido — módulo PURO.
 *
 * Un solo hecho, y del PEDIDO: el instante desde el que se cuenta todo lo que
 * un pedido puede agotar. Vive aquí y no junto a ninguna de las reglas que lo
 * consumen porque son dos dominios distintos los que preguntan —el pago
 * (`payment-gate`) y el propio pedido (`abandoned-cart`)— y la primera versión
 * de esto vivió dentro del pago, que obligaba a `orders` a importar de
 * `payment-proof` para saber algo suyo.
 */

/**
 * El instante de apertura del pedido, en ms. `null` si no hay fecha legible.
 *
 * `confirmed_at` primero y `created_at` de respaldo. Esa preferencia es la
 * regla, no un detalle: el pedido web con delivery nace `awaiting_location` sin
 * total ni QR y solo sella `confirmed_at` cuando la cotización lo confirma
 * (migración 0009), que es el instante exacto en que el cliente supo cuánto
 * pagar. Contar desde `created_at` en ese caso le descontaría el rato que tardó
 * en mandar su ubicación.
 *
 * Es la MISMA semántica que ya usaban el intake (`ProofCandidateOrder.openedAt`)
 * y la antigüedad del KDS (`enteredAtOf`); tenerla escrita una sola vez es lo
 * que impide que dos de esos tres acaben discrepando.
 *
 * `null` no es un caso raro que se pueda ignorar: significa que ninguna regla
 * puede afirmar que este pedido venció. Ver `paymentGateOf` e `isAbandonedCart`,
 * que se abstienen las dos.
 */
export function openedAtMsOf(
  confirmedAt: string | null | undefined,
  createdAt: string | null | undefined,
): number | null {
  return parseIsoMs(confirmedAt) ?? parseIsoMs(createdAt);
}

/**
 * Una fecha ISO en ms, o `null` si no se puede leer.
 *
 * Existe suelta —y no solo dentro de `openedAtMsOf`— porque hay una regla que
 * necesita `confirmed_at` Y NADA MÁS, sin respaldo: la ventana del comprobante
 * (`PROOF_WINDOW_MS`). Ver `paymentGateOf`, que explica por qué caer a
 * `created_at` ahí le arrancaba el reloj a un cliente que todavía no sabía
 * cuánto tenía que pagar.
 */
export function parseIsoMs(iso: string | null | undefined): number | null {
  if (typeof iso !== 'string') return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}
