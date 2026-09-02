import type { CartState, CartSummary } from './cart';
import { evaluatePromotion, isPurchasable, type Promotion } from '@/lib/promotions/promotion';

/**
 * Las promociones dentro del carrito — módulo PURO.
 *
 * ── Por qué viven en su propio estado ───────────────────────────────────────
 *
 * El carrito de productos es `{ code: cantidad }` y ya está guardado así en el
 * navegador de cada cliente que pasó por aquí. Meter los combos dentro
 * obligaría a versionar ese formato y a que `parseStoredCart` distinguiera dos
 * clases de clave — con el riesgo de que un carrito viejo se leyera mal.
 *
 * Se guardan aparte, con la misma forma `{ id: cantidad }`, así que reutilizan
 * TODAS las operaciones puras de `./cart`: sumar, restar, quitar, parsear. Lo
 * único propio es cómo se convierten en dinero, que es este archivo.
 *
 * ── Y por qué la presentación sí se unifica ─────────────────────────────────
 *
 * Al cliente le da igual dónde guardamos las cosas: si tiene un combo de Bs 60,
 * el botón del carrito tiene que decir "1 producto · Bs 60". Dos estados
 * separados que se pintan por separado producen el fallo clásico —"0 productos,
 * Bs 0,00" con el combo dentro—, así que todo lo que se muestra pasa por
 * `unifiedTotals`.
 */

/** Una promoción del carrito, ya cruzada con su estado real. */
export interface PromoLine {
  promotionId: string;
  name: string;
  /** Cuántas veces se pidió el combo. */
  quantity: number;
  /** Precio del combo, por unidad. */
  unitPrice: number;
  /** Lo que costaría suelto, por unidad. */
  normalPrice: number;
  subtotal: number;
  /** Revisión vista al añadirlo: viaja al checkout como testigo. */
  revision: number;
  promotion: Promotion;
}

export interface PromoCartSummary {
  lines: PromoLine[];
  subtotal: number;
  /** UNA unidad por combo, no sus componentes. */
  units: number;
  /**
   * Combos que estaban en el carrito y ya no se pueden comprar.
   *
   * No se borran solos: se informan. Un carrito que se vacía sin explicación
   * mientras el cliente mira es peor que uno que dice "esto ya no está" — el
   * cliente cree que perdió lo que había elegido y empieza de cero.
   */
  unavailableIds: string[];
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Cruza el carrito de combos con las promociones reales.
 *
 * Solo entran las VENDIBLES en este instante. Una promoción vencida entre que
 * se añadió y se abrió el carrito no suma al total ni viaja al checkout: el
 * servidor la rechazaría igual, y cobrarla en pantalla para que la rechacen
 * después es la peor de las dos opciones.
 */
export function summarizePromoCart(
  state: CartState,
  promotions: Promotion[],
  now: number,
): PromoCartSummary {
  const porId = new Map(promotions.map((p) => [p.id, p]));
  const lines: PromoLine[] = [];
  const unavailableIds: string[] = [];

  for (const [promotionId, quantity] of Object.entries(state)) {
    if (!Number.isInteger(quantity) || quantity < 1) continue;

    const promocion = porId.get(promotionId);
    if (promocion === undefined) {
      unavailableIds.push(promotionId);
      continue;
    }

    const precio = evaluatePromotion(promocion, now);
    if (!isPurchasable(precio)) {
      unavailableIds.push(promotionId);
      continue;
    }

    lines.push({
      promotionId,
      name: promocion.name,
      quantity,
      unitPrice: precio.promoPrice,
      normalPrice: precio.normalPrice,
      subtotal: round2(precio.promoPrice * quantity),
      revision: promocion.revision,
      promotion: promocion,
    });
  }

  // Orden estable por nombre: el carrito no puede reordenarse solo entre
  // renders, o el cliente pulsa "−" sobre la línea equivocada.
  lines.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  return {
    lines,
    subtotal: round2(lines.reduce((sum, l) => sum + l.subtotal, 0)),
    // UNA unidad por combo pedido. Un combo de seis componentes es un artículo,
    // no seis: "6 productos" por pedir una promo sería una mentira que además
    // asusta al ver el total.
    units: lines.reduce((sum, l) => sum + l.quantity, 0),
    unavailableIds,
  };
}

export interface UnifiedTotals {
  /** Artículos visibles: productos sueltos + combos. */
  units: number;
  subtotal: number;
  total: number;
  isEmpty: boolean;
}

/**
 * Lo que se PINTA en el botón del carrito, la cabecera y el resumen.
 *
 * Una sola derivación para las dos listas. Cualquier pantalla que sume por su
 * cuenta acabará contando de otra forma el día que algo cambie.
 */
export function unifiedTotals(cart: CartSummary, promos: PromoCartSummary): UnifiedTotals {
  const units = cart.units + promos.units;
  const subtotal = round2(cart.subtotal + promos.subtotal);
  return {
    units,
    subtotal,
    // El envío se cotiza después de armar el pedido, igual que con los
    // productos sueltos: aquí total y subtotal coinciden.
    total: subtotal,
    isEmpty: units === 0,
  };
}
