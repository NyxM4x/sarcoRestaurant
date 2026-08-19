import { describe, it, expect } from 'vitest';
import { createWebOrderSchema } from './web-schema';

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_token: 'token-opaco-base64url',
    customer_name: 'Juan García',
    delivery_type: 'delivery',
    payment_method: 'cash',
    notes: 'Sin cebolla',
    items: [{ code: 'la_fija', quantity: 1 }],
    ...overrides,
  };
}

describe('createWebOrderSchema', () => {
  describe('body válido', () => {
    it('acepta un body completo', () => {
      const parsed = createWebOrderSchema.safeParse(body());
      expect(parsed.success).toBe(true);
    });

    it('acepta el body sin notas', () => {
      const parsed = createWebOrderSchema.safeParse(body({ notes: undefined }));
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data.notes).toBeNull();
    });

    it('acepta pickup', () => {
      const parsed = createWebOrderSchema.safeParse(body({ delivery_type: 'pickup' }));
      expect(parsed.success).toBe(true);
    });

    it('acepta 20 líneas', () => {
      const items = Array.from({ length: 20 }, (_, i) => ({ code: `p_${i}`, quantity: 1 }));
      expect(createWebOrderSchema.safeParse(body({ items })).success).toBe(true);
    });
  });

  describe('normalización', () => {
    it('recorta el nombre', () => {
      const parsed = createWebOrderSchema.safeParse(body({ customer_name: '  Juan García  ' }));
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data.customer_name).toBe('Juan García');
    });

    it('recorta los códigos', () => {
      const parsed = createWebOrderSchema.safeParse(
        body({ items: [{ code: '  la_fija  ', quantity: 2 }] }),
      );
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data.items[0].code).toBe('la_fija');
    });

    it('normaliza notas vacías a null', () => {
      const parsed = createWebOrderSchema.safeParse(body({ notes: '' }));
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data.notes).toBeNull();
    });

    it('normaliza notas solo con espacios a null', () => {
      const parsed = createWebOrderSchema.safeParse(body({ notes: '    ' }));
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data.notes).toBeNull();
    });

    it('normaliza notas null a null', () => {
      const parsed = createWebOrderSchema.safeParse(body({ notes: null }));
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data.notes).toBeNull();
    });
  });

  describe('session_token', () => {
    it('rechaza token vacío', () => {
      expect(createWebOrderSchema.safeParse(body({ session_token: '' })).success).toBe(false);
    });

    it('rechaza token ausente', () => {
      expect(createWebOrderSchema.safeParse(body({ session_token: undefined })).success).toBe(false);
    });
  });

  describe('customer_name', () => {
    it('rechaza nombre vacío', () => {
      expect(createWebOrderSchema.safeParse(body({ customer_name: '' })).success).toBe(false);
    });

    it('rechaza nombre que queda vacío tras recortar', () => {
      expect(createWebOrderSchema.safeParse(body({ customer_name: '   ' })).success).toBe(false);
    });

    it('rechaza nombre de más de 100 caracteres', () => {
      expect(createWebOrderSchema.safeParse(body({ customer_name: 'a'.repeat(101) })).success).toBe(
        false,
      );
    });

    it('acepta nombre de exactamente 100 caracteres', () => {
      expect(createWebOrderSchema.safeParse(body({ customer_name: 'a'.repeat(100) })).success).toBe(
        true,
      );
    });
  });

  describe('delivery_type', () => {
    it('rechaza un valor fuera del enum', () => {
      expect(createWebOrderSchema.safeParse(body({ delivery_type: 'express' })).success).toBe(false);
    });

    it('rechaza delivery_type ausente', () => {
      expect(createWebOrderSchema.safeParse(body({ delivery_type: undefined })).success).toBe(false);
    });
  });

  describe('notes', () => {
    it('rechaza notas de más de 500 caracteres', () => {
      expect(createWebOrderSchema.safeParse(body({ notes: 'a'.repeat(501) })).success).toBe(false);
    });

    it('acepta notas de exactamente 500 caracteres', () => {
      expect(createWebOrderSchema.safeParse(body({ notes: 'a'.repeat(500) })).success).toBe(true);
    });
  });

  describe('items', () => {
    it('rechaza carrito vacío', () => {
      expect(createWebOrderSchema.safeParse(body({ items: [] })).success).toBe(false);
    });

    it('rechaza más de 20 líneas', () => {
      const items = Array.from({ length: 21 }, (_, i) => ({ code: `p_${i}`, quantity: 1 }));
      expect(createWebOrderSchema.safeParse(body({ items })).success).toBe(false);
    });

    it('rechaza código vacío', () => {
      expect(
        createWebOrderSchema.safeParse(body({ items: [{ code: '', quantity: 1 }] })).success,
      ).toBe(false);
    });

    it('rechaza código que queda vacío tras recortar', () => {
      expect(
        createWebOrderSchema.safeParse(body({ items: [{ code: '   ', quantity: 1 }] })).success,
      ).toBe(false);
    });

    it('rechaza códigos duplicados', () => {
      const parsed = createWebOrderSchema.safeParse(
        body({
          items: [
            { code: 'la_fija', quantity: 1 },
            { code: 'la_fija', quantity: 2 },
          ],
        }),
      );
      expect(parsed.success).toBe(false);
    });

    it('rechaza códigos duplicados tras recortar', () => {
      const parsed = createWebOrderSchema.safeParse(
        body({
          items: [
            { code: 'la_fija', quantity: 1 },
            { code: '  la_fija  ', quantity: 2 },
          ],
        }),
      );
      expect(parsed.success).toBe(false);
    });

    it('rechaza cantidad decimal', () => {
      expect(
        createWebOrderSchema.safeParse(body({ items: [{ code: 'la_fija', quantity: 1.5 }] })).success,
      ).toBe(false);
    });

    it('rechaza cantidad menor a 1', () => {
      expect(
        createWebOrderSchema.safeParse(body({ items: [{ code: 'la_fija', quantity: 0 }] })).success,
      ).toBe(false);
    });

    it('rechaza cantidad negativa', () => {
      expect(
        createWebOrderSchema.safeParse(body({ items: [{ code: 'la_fija', quantity: -2 }] })).success,
      ).toBe(false);
    });

    it('rechaza cantidad mayor a 10', () => {
      expect(
        createWebOrderSchema.safeParse(body({ items: [{ code: 'la_fija', quantity: 11 }] })).success,
      ).toBe(false);
    });

    it('rechaza cantidad como string', () => {
      expect(
        createWebOrderSchema.safeParse(body({ items: [{ code: 'la_fija', quantity: '2' }] })).success,
      ).toBe(false);
    });

    it('rechaza un item que no es objeto', () => {
      expect(createWebOrderSchema.safeParse(body({ items: ['la_fija'] })).success).toBe(false);
    });

    it('rechaza campos desconocidos dentro de un item', () => {
      expect(
        createWebOrderSchema.safeParse(
          body({ items: [{ code: 'la_fija', quantity: 1, price: 22 }] }),
        ).success,
      ).toBe(false);
    });
  });

  describe('rechazo de campos que el cliente no puede enviar', () => {
    const camposProhibidos: Array<[string, unknown]> = [
      ['customer_phone', '59170000000'],
      ['phone_number_id', 'phone-123'],
      ['menu_session_id', '00000000-0000-4000-8000-000000000000'],
      ['checkout_fingerprint', 'a'.repeat(64)],
      ['price', 22],
      ['subtotal_amount', 40],
      ['delivery_amount', 10],
      ['total_amount', 50],
      ['status', 'confirmed'],
      ['order_number', 'ORD-000123'],
      ['currency', 'BOB'],
    ];

    for (const [campo, valor] of camposProhibidos) {
      it(`rechaza ${campo}`, () => {
        const parsed = createWebOrderSchema.safeParse(body({ [campo]: valor }));
        expect(parsed.success).toBe(false);
      });
    }
  });

  describe('body malformado', () => {
    it('rechaza null', () => {
      expect(createWebOrderSchema.safeParse(null).success).toBe(false);
    });

    it('rechaza un array', () => {
      expect(createWebOrderSchema.safeParse([]).success).toBe(false);
    });

    it('rechaza un string', () => {
      expect(createWebOrderSchema.safeParse('la_fija').success).toBe(false);
    });
  });

  describe('payment_method (6D.1)', () => {
    it('acepta cash y qr', () => {
      const cash = createWebOrderSchema.safeParse(body({ payment_method: 'cash' }));
      expect(cash.success).toBe(true);
      if (cash.success) expect(cash.data.payment_method).toBe('cash');
      const qr = createWebOrderSchema.safeParse(body({ payment_method: 'qr' }));
      expect(qr.success).toBe(true);
      if (qr.success) expect(qr.data.payment_method).toBe('qr');
    });

    it('rechaza un método inválido', () => {
      expect(createWebOrderSchema.safeParse(body({ payment_method: 'card' })).success).toBe(false);
      expect(createWebOrderSchema.safeParse(body({ payment_method: 'CASH' })).success).toBe(false);
    });

    it('rechaza un body SIN método de pago (obligatorio en web)', () => {
      expect(createWebOrderSchema.safeParse(body({ payment_method: undefined })).success).toBe(false);
    });
  });
});
