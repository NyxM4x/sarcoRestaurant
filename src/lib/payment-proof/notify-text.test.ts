import { describe, it, expect } from 'vitest';
import { REJECTION_GRACE_MS } from './payment-gate';
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
    expect(PAYMENT_REJECTED_TEXT).toContain('reenviar una captura clara');
    // "Aqui mismo" evita que el cliente cree un pedido nuevo (nos dejaria dos).
    expect(PAYMENT_REJECTED_TEXT).toContain('aquí mismo');
  });

  it('el texto de rechazo anuncia el plazo y lo que pasa al vencer (0028)', () => {
    // Sin esto, el pedido se cancelaria solo a los quince minutos sin que el
    // cliente supiera nunca que tenia un reloj corriendo.
    expect(PAYMENT_REJECTED_TEXT).toContain('cancelado automáticamente');
    expect(PAYMENT_REJECTED_TEXT).toContain(`${Math.round(REJECTION_GRACE_MS / 60_000)} minutos`);
  });

  it('el plazo del texto SALE de la constante que aplica la puerta', () => {
    // Un numero escrito a mano en la frase divergiria de la regla el dia que se
    // cambie el plazo, y el cliente leeria un plazo que ya no es cierto.
    // Con limite de palabra: "15 minutos" CONTIENE "5 minutos" como subcadena.
    const otros = [5, 10, 20, 30, 60].filter((m) => m !== REJECTION_GRACE_MS / 60_000);
    for (const m of otros) {
      expect(PAYMENT_REJECTED_TEXT, `${m}`).not.toMatch(new RegExp(`\b${m} minutos`));
    }
  });

  it('no culpa al cliente: la foto PUEDE estar borrosa, no miente', () => {
    // Quien se equivoco de captura recibe el mismo texto que quien retoco una.
    // Acusar al primero por si acaso cuesta un cliente real.
    expect(PAYMENT_REJECTED_TEXT.toLowerCase()).not.toMatch(/fraude|falso|enga|estafa|miente/);
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
