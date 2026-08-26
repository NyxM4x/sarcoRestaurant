import { describe, it, expect } from 'vitest';
import {
  PAYMENT_ACCEPTED_TEXT,
  PAYMENT_REJECTED_TEXT,
  paymentDecisionText,
} from './notify-text';

describe('textos del aviso al cliente', () => {
  it('cada decision tiene su texto', () => {
    expect(paymentDecisionText('accept')).toBe(PAYMENT_ACCEPTED_TEXT);
    expect(paymentDecisionText('reject')).toBe(PAYMENT_REJECTED_TEXT);
  });

  it('el texto de rechazo dice QUE hacer, no solo que fallo', () => {
    expect(PAYMENT_REJECTED_TEXT).toContain('respondiendo al mismo QR');
    expect(PAYMENT_REJECTED_TEXT.toLowerCase()).toContain('qr');
    // Evita que el cliente cree un pedido nuevo (nos dejaria dos).
    expect(PAYMENT_REJECTED_TEXT).toContain('No necesitas crear otro pedido');
  });

  it('ningun texto filtra datos internos', () => {
    for (const t of [PAYMENT_ACCEPTED_TEXT, PAYMENT_REJECTED_TEXT]) {
      expect(t).not.toMatch(/uuid|attempt|proof|storage|null|undefined|http/i);
    }
  });

  it('los textos no van vacios ni son iguales entre si', () => {
    expect(PAYMENT_ACCEPTED_TEXT.length).toBeGreaterThan(10);
    expect(PAYMENT_REJECTED_TEXT.length).toBeGreaterThan(10);
    expect(PAYMENT_ACCEPTED_TEXT).not.toBe(PAYMENT_REJECTED_TEXT);
  });
});
