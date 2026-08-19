import { describe, it, expect } from 'vitest';
import { buildConfirmationText, buildQrPaymentCaption, type ConfirmationTextInput } from './notify-text';

const ITEMS = [
  { product_name_snapshot: 'La Fija', quantity: 2, subtotal: 80 },
  { product_name_snapshot: 'Coca Cola', quantity: 1, subtotal: 10 },
];

function input(overrides: Partial<ConfirmationTextInput> = {}): ConfirmationTextInput {
  return {
    order_number: 'ORD-000042',
    delivery_type: 'pickup',
    subtotal_amount: 90,
    total_amount: 90,
    items: ITEMS,
    ...overrides,
  };
}

function textOf(result: ReturnType<typeof buildConfirmationText>): string {
  if (!result.ok) throw new Error('se esperaba texto');
  return result.text;
}

describe('buildConfirmationText — pickup', () => {
  it('produce el formato exacto', () => {
    const text = textOf(buildConfirmationText(input({ delivery_type: 'pickup' })));
    expect(text).toBe(
      [
        '📦 ¡Recibí tu pedido ORD-000042!',
        '',
        'Tu pedido quedó confirmado para recoger en el local.',
        '',
        'Resumen:',
        '• 1x Coca Cola — Bs. 10',
        '• 2x La Fija — Bs. 80',
        '',
        'Total: Bs. 90',
      ].join('\n'),
    );
  });

  it('no menciona ubicación ni envío', () => {
    const text = textOf(buildConfirmationText(input({ delivery_type: 'pickup' })));
    expect(text).not.toContain('ubicación');
    expect(text).not.toContain('Envío');
  });
});

describe('buildConfirmationText — delivery', () => {
  it('produce el formato exacto', () => {
    const text = textOf(
      buildConfirmationText(input({ delivery_type: 'delivery', subtotal_amount: 90, total_amount: 90 })),
    );
    expect(text).toBe(
      [
        '📦 ¡Recibí tu pedido ORD-000042!',
        '',
        'Resumen:',
        '• 1x Coca Cola — Bs. 10',
        '• 2x La Fija — Bs. 80',
        '',
        'Subtotal: Bs. 90',
        'Envío: por confirmar',
        '',
        '📍 Ahora comparte tu ubicación para calcular el costo del envío.',
      ].join('\n'),
    );
  });

  it('usa subtotal_amount (no total_amount) en la línea de Subtotal', () => {
    const text = textOf(
      buildConfirmationText(
        input({ delivery_type: 'delivery', subtotal_amount: 90, total_amount: 105 }),
      ),
    );
    expect(text).toContain('Subtotal: Bs. 90');
    expect(text).not.toContain('Bs. 105');
  });
});

describe('buildConfirmationText — ítems y montos', () => {
  it('renderiza múltiples ítems, uno por línea', () => {
    const text = textOf(
      buildConfirmationText(
        input({
          items: [
            { product_name_snapshot: 'Ají de fideo', quantity: 1, subtotal: 35 },
            { product_name_snapshot: 'Brasa mixta', quantity: 3, subtotal: 120 },
            { product_name_snapshot: 'Coca Cola', quantity: 2, subtotal: 20 },
          ],
        }),
      ),
    );
    expect(text).toContain('• 1x Ají de fideo — Bs. 35');
    expect(text).toContain('• 3x Brasa mixta — Bs. 120');
    expect(text).toContain('• 2x Coca Cola — Bs. 20');
  });

  it('formatea montos con decimales usando formatBs', () => {
    const text = textOf(
      buildConfirmationText(
        input({
          delivery_type: 'pickup',
          items: [{ product_name_snapshot: 'Medio pollo', quantity: 1, subtotal: 40.5 }],
          total_amount: 40.5,
        }),
      ),
    );
    expect(text).toContain('• 1x Medio pollo — Bs. 40.5');
    expect(text).toContain('Total: Bs. 40.5');
  });

  it('el orden es determinístico e independiente del orden de entrada', () => {
    const a = textOf(buildConfirmationText(input({ items: [ITEMS[0], ITEMS[1]] })));
    const b = textOf(buildConfirmationText(input({ items: [ITEMS[1], ITEMS[0]] })));
    expect(a).toBe(b);
    // Orden por nombre snapshot: "Coca Cola" antes que "La Fija".
    expect(a.indexOf('Coca Cola')).toBeLessThan(a.indexOf('La Fija'));
  });

  it('desempata por cantidad y subtotal con nombres iguales', () => {
    const text = textOf(
      buildConfirmationText(
        input({
          items: [
            { product_name_snapshot: 'Combo', quantity: 3, subtotal: 60 },
            { product_name_snapshot: 'Combo', quantity: 1, subtotal: 20 },
          ],
        }),
      ),
    );
    expect(text.indexOf('• 1x Combo')).toBeLessThan(text.indexOf('• 3x Combo'));
  });
});

describe('buildConfirmationText — seguridad y pedido vacío', () => {
  it('pedido sin ítems devuelve resultado tipado, no excepción', () => {
    const result = buildConfirmationText(input({ items: [] }));
    expect(result).toEqual({ ok: false, reason: 'missing_items' });
  });

  it('no incluye teléfono, tokens, IDs internos ni wamid', () => {
    const text = textOf(buildConfirmationText(input({ delivery_type: 'delivery' })));
    const forbidden = [
      '59170000000',
      'wamid.',
      'token',
      'phone_number_id',
      '11111111-1111-4111-8111-111111111111',
      'session',
    ];
    for (const needle of forbidden) {
      expect(text.toLowerCase()).not.toContain(needle.toLowerCase());
    }
  });

  it('el texto solo se compone de número de pedido, nombres snapshot y montos', () => {
    const text = textOf(
      buildConfirmationText(
        input({
          delivery_type: 'pickup',
          order_number: 'ORD-000777',
          items: [{ product_name_snapshot: 'Pollo entero', quantity: 1, subtotal: 70 }],
          total_amount: 70,
        }),
      ),
    );
    expect(text).toContain('ORD-000777');
    expect(text).toContain('Pollo entero');
    expect(text).toContain('Bs. 70');
  });
});

describe('buildQrPaymentCaption (6D.1)', () => {
  it('conserva el texto de confirmación (con su número de pedido) y añade la indicación de QR', () => {
    const confirmation = '📦 ¡Recibí tu pedido ORD-000042!\nTotal: Bs. 90';
    const caption = buildQrPaymentCaption(confirmation);
    // El número de pedido sigue presente: es la clave de reconciliación en la caption.
    expect(caption).toContain('ORD-000042');
    expect(caption.startsWith(confirmation)).toBe(true);
    expect(caption).toContain('Escanea este QR para pagar');
  });
});
