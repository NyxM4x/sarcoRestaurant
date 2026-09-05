import { describe, it, expect } from 'vitest';
import {
  EMPTY_FORM_FIELDS,
  normalizeNotes,
  validateCheckoutForm,
  type CheckoutFormFields,
  type CheckoutItem,
} from './form';
import { MAX_CART_LINES, MAX_CUSTOMER_NAME_LENGTH, MAX_NOTES_LENGTH } from './limits';

function fields(overrides: Partial<CheckoutFormFields> = {}): CheckoutFormFields {
  return {
    customer_name: 'Juan García',
    delivery_type: 'delivery',
    payment_method: 'cash',
    notes: 'Sin cebolla',
    ...overrides,
  };
}

const ITEMS: CheckoutItem[] = [{ code: 'la_fija', quantity: 1 }];

describe('normalizeNotes', () => {
  it('null se mantiene null', () => {
    expect(normalizeNotes(null)).toBeNull();
  });

  it('undefined se convierte en null', () => {
    expect(normalizeNotes(undefined)).toBeNull();
  });

  it('cadena vacía se convierte en null', () => {
    expect(normalizeNotes('')).toBeNull();
  });

  it('solo espacios se convierte en null', () => {
    expect(normalizeNotes('    ')).toBeNull();
  });

  it('recorta los espacios exteriores', () => {
    expect(normalizeNotes('  Sin cebolla  ')).toBe('Sin cebolla');
  });
});

describe('validateCheckoutForm — casos válidos', () => {
  it('acepta un formulario completo', () => {
    const result = validateCheckoutForm(fields(), ITEMS);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        customer_name: 'Juan García',
        delivery_type: 'delivery',
        payment_method: 'cash',
        notes: 'Sin cebolla',
        items: [{ code: 'la_fija', quantity: 1 }],
        // Sin combos en el carrito, la lista viaja vacía pero SÍ existe: el
        // servidor distingue "no hay promociones" de "no se envió el campo".
        promotions: [],
      });
    }
  });

  it('acepta pickup', () => {
    const result = validateCheckoutForm(fields({ delivery_type: 'pickup' }), ITEMS);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.delivery_type).toBe('pickup');
  });

  it('acepta exactamente 20 líneas', () => {
    const items = Array.from({ length: MAX_CART_LINES }, (_, i) => ({
      code: `p_${i}`,
      quantity: 1,
    }));
    expect(validateCheckoutForm(fields(), items).ok).toBe(true);
  });

  it('acepta cantidad 10', () => {
    expect(validateCheckoutForm(fields(), [{ code: 'la_fija', quantity: 10 }]).ok).toBe(true);
  });
});

describe('validateCheckoutForm — normalización', () => {
  it('recorta el nombre', () => {
    const result = validateCheckoutForm(fields({ customer_name: '   Juan García   ' }), ITEMS);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.customer_name).toBe('Juan García');
  });

  it('notas vacías quedan en null', () => {
    const result = validateCheckoutForm(fields({ notes: '' }), ITEMS);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.notes).toBeNull();
  });

  it('notas de solo espacios quedan en null', () => {
    const result = validateCheckoutForm(fields({ notes: '     ' }), ITEMS);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.notes).toBeNull();
  });

  it('recorta los códigos del carrito', () => {
    const result = validateCheckoutForm(fields(), [{ code: '  la_fija  ', quantity: 2 }]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.items[0].code).toBe('la_fija');
  });
});

describe('validateCheckoutForm — nombre', () => {
  it('rechaza nombre vacío', () => {
    const result = validateCheckoutForm(fields({ customer_name: '' }), ITEMS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.customer_name).toBeTruthy();
  });

  it('rechaza nombre de solo espacios', () => {
    const result = validateCheckoutForm(fields({ customer_name: '   ' }), ITEMS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.customer_name).toBeTruthy();
  });

  it('acepta exactamente 100 caracteres', () => {
    expect(validateCheckoutForm(fields({ customer_name: 'a'.repeat(100) }), ITEMS).ok).toBe(true);
  });

  it('rechaza 101 caracteres', () => {
    const result = validateCheckoutForm(fields({ customer_name: 'a'.repeat(101) }), ITEMS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.customer_name).toContain(String(MAX_CUSTOMER_NAME_LENGTH));
  });

  it('el largo se mide después de recortar', () => {
    const name = `  ${'a'.repeat(100)}  `;
    expect(validateCheckoutForm(fields({ customer_name: name }), ITEMS).ok).toBe(true);
  });
});

describe('validateCheckoutForm — tipo de entrega', () => {
  it('rechaza null', () => {
    const result = validateCheckoutForm(fields({ delivery_type: null }), ITEMS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.delivery_type).toBeTruthy();
  });

  it('rechaza un valor fuera del enum', () => {
    const result = validateCheckoutForm(
      fields({ delivery_type: 'express' as never }),
      ITEMS,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.delivery_type).toBeTruthy();
  });
});

describe('validateCheckoutForm — notas', () => {
  it('acepta exactamente 500 caracteres', () => {
    expect(validateCheckoutForm(fields({ notes: 'a'.repeat(500) }), ITEMS).ok).toBe(true);
  });

  it('rechaza 501 caracteres', () => {
    const result = validateCheckoutForm(fields({ notes: 'a'.repeat(501) }), ITEMS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.notes).toContain(String(MAX_NOTES_LENGTH));
  });
});

describe('validateCheckoutForm — carrito', () => {
  it('rechaza carrito vacío', () => {
    const result = validateCheckoutForm(fields(), []);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.items).toBeTruthy();
  });

  it('rechaza más de 20 líneas', () => {
    const items = Array.from({ length: 21 }, (_, i) => ({ code: `p_${i}`, quantity: 1 }));
    const result = validateCheckoutForm(fields(), items);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.items).toBeTruthy();
  });

  it('rechaza código vacío tras recortar', () => {
    const result = validateCheckoutForm(fields(), [{ code: '   ', quantity: 1 }]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.items).toBeTruthy();
  });

  it('rechaza cantidad 0', () => {
    const result = validateCheckoutForm(fields(), [{ code: 'la_fija', quantity: 0 }]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.items).toBeTruthy();
  });

  it('rechaza cantidad 11', () => {
    const result = validateCheckoutForm(fields(), [{ code: 'la_fija', quantity: 11 }]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.items).toBeTruthy();
  });

  it('rechaza cantidad decimal', () => {
    const result = validateCheckoutForm(fields(), [{ code: 'la_fija', quantity: 1.5 }]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.items).toBeTruthy();
  });

  it('rechaza códigos duplicados tras recortar', () => {
    const result = validateCheckoutForm(fields(), [
      { code: 'la_fija', quantity: 1 },
      { code: '  la_fija  ', quantity: 2 },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.items).toBeTruthy();
  });
});

describe('validateCheckoutForm — errores acumulados', () => {
  it('devuelve todos los errores en una sola pasada', () => {
    const result = validateCheckoutForm(
      { customer_name: '', delivery_type: null, payment_method: null, notes: 'a'.repeat(501) },
      [],
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.customer_name).toBeTruthy();
      expect(result.errors.delivery_type).toBeTruthy();
      expect(result.errors.notes).toBeTruthy();
      expect(result.errors.items).toBeTruthy();
    }
  });

  it('el formulario vacío inicial no valida', () => {
    expect(validateCheckoutForm(EMPTY_FORM_FIELDS, ITEMS).ok).toBe(false);
  });
});

describe('validateCheckoutForm — método de pago (6D.1)', () => {
  it('acepta cash y qr', () => {
    expect(validateCheckoutForm(fields({ payment_method: 'cash' }), ITEMS).ok).toBe(true);
    expect(validateCheckoutForm(fields({ payment_method: 'qr' }), ITEMS).ok).toBe(true);
  });

  it('sin método de pago devuelve error de payment_method', () => {
    const result = validateCheckoutForm(fields({ payment_method: null }), ITEMS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.payment_method).toBeTruthy();
  });

  it('el método normalizado llega al valor', () => {
    const result = validateCheckoutForm(fields({ payment_method: 'qr' }), ITEMS);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.payment_method).toBe('qr');
  });
});

/**
 * EL MÉTODO DE PAGO VUELVE A SER UNA PREGUNTA (04-09-2026).
 *
 * Se había forzado a `'qr'` el 27-08 porque no había nada que decidir. Hoy hay
 * clientes pidiendo pagar en efectivo, así que el formulario vuelve a exigir
 * una respuesta antes de dejar confirmar.
 */
describe('método de pago: hay que elegirlo', () => {
  it('el formulario vacío no nace con el pago resuelto', () => {
    expect(EMPTY_FORM_FIELDS.payment_method).toBeNull();
  });

  it('sin elegir método, el pedido no se puede confirmar', () => {
    const res = validateCheckoutForm(
      { ...EMPTY_FORM_FIELDS, customer_name: 'Ana', delivery_type: 'pickup' },
      ITEMS,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.payment_method).toBeTruthy();
  });

  it('efectivo es una respuesta válida, como el QR', () => {
    for (const metodo of ['cash', 'qr'] as const) {
      const res = validateCheckoutForm(
        { ...EMPTY_FORM_FIELDS, customer_name: 'Ana', delivery_type: 'pickup', payment_method: metodo },
        ITEMS,
      );
      expect(res.ok, metodo).toBe(true);
    }
  });
});
