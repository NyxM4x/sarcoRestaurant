/**
 * El reparto de lo que se cobra en la puerta — modulo PURO.
 *
 * Al cerrar la noche, Zarco y quien reparte no cuadran una cifra: cuadran DOS.
 * Los productos entran al negocio y el envio se reparte, asi que "COBRAR TODO
 * BS 87" obliga a abrir el pedido para saber cuanto de eso era la moto. Esta
 * funcion es la que separa las dos mitades.
 *
 * ── Por que devuelve numeros y no la frase ──────────────────────────────────
 *
 * Vivia dentro de `KitchenReadyPanel` como una funcion local que ya devolvia el
 * texto pintado, y por eso no podia comprobarse: la unica forma de saber si el
 * envio salia bien era mirar la pantalla con un pedido real delante. Las cifras
 * con las que se cuadra la caja no pueden depender de eso.
 *
 * La pantalla sigue decidiendo como se lee; aqui solo se decide cuanto es.
 *
 * ── De donde salen las dos cifras ───────────────────────────────────────────
 *
 * De las que ya viajan al ticket, sin pedir ninguna nueva. `amountDueByQrOf` es
 * la comida —en delivery, el subtotal— y el chip de la puerta trae la otra
 * mitad, que segun como se pague es una cosa u otra:
 *
 *   efectivo (`todo`)   el chip lleva el TOTAL   →  envio = total − comida
 *   por QR   (`envio`)  el chip lleva el ENVIO   →  se usa tal cual
 *   por QR   (`pagado`) no hay cifra de envio    →  ya se cobro por adelantado
 *
 * Que el envio se RESTE en efectivo es lo que garantiza que las dos cifras
 * sumen exactamente lo que se cobra en la puerta: no hay una tercera cifra
 * guardada aparte que pueda discrepar de las otras dos.
 */
import type { DeliveryCollect } from './ticket-view';

export interface CollectBreakdown {
  /** Lo que entra al negocio. */
  food: number;
  /**
   * Lo que se reparte. `'paid'` cuando el envio ya se cobro por adelantado y
   * por tanto no hay nada que entregar en la puerta.
   */
  shipping: number | 'paid';
}

/**
 * Las dos mitades de lo que se cobra, o `null` si no hay nada que repartir.
 *
 * `null` en tres casos, y ninguno es un fallo:
 *
 *   sin chip        en recojo no hay puerta ni envio (`deliveryCollectOf`
 *                   devuelve `null`), asi que no hay dos mitades que separar;
 *   sin comida      la resta no diria nada sobre un pedido sin importes;
 *   resta negativa  las cifras no cuadran entre si. Se calla en vez de escribir
 *                   un envio imposible: una cuenta que se sabe rota no puede
 *                   pasar por una cuenta buena delante de quien reparte.
 */
export function collectBreakdownOf(
  collect: DeliveryCollect | null,
  food: number,
): CollectBreakdown | null {
  if (collect === null) return null;
  if (food <= 0) return null;

  if (collect.kind === 'pagado') return { food, shipping: 'paid' };

  const shipping = collect.kind === 'todo' ? collect.amount - food : collect.amount;
  if (shipping < 0) return null;

  return { food, shipping };
}
