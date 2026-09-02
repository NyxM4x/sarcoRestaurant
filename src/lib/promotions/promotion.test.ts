import { describe, expect, it } from 'vitest';
import type { MenuItem } from '@/types';
import {
  evaluatePromotion,
  isPurchasable,
  normalPriceOf,
  totalUnitsOf,
  validatePromotionDraft,
  type Promotion,
  type PromotionComponent,
  type PromotionDraft,
} from './promotion';

/**
 * Lo que se prueba aquí es la REGLA MONETARIA y el estado del combo: que el
 * precio normal salga siempre de los componentes, que nunca se anuncie un
 * ahorro que no existe, y que un combo apagado, programado, vencido o roto no
 * se pueda comprar.
 */

const componente = (
  over: Partial<PromotionComponent> & { code: string },
): PromotionComponent => ({
  menuItemId: `id-${over.code}`,
  name: over.code,
  category: 'plato',
  unitPrice: 30,
  quantity: 2,
  isActive: true,
  ...over,
});

/** 2×30 + 2×5 + 2×10 = 90. El ejemplo del negocio. */
const COMBO: PromotionComponent[] = [
  componente({ code: 'lomito', name: 'Lomito', unitPrice: 30, quantity: 2 }),
  componente({ code: 'soda_peque', name: 'Soda Peque', category: 'bebida', unitPrice: 5, quantity: 2 }),
  componente({ code: 'porcion_papas', name: 'Porción de papa', category: 'extra', unitPrice: 10, quantity: 2 }),
];

const PROMO: Promotion = {
  id: 'promo-1',
  name: '2 lomitos goleadores',
  description: null,
  promoPrice: 60,
  imageUrl: null,
  startsAt: null,
  endsAt: null,
  isActive: true,
  revision: 1,
  updatedAt: '2026-09-02T00:00:00.000Z',
  components: COMBO,
};

const AHORA = Date.parse('2026-09-02T20:00:00.000Z');

describe('precio normal', () => {
  it('es la suma de los precios vigentes por cantidad', () => {
    expect(normalPriceOf(COMBO)).toBe(90);
  });

  it('sin componentes es cero, no un error', () => {
    expect(normalPriceOf([])).toBe(0);
  });

  it('no arrastra el error binario de los decimales', () => {
    const centavos = [
      componente({ code: 'a', unitPrice: 0.1, quantity: 1 }),
      componente({ code: 'b', unitPrice: 0.2, quantity: 1 }),
    ];
    expect(normalPriceOf(centavos)).toBe(0.3);
  });

  it('cuenta las unidades incluyendo repeticiones del mismo producto', () => {
    expect(totalUnitsOf(COMBO)).toBe(6);
  });
});

describe('estado del combo', () => {
  it('una promoción encendida y con ahorro se puede comprar', () => {
    const p = evaluatePromotion(PROMO, AHORA);
    expect(p.status).toBe('available');
    expect(p.normalPrice).toBe(90);
    expect(p.promoPrice).toBe(60);
    expect(p.savings).toBe(30);
    expect(isPurchasable(p)).toBe(true);
  });

  it('apagada: no se compra aunque las cifras cuadren', () => {
    const p = evaluatePromotion({ ...PROMO, isActive: false }, AHORA);
    expect(p.status).toBe('disabled');
    expect(isPurchasable(p)).toBe(false);
  });

  it('programada mientras no llega su hora de inicio', () => {
    const p = evaluatePromotion({ ...PROMO, startsAt: '2026-09-03T00:00:00.000Z' }, AHORA);
    expect(p.status).toBe('scheduled');
    expect(isPurchasable(p)).toBe(false);
  });

  it('en cuanto empieza, se puede comprar', () => {
    const inicio = '2026-09-02T20:00:00.000Z';
    expect(evaluatePromotion({ ...PROMO, startsAt: inicio }, Date.parse(inicio)).status).toBe(
      'available',
    );
  });

  it('vencida en el instante exacto del fin: el final es exclusivo', () => {
    const fin = '2026-09-02T20:00:00.000Z';
    const p = evaluatePromotion({ ...PROMO, endsAt: fin }, Date.parse(fin));
    expect(p.status).toBe('expired');
    expect(isPurchasable(p)).toBe(false);
  });

  it('un segundo antes del fin todavía vale', () => {
    const fin = '2026-09-02T20:00:00.000Z';
    expect(evaluatePromotion({ ...PROMO, endsAt: fin }, Date.parse(fin) - 1000).status).toBe(
      'available',
    );
  });

  it('un componente retirado del catálogo la tumba entera', () => {
    const rota = COMBO.map((c) => (c.code === 'soda_peque' ? { ...c, isActive: false } : c));
    const p = evaluatePromotion({ ...PROMO, components: rota }, AHORA);
    expect(p.status).toBe('component_unavailable');
    expect(isPurchasable(p)).toBe(false);
  });

  it('menos de dos unidades todavía no es un combo', () => {
    const suelto = [componente({ code: 'lomito', quantity: 1 })];
    expect(evaluatePromotion({ ...PROMO, components: suelto }, AHORA).status).toBe('incomplete');
  });

  it('dos unidades del MISMO producto sí son un combo', () => {
    const dobles = [componente({ code: 'lomito', unitPrice: 30, quantity: 2 })];
    const p = evaluatePromotion({ ...PROMO, components: dobles, promoPrice: 50 }, AHORA);
    expect(p.status).toBe('available');
    expect(p.normalPrice).toBe(60);
    expect(p.savings).toBe(10);
  });

  it('si el precio de un producto sube hasta comerse el descuento, queda sin ahorro', () => {
    const caro = COMBO.map((c) => (c.code === 'lomito' ? { ...c, unitPrice: 12 } : c));
    // 2×12 + 2×5 + 2×10 = 54, por debajo de los 60 del combo.
    const p = evaluatePromotion({ ...PROMO, components: caro }, AHORA);
    expect(p.status).toBe('no_savings');
    expect(isPurchasable(p)).toBe(false);
  });

  it('el ahorro NUNCA es negativo: se informa cero y el estado lo explica', () => {
    const caro = COMBO.map((c) => ({ ...c, unitPrice: 1 }));
    const p = evaluatePromotion({ ...PROMO, components: caro }, AHORA);
    expect(p.savings).toBe(0);
    expect(p.savings).not.toBeLessThan(0);
  });

  it('el precio igual al normal tampoco es una promoción', () => {
    expect(evaluatePromotion({ ...PROMO, promoPrice: 90 }, AHORA).status).toBe('no_savings');
  });

  it('un componente caído pesa más que estar apagada: se reporta lo que hay que arreglar', () => {
    const rota = COMBO.map((c) => ({ ...c, isActive: false }));
    const p = evaluatePromotion({ ...PROMO, components: rota, isActive: false }, AHORA);
    expect(p.status).toBe('component_unavailable');
  });
});

// ── Validación del formulario del panel ─────────────────────────────────────

const menuItem = (id: string, price: number, activo = true): MenuItem => ({
  id,
  code: id,
  name: id,
  category: 'plato',
  price,
  is_active: activo,
  sort_order: 10,
  created_at: '2026-09-01T00:00:00.000Z',
  updated_at: '2026-09-01T00:00:00.000Z',
});

const CATALOGO: MenuItem[] = [menuItem('lomito', 30), menuItem('soda', 5), menuItem('retirado', 8, false)];

const borrador = (over: Partial<PromotionDraft> = {}): PromotionDraft => ({
  name: 'Combo',
  description: null,
  promoPrice: 50,
  startsAt: null,
  endsAt: null,
  components: [{ menuItemId: 'lomito', quantity: 2 }],
  ...over,
});

describe('validación del borrador', () => {
  it('acepta un combo correcto', () => {
    expect(validatePromotionDraft(borrador(), CATALOGO)).toEqual([]);
  });

  it('exige nombre', () => {
    expect(validatePromotionDraft(borrador({ name: '   ' }), CATALOGO)).toContain('name_required');
  });

  it('rechaza el precio cero', () => {
    expect(validatePromotionDraft(borrador({ promoPrice: 0 }), CATALOGO)).toContain(
      'price_not_positive',
    );
  });

  it('rechaza el precio negativo', () => {
    expect(validatePromotionDraft(borrador({ promoPrice: -10 }), CATALOGO)).toContain(
      'price_not_positive',
    );
  });

  it('rechaza un precio igual o mayor que el normal', () => {
    // 2×30 = 60 de normal.
    expect(validatePromotionDraft(borrador({ promoPrice: 60 }), CATALOGO)).toContain(
      'price_not_below_normal',
    );
    expect(validatePromotionDraft(borrador({ promoPrice: 61 }), CATALOGO)).toContain(
      'price_not_below_normal',
    );
  });

  it('la regla monetaria se aplica siempre, sin bandera que la desactive', () => {
    // La firma no admite ningún parámetro para saltársela: si lo admitiera,
    // este test no podría escribirse.
    expect(validatePromotionDraft.length).toBe(2);
  });

  it('exige al menos dos unidades', () => {
    const uno = borrador({ components: [{ menuItemId: 'lomito', quantity: 1 }], promoPrice: 20 });
    expect(validatePromotionDraft(uno, CATALOGO)).toContain('components_required');
  });

  it('acepta dos productos distintos de uno en uno', () => {
    const mixto = borrador({
      components: [
        { menuItemId: 'lomito', quantity: 1 },
        { menuItemId: 'soda', quantity: 1 },
      ],
      promoPrice: 30,
    });
    expect(validatePromotionDraft(mixto, CATALOGO)).toEqual([]);
  });

  it('rechaza cantidades no enteras', () => {
    const roto = borrador({ components: [{ menuItemId: 'lomito', quantity: 2.5 }] });
    expect(validatePromotionDraft(roto, CATALOGO)).toContain('quantity_not_integer');
  });

  it('rechaza cantidades fuera de rango', () => {
    for (const quantity of [0, -1, 21]) {
      const roto = borrador({ components: [{ menuItemId: 'lomito', quantity }] });
      expect(validatePromotionDraft(roto, CATALOGO), String(quantity)).toContain(
        'quantity_out_of_range',
      );
    }
  });

  it('rechaza el mismo producto dos veces', () => {
    const dup = borrador({
      components: [
        { menuItemId: 'lomito', quantity: 1 },
        { menuItemId: 'lomito', quantity: 1 },
      ],
    });
    expect(validatePromotionDraft(dup, CATALOGO)).toContain('duplicate_component');
  });

  it('rechaza un producto que no está en el catálogo', () => {
    const fantasma = borrador({ components: [{ menuItemId: 'no-existe', quantity: 2 }] });
    expect(validatePromotionDraft(fantasma, CATALOGO)).toContain('unknown_component');
  });

  it('rechaza un producto retirado', () => {
    const retirado = borrador({ components: [{ menuItemId: 'retirado', quantity: 2 }] });
    expect(validatePromotionDraft(retirado, CATALOGO)).toContain('component_unavailable');
  });

  it('exige que el vencimiento sea posterior al inicio', () => {
    const alReves = borrador({
      startsAt: '2026-09-05T00:00:00.000Z',
      endsAt: '2026-09-04T00:00:00.000Z',
    });
    expect(validatePromotionDraft(alReves, CATALOGO)).toContain('window_out_of_order');
  });

  it('rechaza fechas ilegibles', () => {
    expect(validatePromotionDraft(borrador({ endsAt: 'mañana' }), CATALOGO)).toContain(
      'invalid_date',
    );
  });

  it('acepta una sola frontera: solo inicio, o solo vencimiento', () => {
    expect(validatePromotionDraft(borrador({ startsAt: '2026-09-05T00:00:00.000Z' }), CATALOGO)).toEqual([]);
    expect(validatePromotionDraft(borrador({ endsAt: '2026-09-05T00:00:00.000Z' }), CATALOGO)).toEqual([]);
  });

  it('no entierra el error de precio inválido con el de "no baja del normal"', () => {
    const errores = validatePromotionDraft(borrador({ promoPrice: 0 }), CATALOGO);
    expect(errores).toContain('price_not_positive');
    expect(errores).not.toContain('price_not_below_normal');
  });
});
