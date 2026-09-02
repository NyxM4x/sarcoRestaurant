import { describe, expect, it } from 'vitest';
import type { Promotion } from '@/lib/promotions/promotion';
import type { CartSummary } from './cart';
import { summarizePromoCart, unifiedTotals } from './promo-cart';

const COMBO: Promotion = {
  id: 'promo-1',
  name: '2 lomitos goleadores',
  description: null,
  // 2×30 + 2×5 + 2×10 = 90 normal, 60 promo.
  promoPrice: 60,
  imageUrl: null,
  startsAt: null,
  endsAt: null,
  isActive: true,
  revision: 3,
  updatedAt: '2026-09-02T00:00:00.000Z',
  components: [
    {
      menuItemId: 'i1', code: 'lomito', name: 'Lomito', category: 'plato',
      unitPrice: 30, quantity: 2, isActive: true,
    },
    {
      menuItemId: 'i2', code: 'soda_peque', name: 'Soda Peque', category: 'bebida',
      unitPrice: 5, quantity: 2, isActive: true,
    },
    {
      menuItemId: 'i3', code: 'porcion_papas', name: 'Porción de papa', category: 'extra',
      unitPrice: 10, quantity: 2, isActive: true,
    },
  ],
};

const AHORA = Date.parse('2026-09-02T20:00:00.000Z');

const carritoVacio: CartSummary = { lines: [], subtotal: 0, total: 0, units: 0 };
const carritoCon = (subtotal: number, units: number): CartSummary => ({
  lines: [], subtotal, total: subtotal, units,
});

describe('un combo cuenta como UN artículo', () => {
  it('una promoción de seis componentes es 1 producto y su precio', () => {
    const r = summarizePromoCart({ 'promo-1': 1 }, [COMBO], AHORA);
    expect(r.units).toBe(1);
    expect(r.subtotal).toBe(60);
    expect(r.lines).toHaveLength(1);
  });

  it('el fallo que esto evita: no puede dar 0 productos y Bs 0', () => {
    const promos = summarizePromoCart({ 'promo-1': 1 }, [COMBO], AHORA);
    const total = unifiedTotals(carritoVacio, promos);
    expect(total.units).toBe(1);
    expect(total.subtotal).toBe(60);
    expect(total.isEmpty).toBe(false);
  });

  it('tampoco puede dar 6 productos por contar los componentes', () => {
    const promos = summarizePromoCart({ 'promo-1': 1 }, [COMBO], AHORA);
    expect(unifiedTotals(carritoVacio, promos).units).not.toBe(6);
  });

  it('pedir el combo dos veces son 2 artículos y el doble de precio', () => {
    const r = summarizePromoCart({ 'promo-1': 2 }, [COMBO], AHORA);
    expect(r.units).toBe(2);
    expect(r.subtotal).toBe(120);
  });

  it('guarda la revisión vista, para que viaje al checkout', () => {
    const r = summarizePromoCart({ 'promo-1': 1 }, [COMBO], AHORA);
    expect(r.lines[0].revision).toBe(3);
  });

  it('lleva las dos cifras: lo que se cobra y lo que costaría suelto', () => {
    const linea = summarizePromoCart({ 'promo-1': 1 }, [COMBO], AHORA).lines[0];
    expect(linea.unitPrice).toBe(60);
    expect(linea.normalPrice).toBe(90);
  });
});

describe('carrito mixto', () => {
  it('suma productos sueltos y combos', () => {
    const promos = summarizePromoCart({ 'promo-1': 1 }, [COMBO], AHORA);
    const total = unifiedTotals(carritoCon(30, 1), promos);
    expect(total.units).toBe(2);
    expect(total.subtotal).toBe(90);
    expect(total.total).toBe(90);
  });

  it('solo productos sueltos funciona igual que antes', () => {
    const promos = summarizePromoCart({}, [COMBO], AHORA);
    const total = unifiedTotals(carritoCon(45, 3), promos);
    expect(total.units).toBe(3);
    expect(total.subtotal).toBe(45);
  });

  it('los dos vacíos dan carrito vacío', () => {
    const total = unifiedTotals(carritoVacio, summarizePromoCart({}, [], AHORA));
    expect(total.isEmpty).toBe(true);
    expect(total.units).toBe(0);
  });
});

describe('lo que ya no se puede comprar', () => {
  it('una promoción vencida no suma, y se informa', () => {
    const vencida = { ...COMBO, endsAt: '2026-09-02T19:00:00.000Z' };
    const r = summarizePromoCart({ 'promo-1': 1 }, [vencida], AHORA);
    expect(r.lines).toHaveLength(0);
    expect(r.subtotal).toBe(0);
    expect(r.unavailableIds).toEqual(['promo-1']);
  });

  it('una promoción apagada tampoco', () => {
    const apagada = { ...COMBO, isActive: false };
    expect(summarizePromoCart({ 'promo-1': 1 }, [apagada], AHORA).unavailableIds).toEqual([
      'promo-1',
    ]);
  });

  it('un componente agotado la retira del total', () => {
    const rota = {
      ...COMBO,
      components: COMBO.components.map((c, i) => (i === 0 ? { ...c, isActive: false } : c)),
    };
    expect(summarizePromoCart({ 'promo-1': 1 }, [rota], AHORA).lines).toHaveLength(0);
  });

  it('una promoción que ya no existe se informa en vez de desaparecer callando', () => {
    const r = summarizePromoCart({ 'fantasma': 1 }, [COMBO], AHORA);
    expect(r.unavailableIds).toEqual(['fantasma']);
    expect(r.subtotal).toBe(0);
  });

  it('un combo caído no arrastra al que sí vale', () => {
    const otra: Promotion = { ...COMBO, id: 'promo-2', name: 'Otra', isActive: false };
    const r = summarizePromoCart({ 'promo-1': 1, 'promo-2': 1 }, [COMBO, otra], AHORA);
    expect(r.lines).toHaveLength(1);
    expect(r.subtotal).toBe(60);
    expect(r.unavailableIds).toEqual(['promo-2']);
  });
});

describe('robustez del estado guardado', () => {
  it('ignora cantidades que no son enteros positivos', () => {
    for (const q of [0, -1, 1.5, Number.NaN]) {
      const r = summarizePromoCart({ 'promo-1': q }, [COMBO], AHORA);
      expect(r.lines, String(q)).toHaveLength(0);
    }
  });

  it('el orden de las líneas es estable entre renders', () => {
    const b: Promotion = { ...COMBO, id: 'p-b', name: 'Bravo' };
    const a: Promotion = { ...COMBO, id: 'p-a', name: 'Alfa' };
    const uno = summarizePromoCart({ 'p-b': 1, 'p-a': 1 }, [a, b], AHORA);
    const dos = summarizePromoCart({ 'p-a': 1, 'p-b': 1 }, [b, a], AHORA);
    expect(uno.lines.map((l) => l.name)).toEqual(['Alfa', 'Bravo']);
    expect(dos.lines.map((l) => l.name)).toEqual(uno.lines.map((l) => l.name));
  });
});
