import { describe, it, expect } from 'vitest';
import {
  buildCashPaymentText,
  orderCancelledByCustomerText,
  orderConfirmedByCashText,
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
 * EL PEDIDO EN EFECTIVO ESPERA UN "CONFIRMO" (05-09-2026).
 *
 * Durante un día este mensaje anunciaba que el pedido ya estaba en cocina.
 * Duró lo que tardaron dos clientes en enseñar que no era verdad: los dos
 * vieron el precio del envío en este mismo mensaje y dijeron que no —"muy caro
 * su moto", "cancelar pedido"— con el pedido ya en el grupo de reparto.
 *
 * Ahora pregunta, y lo que afirma se dice cuando el cliente contesta.
 */
describe('el aviso del pedido en EFECTIVO', () => {
  const CONFIRMACION = `📦 Pedido #26

Comida: Bs. 18
Delivery: Bs. 10
Total: Bs. 28`;
  const MONTOS = { subtotal: 18, deliveryAmount: 10 };

  it('le pide que confirme o cancele, con las dos palabras', () => {
    const text = buildCashPaymentText(CONFIRMACION, MONTOS);
    expect(text).toContain('¿Confirmás tu pedido?');
    expect(text).toContain('CONFIRMO');
    expect(text).toContain('CANCELAR');
  });

  it('NO afirma que el pedido esté en cocina: todavía no lo está', () => {
    const text = buildCashPaymentText(CONFIRMACION, MONTOS);
    expect(text).not.toContain('ya está confirmado');
    expect(text).not.toContain('pasa a cocina');
    // Y sigue sin decir que el pago está confirmado, que nunca lo estuvo.
    expect(text).not.toContain('Pago confirmado');
  });

  it('conserva la cifra, el desglose y el aviso del monto', () => {
    const text = buildCashPaymentText(CONFIRMACION, MONTOS);
    expect(text).toContain('💵 Pagas en EFECTIVO al recibir: Bs. 28');
    expect(text).toContain('(comida Bs. 18 + delivery Bs. 10)');
    expect(text).toContain('Ten el monto listo, por favor 🙌');
    expect(text).toContain('📦 Pedido #26');
  });

  it('la pregunta va al FINAL, después de lo que tiene que pagar', () => {
    // Primero lo que va a costarle, que es sobre lo que decide.
    const text = buildCashPaymentText(CONFIRMACION, MONTOS);
    expect(text.indexOf('¿Confirmás')).toBeGreaterThan(text.indexOf('Ten el monto listo'));
  });

  it('sin envío cotizado también se le pregunta', () => {
    const text = buildCashPaymentText(CONFIRMACION, undefined);
    expect(text).toContain('💵 Pagas en efectivo al recibir tu pedido.');
    expect(text).toContain('CONFIRMO');
  });

  /**
   * LA ADVERTENCIA VIAJA CON LA PREGUNTA (05-09-2026).
   *
   * En efectivo la comida y el viaje se ponen antes de cobrar: el pedido que
   * nadie recibe se pierde entero. Quien escribe CONFIRMO tiene que haber
   * leído qué pasa si después no abre la puerta, así que la advertencia va en
   * ESTE mensaje —el de la pregunta— y no en otro que quizá no llegue a leer.
   */
  it('advierte que no recibir el pedido bloquea al cliente', () => {
    const text = buildCashPaymentText(CONFIRMACION, MONTOS);
    expect(text).toContain('ADVERTENCIA');
    expect(text).toContain('BLOQUEADO');
    // Y va DESPUÉS de la pregunta: primero lo que se le pide, luego la letra
    // pequeña de esa misma palabra.
    expect(text.indexOf('ADVERTENCIA')).toBeGreaterThan(text.indexOf('¿Confirmás'));
  });

  it('también advierte cuando todavía no hay envío cotizado', () => {
    // Ahí el pedido igual sale de la cocina y viaja: el riesgo es el mismo.
    expect(buildCashPaymentText(CONFIRMACION, undefined)).toContain('ADVERTENCIA');
  });
});

/**
 * Y ESTO ES LO QUE RECIBE CUANDO CONFIRMA.
 *
 * El mensaje que el cliente en efectivo no recibía nunca, movido al momento en
 * que por fin es verdad.
 */
describe('la respuesta al CONFIRMO', () => {
  it('le dice que ya está en cocina y cuánto va a pagar', () => {
    const text = orderConfirmedByCashText('ORD-260904-040', 63, 'delivery');
    expect(text).toContain('#40');
    expect(text).toContain('ya está en cocina');
    expect(text).toContain('Bs. 63');
  });

  it('en delivery le avisa de que el repartidor lo va a llamar', () => {
    // La MISMA frase que recibe quien paga por QR, importada y no copiada.
    const text = orderConfirmedByCashText('ORD-260904-040', 63, 'delivery');
    expect(text).toContain(PAYMENT_ACCEPTED_NEXT.delivery);
  });

  it('en recojo le dice que lo esperamos, no que salga una moto', () => {
    const text = orderConfirmedByCashText('ORD-260904-040', 63, 'pickup');
    expect(text).toContain(PAYMENT_ACCEPTED_NEXT.pickup);
    expect(text).not.toContain(PAYMENT_ACCEPTED_NEXT.delivery);
  });

  it('sin saber cómo lo recibe, se calla la segunda frase', () => {
    const text = orderConfirmedByCashText('ORD-260904-040', 63);
    expect(text).toContain('ya está en cocina');
    expect(text).not.toContain(PAYMENT_ACCEPTED_NEXT.delivery);
    expect(text).not.toContain(PAYMENT_ACCEPTED_NEXT.pickup);
  });

  it('nunca dice "pago confirmado": ese cliente aún no ha pagado', () => {
    const text = orderConfirmedByCashText('ORD-260904-040', 63, 'delivery');
    expect(text).not.toContain('Pago confirmado');
  });
});

describe('el acuse de la cancelación', () => {
  it('cancela sin reproche y deja la puerta abierta', () => {
    const text = orderCancelledByCustomerText('ORD-260904-039');
    expect(text).toContain('#39');
    expect(text).toContain('cancelamos');
    expect(text).toContain('menú');
  });
});
