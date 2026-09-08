import { describe, it, expect } from 'vitest';
import { collectBreakdownOf } from './collect-breakdown';
import { deliveryCollectOf, type RawKitchenOrderRow } from './ticket-view';
import { amountDueByQrOf } from '@/lib/orders/amount-due';
import type { ProofAmountLabelView } from '@/lib/dashboard/attempt-review';

/**
 * La cuenta con la que se cierra la noche.
 *
 * Se prueba la CADENA ENTERA y no la funcion sola: las dos cifras salen de tres
 * sitios distintos —`amountDueByQrOf` la comida, `deliveryCollectOf` el chip y
 * `collectBreakdownOf` la resta— y lo que hay que garantizar es que el
 * resultado de los tres cuadre con lo que el cliente vio en su chat. Probar la
 * resta con numeros inventados dejaria fuera justo el error que importa: que la
 * comida no sea la que se cree.
 */

/** El pedido #12 del 07-09-2026: Bs 72 de comida + Bs 15 de envio = Bs 87. */
function fila(overrides: Partial<RawKitchenOrderRow> = {}): RawKitchenOrderRow {
  return {
    id: 'o1',
    order_number: 'ORD-260907-012',
    status: 'ready',
    delivery_type: 'delivery',
    notes: null,
    created_at: '2026-09-07T23:09:00.000Z',
    confirmed_at: null,
    updated_at: '2026-09-07T23:43:00.000Z',
    subtotal_amount: 72,
    total_amount: 87,
    payment_method: 'cash',
    ...overrides,
  } as RawKitchenOrderRow;
}

/** El desglose tal como lo calcula la pantalla: de la fila, sin atajos. */
function desglose(row: RawKitchenOrderRow, etiqueta: ProofAmountLabelView | null = null) {
  return collectBreakdownOf(deliveryCollectOf(row, etiqueta), amountDueByQrOf(row));
}

const etiqueta = (code: 'pago_total' | 'pago_productos'): ProofAmountLabelView => ({
  code,
  text: code === 'pago_total' ? 'PAGO TOTAL' : 'PAGO PRODUCTOS',
  hint: '',
});

describe('desglose — efectivo', () => {
  it('separa la comida del envio', () => {
    expect(desglose(fila())).toEqual({ food: 72, shipping: 15 });
  });

  it('las dos mitades suman EXACTAMENTE lo que se cobra en la puerta', () => {
    // El invariante que sostiene el cierre de caja: si la suma no diera el
    // total del chip, una de las dos cifras estaria mintiendo y nadie lo veria
    // hasta contar el dinero.
    const row = fila();
    const collect = deliveryCollectOf(row, null);
    const partes = collectBreakdownOf(collect, amountDueByQrOf(row));

    expect(collect).toMatchObject({ kind: 'todo', amount: 87 });
    expect(partes).not.toBeNull();
    expect(partes!.food + (partes!.shipping as number)).toBe(87);
  });

  it('el envio con centavos no se pierde en la resta', () => {
    expect(desglose(fila({ subtotal_amount: 72.5, total_amount: 87.5 }))).toEqual({
      food: 72.5,
      shipping: 15,
    });
  });

  it('sin envio cotizado dice cero, no una cifra inventada', () => {
    expect(desglose(fila({ total_amount: 72 }))).toEqual({ food: 72, shipping: 0 });
  });
});

describe('desglose — por QR', () => {
  const porQr = (over: Partial<RawKitchenOrderRow> = {}) =>
    fila({ payment_method: 'qr', ...over });

  it('la comida ya entro por el banco; el envio se cobra en la puerta', () => {
    expect(desglose(porQr())).toEqual({ food: 72, shipping: 15 });
  });

  it('con el comprobante por el total, el envio consta pagado', () => {
    expect(desglose(porQr(), etiqueta('pago_total'))).toEqual({ food: 72, shipping: 'paid' });
  });

  it('con el comprobante por los productos, el envio sigue pendiente', () => {
    expect(desglose(porQr(), etiqueta('pago_productos'))).toEqual({ food: 72, shipping: 15 });
  });

  it('si una persona marco el envio como pagado, manda su palabra', () => {
    expect(desglose(porQr({ delivery_fee_paid: true }))).toEqual({ food: 72, shipping: 'paid' });
  });

  it('si una persona marco que falta cobrarlo, sale la cifra del envio', () => {
    expect(desglose(porQr({ delivery_fee_paid: false }))).toEqual({ food: 72, shipping: 15 });
  });
});

describe('desglose — cuando no hay dos mitades', () => {
  it('en recojo no hay envio que repartir', () => {
    // Es el caso del #7: la tarjeta ensena la etiqueta del comprobante y ningun
    // desglose, y eso es lo correcto. No hay puerta donde cobrar.
    expect(desglose(fila({ delivery_type: 'pickup', total_amount: 72 }))).toBeNull();
  });

  it('sin comida conocida no se escribe nada', () => {
    expect(desglose(fila({ subtotal_amount: 0 }))).toBeNull();
  });

  it('una resta imposible se calla en vez de inventar un envio', () => {
    // Total por debajo del subtotal: las cifras no cuadran entre si.
    expect(desglose(fila({ total_amount: 60 }))).toBeNull();
  });
});
