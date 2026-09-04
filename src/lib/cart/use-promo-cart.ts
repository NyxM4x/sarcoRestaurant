'use client';

/**
 * Hook del carrito de PROMOCIONES.
 *
 * Gemelo de `./use-cart` y por los mismos motivos: `localStorage` es un almacén
 * externo, así que se lee con `useSyncExternalStore` para que la hidratación no
 * desajuste y para que otra pestaña abierta actualice esta.
 *
 * Clave propia. El carrito de productos ya está guardado en el navegador de
 * cada cliente que pasó por aquí, y meter los combos dentro obligaría a
 * versionar ese formato con el riesgo de leer mal un carrito viejo.
 *
 * Las operaciones son las MISMAS funciones puras de `./cart`: un carrito de
 * combos tiene la forma `{ id: cantidad }`, exactamente igual que uno de
 * productos. Lo único distinto es cómo se convierte en dinero, y eso vive en
 * `./promo-cart`.
 */
import { useCallback, useMemo, useSyncExternalStore } from 'react';
import type { Promotion } from '@/lib/promotions/promotion';
import {
  type CartState,
  clearCart as clearCartState,
  decrement as decrementItem,
  increment as incrementItem,
  parseStoredCart,
  quantityOf,
  removeItem as removeCartItem,
  serializeCart,
} from './cart';
import { summarizePromoCart, type PromoCartSummary } from './promo-cart';

export const PROMO_CART_STORAGE_KEY = 'la-fija:promos:v1';

const listeners = new Set<() => void>();

/** Copia en memoria: única fuente si `localStorage` falla (modo privado). */
let memoryRaw: string | null = null;

function readRaw(): string | null {
  try {
    return window.localStorage.getItem(PROMO_CART_STORAGE_KEY);
  } catch {
    return memoryRaw;
  }
}

function writeRaw(raw: string): void {
  memoryRaw = raw;
  try {
    window.localStorage.setItem(PROMO_CART_STORAGE_KEY, raw);
  } catch {
    // Sin persistencia: seguimos con `memoryRaw`.
  }
  for (const listener of listeners) listener();
}

function subscribe(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  window.addEventListener('storage', onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
    window.removeEventListener('storage', onStoreChange);
  };
}

const serverRaw = () => null;

export interface UsePromoCart {
  state: CartState;
  summary: PromoCartSummary;
  quantity: (promotionId: string) => number;
  add: (promotionId: string) => void;
  remove: (promotionId: string) => void;
  drop: (promotionId: string) => void;
  clear: () => void;
  /** Deja el carrito de combos con exactamente esto. Ver `useCart.seed`. */
  seed: (next: CartState) => void;
}

export function usePromoCart(promotions: Promotion[], now: number): UsePromoCart {
  const raw = useSyncExternalStore(subscribe, readRaw, serverRaw);
  const state = useMemo(() => parseStoredCart(raw), [raw]);

  const update = useCallback((next: CartState) => {
    writeRaw(serializeCart(next));
  }, []);

  // Cada operación relee el almacén antes de escribir, igual que en `useCart`:
  // así dos toques seguidos no se pisan aunque React todavía no haya aplicado
  // el estado del primero.
  const add = useCallback(
    (id: string) => update(incrementItem(parseStoredCart(readRaw()), id)),
    [update],
  );
  const remove = useCallback(
    (id: string) => update(decrementItem(parseStoredCart(readRaw()), id)),
    [update],
  );
  const drop = useCallback(
    (id: string) => update(removeCartItem(parseStoredCart(readRaw()), id)),
    [update],
  );
  const clear = useCallback(() => update(clearCartState()), [update]);

  /** Gemelo del `seed` de `useCart`, y por el mismo motivo (0035). */
  const seed = useCallback(
    (next: CartState) => update(parseStoredCart(serializeCart(next))),
    [update],
  );

  const quantity = useCallback((id: string) => quantityOf(state, id), [state]);

  const summary = useMemo(
    () => summarizePromoCart(state, promotions, now),
    [state, promotions, now],
  );

  return { state, summary, quantity, add, remove, drop, clear, seed };
}
