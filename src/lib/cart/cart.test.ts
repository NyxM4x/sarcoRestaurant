import { describe, expect, it } from 'vitest';
import type { MenuItem } from '@/types';
import { MAX_QUANTITY_PER_ITEM } from '@/lib/orders/calculate';
import {
  CART_STORAGE_KEY,
  EMPTY_CART,
  clearCart,
  decrement,
  increment,
  isEmpty,
  parseStoredCart,
  quantityOf,
  removeItem,
  serializeCart,
  setQuantity,
  summarizeCart,
  totalUnits,
} from './cart';

function item(code: string, name: string, category: MenuItem['category'], price: number): MenuItem {
  return {
    id: `id-${code}`,
    code,
    name,
    category,
    price,
    is_active: true,
    sort_order: 0,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

const MENU: MenuItem[] = [
  item('la_fija', 'La Fija', 'plato', 22),
  item('doble_o_nada', 'Doble o Nada', 'plato', 32),
  item('gaseosa_personal', 'Gaseosa personal', 'bebida', 8),
  item('porcion_papas', 'Porción de papas', 'extra', 10),
];

describe('agregar productos', () => {
  it('agrega un producto con cantidad 1', () => {
    const cart = increment(EMPTY_CART, 'la_fija');
    expect(cart).toEqual({ la_fija: 1 });
    expect(totalUnits(cart)).toBe(1);
  });

  it('no muta el carrito anterior', () => {
    const before = increment(EMPTY_CART, 'la_fija');
    const after = increment(before, 'doble_o_nada');
    expect(before).toEqual({ la_fija: 1 });
    expect(after).toEqual({ la_fija: 1, doble_o_nada: 1 });
  });
});

describe('aumentar y disminuir', () => {
  it('aumenta de a una unidad', () => {
    let cart = increment(EMPTY_CART, 'la_fija');
    cart = increment(cart, 'la_fija');
    cart = increment(cart, 'la_fija');
    expect(quantityOf(cart, 'la_fija')).toBe(3);
  });

  it('disminuye de a una unidad', () => {
    const cart = decrement({ la_fija: 3 }, 'la_fija');
    expect(quantityOf(cart, 'la_fija')).toBe(2);
  });

  it('al llegar a 0 elimina el producto del carrito', () => {
    const cart = decrement({ la_fija: 1, tocino: 2 }, 'la_fija');
    expect(cart).toEqual({ tocino: 2 });
    expect('la_fija' in cart).toBe(false);
  });

  it('disminuir un producto ausente deja el carrito igual', () => {
    expect(decrement({ tocino: 1 }, 'la_fija')).toEqual({ tocino: 1 });
  });

  it('removeItem elimina sin importar la cantidad', () => {
    expect(removeItem({ la_fija: 7, tocino: 1 }, 'la_fija')).toEqual({ tocino: 1 });
  });

  it('clearCart deja el carrito vacío', () => {
    expect(clearCart()).toEqual({});
  });
});

describe('máximo por producto', () => {
  it('no supera MAX_QUANTITY_PER_ITEM al incrementar', () => {
    let cart: Record<string, number> = {};
    for (let i = 0; i < MAX_QUANTITY_PER_ITEM + 5; i += 1) {
      cart = { ...increment(cart, 'la_fija') };
    }
    expect(cart.la_fija).toBe(MAX_QUANTITY_PER_ITEM);
    expect(MAX_QUANTITY_PER_ITEM).toBe(10);
  });

  it('setQuantity recorta cantidades por encima del máximo', () => {
    expect(setQuantity(EMPTY_CART, 'la_fija', 99)).toEqual({ la_fija: 10 });
  });

  it('setQuantity con 0 o negativo elimina el producto', () => {
    expect(setQuantity({ la_fija: 4 }, 'la_fija', 0)).toEqual({});
    expect(setQuantity({ la_fija: 4 }, 'la_fija', -3)).toEqual({});
  });
});

describe('totales', () => {
  it('calcula subtotal por línea y total general con precios reales', () => {
    const summary = summarizeCart(
      { la_fija: 2, gaseosa_personal: 1, porcion_papas: 1 },
      MENU,
    );

    expect(summary.lines).toHaveLength(3);
    const laFija = summary.lines.find((l) => l.product_code === 'la_fija');
    expect(laFija?.quantity).toBe(2);
    expect(laFija?.unit_price_snapshot).toBe(22);
    expect(laFija?.subtotal).toBe(44);

    // 44 + 8 + 10
    expect(summary.subtotal).toBe(62);
    expect(summary.total).toBe(62);
    expect(summary.units).toBe(4);
  });

  it('ignora códigos que ya no existen en el menú', () => {
    const summary = summarizeCart({ la_fija: 1, producto_borrado: 3 }, MENU);
    expect(summary.lines.map((l) => l.product_code)).toEqual(['la_fija']);
    expect(summary.total).toBe(22);
  });
});

describe('carrito vacío', () => {
  it('isEmpty y totalUnits reconocen el carrito vacío', () => {
    expect(isEmpty(EMPTY_CART)).toBe(true);
    expect(totalUnits(EMPTY_CART)).toBe(0);
    expect(isEmpty({ la_fija: 1 })).toBe(false);
  });

  it('summarizeCart devuelve totales en cero sin lanzar', () => {
    const summary = summarizeCart(EMPTY_CART, MENU);
    expect(summary).toEqual({ lines: [], subtotal: 0, total: 0, units: 0 });
  });
});

describe('persistencia en localStorage', () => {
  it('la clave está versionada', () => {
    expect(CART_STORAGE_KEY).toBe('la-fija:cart:v1');
  });

  it('serializa y recupera el mismo carrito', () => {
    const cart = { la_fija: 2, tocino: 1 };
    expect(parseStoredCart(serializeCart(cart))).toEqual(cart);
  });

  it('null, undefined o cadena vacía devuelven carrito vacío', () => {
    expect(parseStoredCart(null)).toEqual({});
    expect(parseStoredCart(undefined)).toEqual({});
    expect(parseStoredCart('')).toEqual({});
  });

  it('JSON inválido no lanza y devuelve carrito vacío', () => {
    expect(parseStoredCart('{no es json')).toEqual({});
    expect(parseStoredCart('undefined')).toEqual({});
  });

  it('descarta valores que no son objetos', () => {
    expect(parseStoredCart('null')).toEqual({});
    expect(parseStoredCart('"la_fija"')).toEqual({});
    expect(parseStoredCart('42')).toEqual({});
    expect(parseStoredCart('[["la_fija",2]]')).toEqual({});
  });

  it('descarta cantidades inválidas y conserva las válidas', () => {
    const stored = JSON.stringify({
      la_fija: 2,
      doble_o_nada: 0,
      hat_trick: -1,
      tocino: 2.5,
      porcion_papas: '3',
      gaseosa_2l: 99,
      gaseosa_personal: null,
      gaseosa_pequena: 10,
    });
    expect(parseStoredCart(stored)).toEqual({ la_fija: 2, gaseosa_pequena: 10 });
  });
});
