import { describe, it, expect } from 'vitest';
import type { MenuItem } from '@/types';
import {
  buildSummaryLines,
  calculateOrder,
  formatBs,
  MAX_QUANTITY_PER_ITEM,
  normalizeQuantity,
  OrderValidationError,
  round2,
} from './calculate';

function menuItem(partial: Partial<MenuItem> & Pick<MenuItem, 'code' | 'name' | 'price'>): MenuItem {
  return {
    id: `id-${partial.code}`,
    category: 'plato',
    is_active: true,
    sort_order: 0,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...partial,
  };
}

const menu: MenuItem[] = [
  menuItem({ code: 'la_fija', name: 'La Fija', price: 22 }),
  menuItem({ code: 'hat_trick', name: 'Hat Trick', price: 42 }),
  menuItem({ code: 'gaseosa_2l', name: 'Gaseosa 2 L', price: 18, category: 'bebida' }),
];

describe('normalizeQuantity', () => {
  it('treats empty values as 0', () => {
    expect(normalizeQuantity(undefined)).toBe(0);
    expect(normalizeQuantity(null)).toBe(0);
    expect(normalizeQuantity('')).toBe(0);
  });

  it('parses numeric strings', () => {
    expect(normalizeQuantity('3')).toBe(3);
    expect(normalizeQuantity(' 2 ')).toBe(2);
    expect(normalizeQuantity(5)).toBe(5);
  });

  it('accepts the max boundary', () => {
    expect(normalizeQuantity(MAX_QUANTITY_PER_ITEM)).toBe(MAX_QUANTITY_PER_ITEM);
  });

  it('rejects non-integers and out-of-range values', () => {
    expect(() => normalizeQuantity('2.5')).toThrow(OrderValidationError);
    expect(() => normalizeQuantity('abc')).toThrow(OrderValidationError);
    expect(() => normalizeQuantity(-1)).toThrow(OrderValidationError);
    expect(() => normalizeQuantity(11)).toThrow(OrderValidationError);
  });
});

describe('calculateOrder', () => {
  it('computes subtotals, snapshots and total (pickup)', () => {
    const calc = calculateOrder(
      menu,
      { la_fija: 2, gaseosa_2l: 1 },
      'pickup',
    );
    expect(calc.lines).toHaveLength(2);
    expect(calc.subtotal_amount).toBe(22 * 2 + 18);
    expect(calc.delivery_amount).toBe(0);
    expect(calc.total_amount).toBe(62);

    const fija = calc.lines.find((l) => l.product_code === 'la_fija');
    expect(fija).toMatchObject({
      product_name_snapshot: 'La Fija',
      unit_price_snapshot: 22,
      quantity: 2,
      subtotal: 44,
    });
  });

  it('ignores items with quantity 0', () => {
    const calc = calculateOrder(menu, { la_fija: 1, hat_trick: 0 }, 'pickup');
    expect(calc.lines).toHaveLength(1);
    expect(calc.lines[0].product_code).toBe('la_fija');
  });

  it('throws when the order is empty', () => {
    expect(() => calculateOrder(menu, { la_fija: 0 }, 'pickup')).toThrow(
      OrderValidationError,
    );
    expect(() => calculateOrder(menu, {}, 'delivery')).toThrow(OrderValidationError);
  });

  it('applies the delivery fee only for delivery', () => {
    const pickup = calculateOrder(menu, { la_fija: 1 }, 'pickup');
    const delivery = calculateOrder(menu, { la_fija: 1 }, 'delivery');
    // DELIVERY_FEE_BOB es 0 por ahora; el subtotal no debe cambiar.
    expect(pickup.subtotal_amount).toBe(delivery.subtotal_amount);
    expect(delivery.total_amount).toBe(
      delivery.subtotal_amount + delivery.delivery_amount,
    );
  });
});

describe('formatting helpers', () => {
  it('round2 avoids float drift', () => {
    expect(round2(0.1 + 0.2)).toBe(0.3);
  });

  it('formatBs prefixes with Bs.', () => {
    expect(formatBs(57)).toBe('Bs. 57');
  });

  it('buildSummaryLines renders one line per item', () => {
    const calc = calculateOrder(menu, { la_fija: 2 }, 'pickup');
    expect(buildSummaryLines(calc)).toEqual(['2x La Fija — Bs. 44']);
  });
});
