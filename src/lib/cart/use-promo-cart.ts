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
  cartOwnerKey,
  cartOwnerTag,
  clearCart as clearCartState,
  decrement as decrementItem,
  increment as incrementItem,
  parseStoredCart,
  quantityOf,
  rawForOwner,
  removeItem as removeCartItem,
  serializeCart,
} from './cart';
import { summarizePromoCart, type PromoCartSummary } from './promo-cart';

export const PROMO_CART_STORAGE_KEY = 'la-fija:promos:v1';

/**
 * Dueño propio y no el del carrito de productos: si fuera uno solo, agregar un
 * producto con el enlace nuevo lo anotaría como dueño y resucitaría los combos
 * que quedaron guardados del enlace anterior.
 */
const OWNER_KEY = cartOwnerKey(PROMO_CART_STORAGE_KEY);

const listeners = new Set<() => void>();

/** Copia en memoria: única fuente si `localStorage` falla (modo privado). */
let memoryRaw: string | null = null;
let memoryOwner: string | null = null;

function readRaw(owner: string): string | null {
  try {
    const storage = window.localStorage;
    return rawForOwner(storage.getItem(OWNER_KEY), storage.getItem(PROMO_CART_STORAGE_KEY), owner);
  } catch {
    return rawForOwner(memoryOwner, memoryRaw, owner);
  }
}

function writeRaw(raw: string, owner: string): void {
  memoryRaw = raw;
  memoryOwner = owner;
  try {
    window.localStorage.setItem(PROMO_CART_STORAGE_KEY, raw);
    window.localStorage.setItem(OWNER_KEY, owner);
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

/** `sessionId`: de qué enlace es el carrito guardado. Ver `useCart`. */
export function usePromoCart(
  promotions: Promotion[],
  now: number,
  sessionId: string | null,
): UsePromoCart {
  const owner = cartOwnerTag(sessionId);
  const readOwn = useCallback(() => readRaw(owner), [owner]);

  const raw = useSyncExternalStore(subscribe, readOwn, serverRaw);
  const state = useMemo(() => parseStoredCart(raw), [raw]);

  const update = useCallback(
    (next: CartState) => {
      writeRaw(serializeCart(next), owner);
    },
    [owner],
  );

  // Cada operación relee el almacén antes de escribir, igual que en `useCart`:
  // así dos toques seguidos no se pisan aunque React todavía no haya aplicado
  // el estado del primero.
  const add = useCallback(
    (id: string) => update(incrementItem(parseStoredCart(readOwn()), id)),
    [update, readOwn],
  );
  const remove = useCallback(
    (id: string) => update(decrementItem(parseStoredCart(readOwn()), id)),
    [update, readOwn],
  );
  const drop = useCallback(
    (id: string) => update(removeCartItem(parseStoredCart(readOwn()), id)),
    [update, readOwn],
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
