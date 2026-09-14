import { describe, expect, it } from 'vitest';
import type { MenuCategory } from '@/types';
import type { Promotion, PromotionComponent } from './promotion';
import { NORMAL_MODE, orderSectionsForMode, promoModeAt } from './promo-mode';

/**
 * La noche de promoción (14-09-2026): lo que se prueba es que el modo empiece y
 * termine EXACTAMENTE con la promoción, que el suelto solo se esconda en combos
 * de un producto y que las bebidas suban sin desordenar lo demás.
 */

const trancapecho = (over: Partial<PromotionComponent> = {}): PromotionComponent => ({
  menuItemId: 'id-trancapecho',
  code: 'trancapecho',
  name: 'Trancapecho',
  category: 'plato',
  unitPrice: 18,
  quantity: 2,
  isActive: true,
  ...over,
});

/** 2 × Bs 18 = Bs 36 normal; se vende a Bs 25. Hasta las 00:00 del 15-09 en Bolivia. */
const DOS_TRANCAPECHOS: Promotion = {
  id: 'promo-trancapecho',
  name: '2 Trancapechos',
  description: null,
  promoPrice: 25,
  imageUrl: null,
  startsAt: null,
  endsAt: '2026-09-15T04:00:00.000Z',
  isActive: true,
  revision: 1,
  updatedAt: '2026-09-14T18:00:00.000Z',
  components: [trancapecho()],
};

const COMBO_VARIADO: Promotion = {
  ...DOS_TRANCAPECHOS,
  id: 'promo-lomito',
  name: 'Lomito con soda',
  promoPrice: 20,
  components: [
    { ...trancapecho(), menuItemId: 'id-lomito', code: 'lomito', name: 'Lomito', quantity: 1 },
    {
      ...trancapecho(),
      menuItemId: 'id-soda',
      code: 'soda_peque',
      name: 'Soda Peque',
      category: 'bebida',
      unitPrice: 5,
      quantity: 1,
    },
  ],
};

/** 23:59:59 del 14-09 en Bolivia. */
const ANTES_DE_MEDIANOCHE = Date.parse('2026-09-15T03:59:59.000Z');
/** 00:00 en punto del 15-09 en Bolivia. */
const MEDIANOCHE = Date.parse('2026-09-15T04:00:00.000Z');

describe('promoModeAt — cuándo es noche de promoción', () => {
  it('sin promociones es el menú de siempre', () => {
    expect(promoModeAt([], ANTES_DE_MEDIANOCHE)).toBe(NORMAL_MODE);
  });

  it('con una promoción vendible se activa y apaga el efectivo', () => {
    const modo = promoModeAt([DOS_TRANCAPECHOS], ANTES_DE_MEDIANOCHE);
    expect(modo.active).toBe(true);
    expect(modo.cashAllowed).toBe(false);
  });

  it('a las 00:00 en punto vuelve solo al menú de siempre', () => {
    const modo = promoModeAt([DOS_TRANCAPECHOS], MEDIANOCHE);
    expect(modo).toBe(NORMAL_MODE);
    expect(modo.cashAllowed).toBe(true);
    expect(modo.comboOnlyCodes.size).toBe(0);
  });

  it('una promoción apagada no activa nada', () => {
    const apagada = { ...DOS_TRANCAPECHOS, isActive: false };
    expect(promoModeAt([apagada], ANTES_DE_MEDIANOCHE)).toBe(NORMAL_MODE);
  });

  it('una promoción sin ahorro tampoco: no se puede comprar', () => {
    const sinAhorro = { ...DOS_TRANCAPECHOS, promoPrice: 36 };
    expect(promoModeAt([sinAhorro], ANTES_DE_MEDIANOCHE)).toBe(NORMAL_MODE);
  });
});

describe('promoModeAt — qué deja de venderse suelto', () => {
  it('el producto de un combo de UN solo producto va solo en el combo', () => {
    const modo = promoModeAt([DOS_TRANCAPECHOS], ANTES_DE_MEDIANOCHE);
    expect([...modo.comboOnlyCodes]).toEqual(['trancapecho']);
  });

  it('los productos de un combo variado se siguen vendiendo sueltos', () => {
    const modo = promoModeAt([COMBO_VARIADO], ANTES_DE_MEDIANOCHE);
    expect(modo.active).toBe(true);
    expect(modo.comboOnlyCodes.size).toBe(0);
  });

  it('una promoción que ya no se vende no esconde su producto', () => {
    const vencida = { ...DOS_TRANCAPECHOS, endsAt: '2026-09-14T20:00:00.000Z' };
    const modo = promoModeAt([vencida, COMBO_VARIADO], ANTES_DE_MEDIANOCHE);
    expect(modo.active).toBe(true);
    expect(modo.comboOnlyCodes.has('trancapecho')).toBe(false);
  });
});

describe('orderSectionsForMode — Bebidas debajo de Promociones', () => {
  const secciones: Array<{ category: MenuCategory }> = [
    { category: 'plato' },
    { category: 'bebida' },
    { category: 'extra' },
  ];

  it('en noche de promoción las bebidas pasan primero y el resto no se desordena', () => {
    const modo = promoModeAt([DOS_TRANCAPECHOS], ANTES_DE_MEDIANOCHE);
    expect(orderSectionsForMode(secciones, modo).map((s) => s.category)).toEqual([
      'bebida',
      'plato',
      'extra',
    ]);
  });

  it('fuera del modo devuelve la misma lista, sin tocarla', () => {
    expect(orderSectionsForMode(secciones, NORMAL_MODE)).toBe(secciones);
  });

  it('si no hay bebidas (búsqueda sin resultados en esa categoría) no inventa la sección', () => {
    const modo = promoModeAt([DOS_TRANCAPECHOS], ANTES_DE_MEDIANOCHE);
    const sinBebidas = [{ category: 'plato' as const }, { category: 'extra' as const }];
    expect(orderSectionsForMode(sinBebidas, modo).map((s) => s.category)).toEqual([
      'plato',
      'extra',
    ]);
  });
});
