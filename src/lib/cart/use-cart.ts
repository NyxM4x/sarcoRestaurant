'use client';

/**
 * Hook del carrito: envuelve la lógica pura de `./cart` con `localStorage`.
 *
 * `localStorage` es un almacén externo, así que se lee con
 * `useSyncExternalStore` en vez de `useState` + `useEffect`:
 *
 * - **Hidratación segura**: el snapshot del servidor es siempre `null`
 *   (carrito vacío), idéntico al primer render del cliente. No hay desajuste.
 * - `hydrated` avisa cuándo el carrito guardado ya se leyó, para no mostrar
 *   el botón de carrito con un total equivocado durante un frame.
 * - Si `localStorage` no está disponible (modo privado, storage bloqueado),
 *   se usa una copia en memoria: la tienda sigue funcionando en esa sesión.
 * - El carrito guardado es del enlace con el que se armó (19-09-2026): con
 *   otro enlace se lee vacío. Ver `rawForOwner` en `./cart`.
 */
import { useCallback, useMemo, useSyncExternalStore } from 'react';
import type { MenuItem } from '@/types';
import {
  CART_STORAGE_KEY,
  type CartState,
  type CartSummary,
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
  summarizeCart,
  totalUnits,
} from './cart';

// ── Almacén externo sobre localStorage ──────────────────────────────────────

const OWNER_KEY = cartOwnerKey(CART_STORAGE_KEY);

const listeners = new Set<() => void>();

/** Copia en memoria: única fuente si `localStorage` falla. */
let memoryRaw: string | null = null;
let memoryOwner: string | null = null;

function readRaw(owner: string): string | null {
  try {
    const storage = window.localStorage;
    return rawForOwner(storage.getItem(OWNER_KEY), storage.getItem(CART_STORAGE_KEY), owner);
  } catch {
    return rawForOwner(memoryOwner, memoryRaw, owner);
  }
}

function writeRaw(raw: string, owner: string): void {
  memoryRaw = raw;
  memoryOwner = owner;
  try {
    window.localStorage.setItem(CART_STORAGE_KEY, raw);
    window.localStorage.setItem(OWNER_KEY, owner);
  } catch {
    // Sin persistencia: seguimos con `memoryRaw`.
  }
  for (const listener of listeners) listener();
}

function subscribe(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  // Otra pestaña con la tienda abierta también actualiza este carrito.
  window.addEventListener('storage', onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
    window.removeEventListener('storage', onStoreChange);
  };
}

const serverRaw = () => null;
const clientHydrated = () => true;
const serverHydrated = () => false;

// ── Hook ────────────────────────────────────────────────────────────────────

export interface UseCart {
  cart: CartState;
  /** `false` en el render del servidor y en el primero del cliente. */
  hydrated: boolean;
  units: number;
  summary: CartSummary;
  quantity: (code: string) => number;
  add: (code: string) => void;
  remove: (code: string) => void;
  drop: (code: string) => void;
  clear: () => void;
  /**
   * Deja el carrito con EXACTAMENTE lo que se le pasa (0035).
   *
   * Existe para un solo caso: el cliente que abre el enlace de "Cambiar mi
   * pedido" y tiene que encontrarse dentro lo que ya había pedido. No es un
   * `add` repetido —eso escribiría N veces y dispararía N renders— ni un
   * `clear` seguido de altas.
   *
   * Quien lo llame decide si pisa algo: aquí no se comprueba nada. La regla
   * —sembrar solo sobre un carrito vacío— vive en `MenuStore`, que es quien
   * sabe si el cliente venía de otra cosa.
   */
  seed: (next: CartState) => void;
}

/**
 * @param sessionId La sesión del menú con la que se abrió la página, o `null`
 *   sin enlace. Solo se usa para saber de quién es el carrito guardado.
 */
export function useCart(items: MenuItem[], sessionId: string | null): UseCart {
  const owner = cartOwnerTag(sessionId);
  const readOwn = useCallback(() => readRaw(owner), [owner]);

  const raw = useSyncExternalStore(subscribe, readOwn, serverRaw);
  const hydrated = useSyncExternalStore(subscribe, clientHydrated, serverHydrated);

  const cart = useMemo(() => parseStoredCart(raw), [raw]);

  const update = useCallback(
    (next: CartState) => {
      writeRaw(serializeCart(next), owner);
    },
    [owner],
  );

  const add = useCallback(
    (code: string) => update(incrementItem(parseStoredCart(readOwn()), code)),
    [update, readOwn],
  );

  const remove = useCallback(
    (code: string) => update(decrementItem(parseStoredCart(readOwn()), code)),
    [update, readOwn],
  );

  const drop = useCallback(
    (code: string) => update(removeCartItem(parseStoredCart(readOwn()), code)),
    [update, readOwn],
  );

  const clear = useCallback(() => update(clearCartState()), [update]);

  // Pasa por `parseStoredCart` para heredar sus mismas guardas: cantidades
  // recortadas al máximo por producto y entradas en cero descartadas. Sembrar
  // no puede meter en el carrito nada que el cliente no pudiera poner a mano.
  const seed = useCallback(
    (next: CartState) => update(parseStoredCart(serializeCart(next))),
    [update],
  );

  const quantity = useCallback((code: string) => quantityOf(cart, code), [cart]);
  const summary = useMemo(() => summarizeCart(cart, items), [cart, items]);
  const units = useMemo(() => totalUnits(cart), [cart]);

  return { cart, hydrated, units, summary, quantity, add, remove, drop, clear, seed };
}
