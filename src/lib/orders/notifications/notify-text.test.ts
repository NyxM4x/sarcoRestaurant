import { describe, it, expect } from 'vitest';
import {
  buildCashPaymentText,
  buildConfirmationText,
  buildQrPaymentCaption,
  type ConfirmationTextInput,
} from './notify-text';
import { PAYMENT_ACCEPTED_NEXT } from '@/lib/payment-proof/notify-text';

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

describe('por QR se cobra la comida; el envío se paga al recibir', () => {
  /**
   * El desglose del mensaje trae tres cifras, y la instrucción tenía que decir
   * CUÁL se transfiere. Diciendo solo "paga tu pedido" junto a un "Total: Bs 64"
   * el cliente transfiere 64, que es lo que pasaba.
   *
   * Que la advertencia viaje en el MISMO mensaje que el QR es lo que permite
   * responder "se te avisó" cuando alguien discute el cobro del envío en la
   * puerta. Un segundo mensaje podría no llegar.
   */
  const CONFIRMACION = '📦 Pedido ORD-000019\n\nComida: Bs. 48\nDelivery: Bs. 16\nTotal: Bs. 64';

  it('dice el importe exacto a transferir, sin obligar a deducirlo del desglose', () => {
    const caption = buildQrPaymentCaption(CONFIRMACION, { dueByQr: 48, deliveryAmount: 16 });

    expect(caption).toContain('SOLO la comida');
    expect(caption).toContain('Bs. 48');
    expect(caption).toContain('Bs. 16');
    expect(caption).toContain('al recibir tu pedido');
    // Y el desglose de arriba se conserva intacto: el cliente sigue sabiendo
    // cuánto le va a costar el pedido entero.
    expect(caption.startsWith(CONFIRMACION)).toBe(true);
    expect(caption).toContain('ORD-000019');
  });

  it('sin envío que cobrar aparte, el texto vuelve al simple de siempre', () => {
    // Recojo, o un delivery con envío gratis: no hay nada que explicar, y una
    // frase sobre pagar el delivery "al recibir" solo confundiría.
    const caption = buildQrPaymentCaption(CONFIRMACION, { dueByQr: 48, deliveryAmount: 0 });
    expect(caption).toContain('Escanea este QR para pagar tu pedido');
    expect(caption).not.toContain('SOLO la comida');
  });

  it('sin montos se comporta como antes: los históricos no cambian', () => {
    expect(buildQrPaymentCaption(CONFIRMACION)).toContain('Escanea este QR para pagar tu pedido');
  });
});

/**
 * EL PEDIDO EN EFECTIVO YA ESTÁ ANOTADO, Y HAY QUE DECÍRSELO (05-09-2026).
 *
 * Quien paga por QR recibe "Pago confirmado ✅. Tu pedido está siendo preparado.
 * El delivery tiene tu número…" en cuanto alguien acepta su comprobante. Ese
 * aviso lo dispara la REVISIÓN del comprobante, y un pedido en efectivo no tiene
 * ninguno que revisar: no salía nunca. El cliente leía su total y se quedaba sin
 * saber si su pedido había quedado anotado — y el que duda vuelve a escribir o
 * arma otro pedido, que es lo que pasó con el #26.
 */
describe('el aviso del pedido en EFECTIVO', () => {
  // El mensaje real del #26, tal como lo recibió el cliente.
  const CONFIRMACION = `📦 Pedido #26

Comida: Bs. 18
Delivery: Bs. 10
Total: Bs. 28`;
  const MONTOS = { subtotal: 18, deliveryAmount: 10 };

  it('le dice que su pedido quedó confirmado', () => {
    const text = buildCashPaymentText(CONFIRMACION, MONTOS, 'delivery');
    expect(text).toContain('Tu pedido ya está confirmado');
  });

  it('en delivery le avisa de que el repartidor lo va a llamar', () => {
    // La MISMA frase que recibe quien paga por QR, importada y no copiada.
    const text = buildCashPaymentText(CONFIRMACION, MONTOS, 'delivery');
    expect(text).toContain(PAYMENT_ACCEPTED_NEXT.delivery);
  });

  it('en recojo le dice que lo esperamos, no que salga una moto', () => {
    const text = buildCashPaymentText(CONFIRMACION, undefined, 'pickup');
    expect(text).toContain(PAYMENT_ACCEPTED_NEXT.pickup);
    expect(text).not.toContain(PAYMENT_ACCEPTED_NEXT.delivery);
  });

  it('NUNCA dice que el pago está confirmado: ese cliente no ha pagado nada', () => {
    // Es la línea que separa este aviso del del QR. Decirle "pago confirmado" a
    // quien va a pagar en la puerta es prometerle algo que no ha ocurrido.
    for (const tipo of ['delivery', 'pickup'] as const) {
      const text = buildCashPaymentText(CONFIRMACION, MONTOS, tipo);
      expect(text, tipo).not.toContain('Pago confirmado');
    }
  });

  it('sin saber cómo lo recibe, se calla la segunda frase', () => {
    // Mismo criterio que `paymentDecisionText`: antes eso que decirle que espere
    // en la puerta a quien iba a pasar a buscarlo.
    const text = buildCashPaymentText(CONFIRMACION, MONTOS);
    expect(text).toContain('Tu pedido ya está confirmado');
    expect(text).not.toContain(PAYMENT_ACCEPTED_NEXT.delivery);
    expect(text).not.toContain(PAYMENT_ACCEPTED_NEXT.pickup);
  });

  it('conserva lo que ya decía: la cifra, el desglose y el aviso del monto', () => {
    const text = buildCashPaymentText(CONFIRMACION, MONTOS, 'delivery');
    expect(text).toContain('💵 Pagas en EFECTIVO al recibir: Bs. 28');
    expect(text).toContain('(comida Bs. 18 + delivery Bs. 10)');
    expect(text).toContain('Ten el monto listo, por favor 🙌');
    expect(text).toContain('📦 Pedido #26');
  });

  it('sin envío cotizado también queda confirmado', () => {
    // La rama corta —recojo, o un delivery aún sin cotizar— tenía el mismo
    // agujero: decía cómo se paga y nada sobre el pedido.
    const text = buildCashPaymentText(CONFIRMACION, undefined, 'delivery');
    expect(text).toContain('💵 Pagas en efectivo al recibir tu pedido.');
    expect(text).toContain('Tu pedido ya está confirmado');
  });

  it('la confirmación va al FINAL, después de lo que tiene que pagar', () => {
    // Primero lo que le toca hacer, después la tranquilidad.
    const text = buildCashPaymentText(CONFIRMACION, MONTOS, 'delivery');
    expect(text.indexOf('Tu pedido ya está confirmado')).toBeGreaterThan(
      text.indexOf('Ten el monto listo'),
    );
  });
});
