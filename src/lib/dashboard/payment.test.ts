import { describe, it, expect } from 'vitest';
import { paymentMethodMeta } from './payment';

describe('payment — paymentMethodMeta (chip del dashboard, 6D.1)', () => {
  it('cash → 💵 Efectivo', () => {
    expect(paymentMethodMeta('cash')).toEqual({ label: 'Efectivo', icon: '💵' });
  });

  it('qr → QR', () => {
    const meta = paymentMethodMeta('qr');
    expect(meta?.label).toBe('QR');
    expect(meta).not.toBeNull();
  });

  it('null (histórico / WhatsApp Flow) → sin chip', () => {
    expect(paymentMethodMeta(null)).toBeNull();
  });

  it('la etiqueta nunca depende solo del color (siempre hay texto)', () => {
    expect(paymentMethodMeta('cash')?.label).toBeTruthy();
    expect(paymentMethodMeta('qr')?.label).toBeTruthy();
  });
});
