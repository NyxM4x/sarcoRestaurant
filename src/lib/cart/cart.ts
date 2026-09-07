/**
 * Carrito local — lógica PURA (sin React, sin `localStorage`, sin Supabase).
 *
 * El estado es un mapa `code → cantidad`. Los precios NUNCA viven aquí: los
 * totales se calculan con `calculateOrder`, sobre los `menu_items` reales que
 * llegaron de Supabase. Este carrito es solo una preferencia del cliente; el
 * backend vuelve a calcular todo cuando se cree el pedido (fase siguiente).
 */
import type { MenuItem } from '@/types';
import type { CalculatedLine } from '@/lib/orders/types';
import {
  MAX_QUANTITY_PER_ITEM,
  calculateOrder,
  round2,
} from '@/lib/orders/calculate';

/** Clave de `localStorage`. Versionada por si el formato cambia. */
export const CART_STORAGE_KEY = 'la-fija:cart:v1';

/** Cantidades por `code` de producto. Solo contiene entradas con cantidad > 0. */
export type CartState = Readonly<Record<string, number>>;

export const EMPTY_CART: CartState = Object.freeze({});

/** Recorta una cantidad al rango permitido [0, MAX_QUANTITY_PER_ITEM]. */
function clampQuantity(quantity: number): number {
  if (!Number.isFinite(quantity)) return 0;
  const int = Math.trunc(quantity);
  if (int <= 0) return 0;
  return Math.min(int, MAX_QUANTITY_PER_ITEM);
}

/**
 * Fija la cantidad de un producto. Cantidad 0 (o menos) elimina la entrada;
 * por encima del máximo se recorta a `MAX_QUANTITY_PER_ITEM`.
 */
export function setQuantity(cart: CartState, code: string, quantity: number): CartState {
  const next = clampQuantity(quantity);
  const { [code]: _removed, ...rest } = cart;
  void _removed;
  return next === 0 ? rest : { ...rest, [code]: next };
}

/** Cantidad actual de un producto (0 si no está en el carrito). */
export function quantityOf(cart: CartState, code: string): number {
  return cart[code] ?? 0;
}

/** Agrega una unidad (o inicializa en 1). Tope: `MAX_QUANTITY_PER_ITEM`. */
export function increment(cart: CartState, code: string): CartState {
  return setQuantity(cart, code, quantityOf(cart, code) + 1);
}

/** Quita una unidad. Al llegar a 0 el producto sale del carrito. */
export function decrement(cart: CartState, code: string): CartState {
  return setQuantity(cart, code, quantityOf(cart, code) - 1);
}

/** Elimina un producto sin importar su cantidad. */
export function removeItem(cart: CartState, code: string): CartState {
  return setQuantity(cart, code, 0);
}

/** Vacía el carrito. */
export function clearCart(): CartState {
  return EMPTY_CART;
}

/** Unidades totales — el número del indicador del botón de carrito. */
export function totalUnits(cart: CartState): number {
  return Object.values(cart).reduce((acc, quantity) => acc + quantity, 0);
}

/** `true` si no hay ningún producto seleccionado. */
export function isEmpty(cart: CartState): boolean {
  return totalUnits(cart) === 0;
}

/** Resumen del carrito con precios reales. */
export interface CartSummary {
  lines: CalculatedLine[];
  /** Suma de los subtotales. */
  subtotal: number;
  /**
   * Total a pagar. Hoy es igual al subtotal: el costo de delivery se decide en
   * el checkout (fase siguiente), no en el catálogo.
   */
  total: number;
  units: number;
}

/** Lo que devuelve un carrito sin nada que cobrar. */
const RESUMEN_VACIO: CartSummary = { lines: [], subtotal: 0, total: 0, units: 0 };

/**
 * Calcula el resumen cruzando el carrito con los productos reales.
 * Los `code` que ya no existan (o estén inactivos) se ignoran.
 *
 * ── AGOTAR UN PRODUCTO TUMBABA EL MENÚ ENTERO (07-09-2026) ──────────────────
 *
 * "Se ignoran" era verdad para algunos, no para todos. `calculateOrder` LANZA
 * cuando no le queda ni una línea —"El pedido debe incluir al menos un
 * producto."— y hace bien: es la guarda del pedido de verdad, la que impide
 * cobrar por nada. Pero esto no cobra nada, solo PINTA.
 *
 * Así que el cliente que tenía dos trancapechos guardados en su navegador y
 * volvía al menú después de que el panel lo marcara agotado recibía esa
 * excepción DENTRO del render de `useCart` —ver `use-cart.ts`—, y una excepción
 * en el render se lleva por delante el árbol entero: el menú no cargaba. No su
 * carrito: el menú, con todo lo demás que sí estaba a la venta.
 *
 * Un carrito cuyo contenido ya no se vende es un carrito vacío para quien lo
 * dibuja. Se responde lo mismo que a un carrito sin nada, que es exactamente lo
 * que le queda al cliente.
 */
export function summarizeCart(cart: CartState, items: MenuItem[]): CartSummary {
  const units = totalUnits(cart);
  if (units === 0) return RESUMEN_VACIO;

  // ¿Queda algo del carrito que siga a la venta? La comparación es la MISMA que
  // hace `calculateOrder` al armar sus líneas —el `code` del producto contra las
  // cantidades del carrito— y por eso no puede discrepar con ella.
  const quedaAlgo = items.some((item) => (cart[item.code] ?? 0) > 0);
  if (!quedaAlgo) return RESUMEN_VACIO;

  // `calculateOrder` es la única fuente de la aritmética de precios.
  // 'pickup' evita sumar delivery: el tipo de entrega se elige en el checkout.
  const calc = calculateOrder(items, { ...cart }, 'pickup');

  return {
    lines: calc.lines,
    subtotal: round2(calc.subtotal_amount),
    total: round2(calc.total_amount),
    units: calc.lines.reduce((acc, line) => acc + line.quantity, 0),
  };
}

/**
 * Reconstruye el carrito desde el texto guardado en `localStorage`.
 * Cualquier dato inválido (JSON roto, array, cantidades negativas, no enteras,
 * fuera de rango o no numéricas) se descarta en silencio: nunca lanza.
 */
export function parseStoredCart(raw: string | null | undefined): CartState {
  if (!raw) return EMPTY_CART;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return EMPTY_CART;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return EMPTY_CART;
  }

  const cart: Record<string, number> = {};
  for (const [code, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof code !== 'string' || code === '') continue;
    if (typeof value !== 'number' || !Number.isInteger(value)) continue;
    if (value <= 0 || value > MAX_QUANTITY_PER_ITEM) continue;
    cart[code] = value;
  }

  return cart;
}

/** Serializa el carrito para `localStorage`. */
export function serializeCart(cart: CartState): string {
  return JSON.stringify(cart);
}

export { MAX_QUANTITY_PER_ITEM };
