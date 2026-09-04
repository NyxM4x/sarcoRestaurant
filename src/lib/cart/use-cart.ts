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
 */
import { useCallback, useMemo, useSyncExternalStore } from 'react';
import type { MenuItem } from '@/types';
import {
  CART_STORAGE_KEY,
  type CartState,
  type CartSummary,
  clearCart as clearCartState,
  decrement as decrementItem,
  increment as incrementItem,
  parseStoredCart,
  quantityOf,
  removeItem as removeCartItem,
  serializeCart,
  summarizeCart,
  totalUnits,
} from './cart';

// ── Almacén externo sobre localStorage ──────────────────────────────────────

const listeners = new Set<() => void>();

/** Copia en memoria: única fuente si `localStorage` falla. */
let memoryRaw: string | null = null;

function readRaw(): string | null {
  try {
    return window.localStorage.getItem(CART_STORAGE_KEY);
  } catch {
    return memoryRaw;
  }
}

function writeRaw(raw: string): void {
  memoryRaw = raw;
  try {
    window.localStorage.setItem(CART_STORAGE_KEY, raw);
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

export function useCart(items: MenuItem[]): UseCart {
  const raw = useSyncExternalStore(subscribe, readRaw, serverRaw);
  const hydrated = useSyncExternalStore(subscribe, clientHydrated, serverHydrated);

  const cart = useMemo(() => parseStoredCart(raw), [raw]);

  const update = useCallback((next: CartState) => {
    writeRaw(serializeCart(next));
  }, []);

  const add = useCallback(
    (code: string) => update(incrementItem(parseStoredCart(readRaw()), code)),
    [update],
  );

  const remove = useCallback(
    (code: string) => update(decrementItem(parseStoredCart(readRaw()), code)),
    [update],
  );

  const drop = useCallback(
    (code: string) => update(removeCartItem(parseStoredCart(readRaw()), code)),
    [update],
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
