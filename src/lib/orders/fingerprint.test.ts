import { describe, it, expect } from 'vitest';
import { calculateCheckoutFingerprint, type CheckoutFingerprintInput } from './fingerprint';

function input(overrides: Partial<CheckoutFingerprintInput> = {}): CheckoutFingerprintInput {
  return {
    customer_name: 'Juan García',
    delivery_type: 'delivery',
    payment_method: 'cash',
    notes: 'Sin cebolla',
    items: [
      { code: 'la_fija', quantity: 1 },
      { code: 'gaseosa_2l', quantity: 2 },
    ],
    ...overrides,
  };
}

describe('calculateCheckoutFingerprint', () => {
  it('devuelve 64 caracteres hexadecimales en minúscula', () => {
    const fingerprint = calculateCheckoutFingerprint(input());
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('el mismo contenido produce la misma huella', () => {
    expect(calculateCheckoutFingerprint(input())).toBe(calculateCheckoutFingerprint(input()));
  });

  it('cambiar el orden de los items no cambia la huella', () => {
    const ordenA = calculateCheckoutFingerprint(
      input({
        items: [
          { code: 'la_fija', quantity: 1 },
          { code: 'gaseosa_2l', quantity: 2 },
        ],
      }),
    );
    const ordenB = calculateCheckoutFingerprint(
      input({
        items: [
          { code: 'gaseosa_2l', quantity: 2 },
          { code: 'la_fija', quantity: 1 },
        ],
      }),
    );
    expect(ordenA).toBe(ordenB);
  });

  it('los espacios exteriores se normalizan', () => {
    const limpio = calculateCheckoutFingerprint(input());
    const conEspacios = calculateCheckoutFingerprint(
      input({
        customer_name: '  Juan García  ',
        notes: '  Sin cebolla  ',
        items: [
          { code: '  la_fija ', quantity: 1 },
          { code: ' gaseosa_2l  ', quantity: 2 },
        ],
      }),
    );
    expect(conEspacios).toBe(limpio);
  });

  it('notes "" y null producen la misma huella', () => {
    const vacias = calculateCheckoutFingerprint(input({ notes: '' }));
    const nulas = calculateCheckoutFingerprint(input({ notes: null }));
    expect(vacias).toBe(nulas);
  });

  it('notes solo con espacios equivale a null', () => {
    const espacios = calculateCheckoutFingerprint(input({ notes: '   ' }));
    const nulas = calculateCheckoutFingerprint(input({ notes: null }));
    expect(espacios).toBe(nulas);
  });

  it('cambiar el producto cambia la huella', () => {
    const base = calculateCheckoutFingerprint(input());
    const otro = calculateCheckoutFingerprint(
      input({
        items: [
          { code: 'la_fija', quantity: 1 },
          { code: 'papas_fritas', quantity: 2 },
        ],
      }),
    );
    expect(otro).not.toBe(base);
  });

  it('cambiar la cantidad cambia la huella', () => {
    const base = calculateCheckoutFingerprint(input());
    const otra = calculateCheckoutFingerprint(
      input({
        items: [
          { code: 'la_fija', quantity: 3 },
          { code: 'gaseosa_2l', quantity: 2 },
        ],
      }),
    );
    expect(otra).not.toBe(base);
  });

  it('agregar una línea cambia la huella', () => {
    const base = calculateCheckoutFingerprint(input());
    const conExtra = calculateCheckoutFingerprint(
      input({
        items: [
          { code: 'la_fija', quantity: 1 },
          { code: 'gaseosa_2l', quantity: 2 },
          { code: 'papas_fritas', quantity: 1 },
        ],
      }),
    );
    expect(conExtra).not.toBe(base);
  });

  it('cambiar el nombre cambia la huella', () => {
    expect(calculateCheckoutFingerprint(input({ customer_name: 'Ana Rojas' }))).not.toBe(
      calculateCheckoutFingerprint(input()),
    );
  });

  it('cambiar las notas cambia la huella', () => {
    expect(calculateCheckoutFingerprint(input({ notes: 'Con picante' }))).not.toBe(
      calculateCheckoutFingerprint(input()),
    );
  });

  it('cambiar el tipo de entrega cambia la huella', () => {
    expect(calculateCheckoutFingerprint(input({ delivery_type: 'pickup' }))).not.toBe(
      calculateCheckoutFingerprint(input({ delivery_type: 'delivery' })),
    );
  });

  it('quitar las notas cambia la huella respecto a tenerlas', () => {
    expect(calculateCheckoutFingerprint(input({ notes: null }))).not.toBe(
      calculateCheckoutFingerprint(input({ notes: 'Sin cebolla' })),
    );
  });

  describe('método de pago (6D.1)', () => {
    it('el mismo carrito con el mismo método produce la MISMA huella (reintento legítimo)', () => {
      expect(calculateCheckoutFingerprint(input({ payment_method: 'qr' }))).toBe(
        calculateCheckoutFingerprint(input({ payment_method: 'qr' })),
      );
    });

    it('cambiar de efectivo a QR cambia la huella (intención de checkout distinta)', () => {
      expect(calculateCheckoutFingerprint(input({ payment_method: 'cash' }))).not.toBe(
        calculateCheckoutFingerprint(input({ payment_method: 'qr' })),
      );
    });
  });
});
