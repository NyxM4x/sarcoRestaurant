import { orderReviewKeptText, orderReviewText } from './messages';
import { describe, it, expect } from 'vitest';
import {
  buildImagePayload,
  buildLocationRequestPayload,
  buildMenuCtaPayload,
  buildTextPayload,
  buildWebLocationRequestBodyText,
  LOCATION_HOW_TO_TEXT,
  LOCATION_REQUEST_BODY_TEXT,
  MENU_CTA_BODY_TEXT,
  menuCtaBodyText,
  PAYMENT_QR_URL,
} from './messages';
import { businessHoursClock } from '@/lib/agent/business/facts';

const WEB_LOCATION_REQUEST_BODY_TEXT = buildWebLocationRequestBodyText('ORD-000042');

describe('buildTextPayload', () => {
  it('construye un payload de texto válido para WhatsApp Cloud', () => {
    const payload = buildTextPayload('59170000001', 'Hola 👋');
    expect(payload).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '59170000001',
      type: 'text',
      text: { body: 'Hola 👋' },
    });
  });

  it('no incluye preview_url', () => {
    const payload = buildTextPayload('59170000001', 'Sin preview');
    expect('preview_url' in payload.text).toBe(false);
    expect(Object.keys(payload.text)).toEqual(['body']);
  });

  it('conserva el texto verbatim, incluidos saltos de línea', () => {
    const multiline = '📦 ¡Recibí tu pedido ORD-000001!\nResumen:\n• 2x La Fija — Bs. 80\nTotal: Bs. 80';
    const payload = buildTextPayload('59170000001', multiline);
    expect(payload.text.body).toBe(multiline);
  });

  it('rechaza texto vacío', () => {
    expect(() => buildTextPayload('59170000001', '')).toThrow();
  });

  it('rechaza texto compuesto solo por espacios', () => {
    expect(() => buildTextPayload('59170000001', '   \n\t ')).toThrow();
  });
});

describe('buildLocationRequestPayload', () => {
  it('sin bodyText usa el copy del WhatsApp Flow más las instrucciones', () => {
    const payload = buildLocationRequestPayload('59170000001');
    expect(payload).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '59170000001',
      type: 'text',
      text: { body: `${LOCATION_REQUEST_BODY_TEXT}

${LOCATION_HOW_TO_TEXT}` },
    });
    // Blindaje del copy por defecto: no debe cambiar.
    expect(LOCATION_REQUEST_BODY_TEXT).toBe(
      'Por favor comparte tu ubicación actual para coordinar el delivery.',
    );
  });

  it('ya NO manda el botón interactivo', () => {
    // El botón `send_location` daba problemas en el último paso del flujo. Se
    // puede quitar porque el pin sin contexto ya lo recoge `attachLooseLocation`
    // y lo adjunta al pedido que estaba esperando ubicación.
    const serializado = JSON.stringify(buildLocationRequestPayload('59170000001'));
    expect(serializado).not.toContain('interactive');
    expect(serializado).not.toContain('location_request_message');
    expect(serializado).not.toContain('send_location');
  });

  it('con el copy web cambia solo el texto de delante', () => {
    const payload = buildLocationRequestPayload('59170000001', WEB_LOCATION_REQUEST_BODY_TEXT);
    expect(payload.text.body).toBe(`${WEB_LOCATION_REQUEST_BODY_TEXT}

${LOCATION_HOW_TO_TEXT}`);
  });

  it('las instrucciones van en LOS DOS caminos, no solo en el web', () => {
    // Se añaden en el builder y no en cada copy justamente para esto: un camino
    // nuevo no puede nacer sin ellas.
    for (const payload of [
      buildLocationRequestPayload('59170000001'),
      buildLocationRequestPayload('59170000001', WEB_LOCATION_REQUEST_BODY_TEXT),
    ]) {
      expect(payload.type).toBe('text');
      expect(payload.text.body).toContain('ENVIAR UBICACIÓN ACTUAL');
    }
  });

  it('rechaza bodyText explícito vacío o de solo espacios', () => {
    expect(() => buildLocationRequestPayload('59170000001', '')).toThrow();
    expect(() => buildLocationRequestPayload('59170000001', '   \n\t ')).toThrow();
  });
});

describe('buildWebLocationRequestBodyText', () => {
  it('produce el copy exacto con el número de pedido', () => {
    expect(buildWebLocationRequestBodyText('ORD-000006')).toBe(
      '📍 Pedido ORD-000006: envíame tu ubicación GPS, por favor, para calcular el costo del envío 😊',
    );
  });

  it('incluye exactamente el order_number recibido, sin fijarlo', () => {
    expect(buildWebLocationRequestBodyText('ORD-000123')).toContain('ORD-000123');
    expect(buildWebLocationRequestBodyText('ORD-000123')).not.toContain('ORD-000006');
  });

  it('no incluye order_id, teléfono ni otros datos', () => {
    const text = buildWebLocationRequestBodyText('ORD-000042');
    for (const forbidden of [
      '22222222-2222-4222-8222-222222222222',
      '59170000000',
      'pnid',
      'token',
    ]) {
      expect(text).not.toContain(forbidden);
    }
  });

  it('no altera el copy del WhatsApp Flow', () => {
    // El flujo del Flow no pasa bodyText: conserva su texto original, con las
    // instrucciones detrás y sin nada del pedido.
    const flow = buildLocationRequestPayload('59170000001');
    expect(flow.text.body).toContain(LOCATION_REQUEST_BODY_TEXT);
    expect(flow.text.body).not.toContain('Pedido');
    expect(flow.text.body).not.toContain('ORD-');
  });
});

describe('buildImagePayload (6D.1)', () => {
  it('construye un payload de imagen por enlace con caption', () => {
    const payload = buildImagePayload('59170000001', PAYMENT_QR_URL, 'Pedido ORD-000042: paga con QR');
    expect(payload).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '59170000001',
      type: 'image',
      image: { link: PAYMENT_QR_URL, caption: 'Pedido ORD-000042: paga con QR' },
    });
  });

  it('lanza si la URL o el caption están vacíos', () => {
    expect(() => buildImagePayload('59170000001', '', 'x')).toThrow();
    expect(() => buildImagePayload('59170000001', PAYMENT_QR_URL, '  ')).toThrow();
  });

  it('PAYMENT_QR_URL es la URL pública https del QR fijo', () => {
    expect(PAYMENT_QR_URL).toBe('https://sarco-restaurant.vercel.app/payment/qr-2026.jpeg');
  });
});

describe('el cuerpo del botón según POR QUÉ se manda el menú', () => {
  /**
   * Un `send_menu` confirmado cierra el turno en silencio, así que este mensaje
   * es la ÚNICA ocasión de explicarle el cambio al cliente. Por eso el copy vive
   * aquí y no en el prompt: llega siempre igual de bien escrito, el modelo no
   * puede estropearlo y no cuesta un token.
   */
  const MOTIVOS = ['explicit_request', 'explicit_resend', 'agent_suggestion', 'qa_trigger'] as const;

  it('cada motivo tiene su texto, y ninguno viene vacío', () => {
    for (const motivo of MOTIVOS) {
      expect(menuCtaBodyText(motivo).trim(), motivo).not.toBe('');
    }
  });

  it('quien PIDE el menú recibe el saludo con el horario', () => {
    // Escribir "menu" en frío es el primer contacto típico: es cuando el horario
    // vale de algo.
    const texto = menuCtaBodyText('explicit_request');
    expect(texto).toBe(MENU_CTA_BODY_TEXT);
    expect(texto).toContain(businessHoursClock());
  });

  it('a quien NO lo pidió no se le repite el horario', () => {
    // Ya está en conversación: repetirlo gasta líneas de un mensaje que se lee
    // de un vistazo.
    for (const motivo of ['agent_suggestion', 'explicit_resend'] as const) {
      expect(menuCtaBodyText(motivo), motivo).not.toContain(businessHoursClock());
    }
  });

  it('el reenvío no vuelve a explicar cómo se pide', () => {
    // "No me llegó" es un problema técnico, no de comprensión. Explicárselo otra
    // vez sería tratarlo de torpe.
    expect(menuCtaBodyText('explicit_resend')).toContain('de nuevo');
  });

  it('la prueba interna usa el texto de siempre', () => {
    expect(menuCtaBodyText('qa_trigger')).toBe(MENU_CTA_BODY_TEXT);
  });

  it('todos caben de sobra en el límite de WhatsApp', () => {
    // El body de un interactivo admite 1024 caracteres.
    for (const motivo of MOTIVOS) {
      expect(menuCtaBodyText(motivo).length, motivo).toBeLessThanOrEqual(1024);
    }
  });

  it('ninguno usa markdown ni amontona emojis', () => {
    // WhatsApp no renderiza markdown, y el exceso de emoji abarata el mensaje.
    for (const motivo of MOTIVOS) {
      const texto = menuCtaBodyText(motivo);
      expect(texto, motivo).not.toMatch(/[*_`#]/);
      expect([...texto].filter((c) => /\p{Extended_Pictographic}/u.test(c)).length, motivo)
        .toBeLessThanOrEqual(1);
    }
  });

  it('el payload lleva el cuerpo que se le pase, no la constante', () => {
    const payload = buildMenuCtaPayload('59170000001', undefined, undefined, 'texto elegido');
    expect(payload.interactive.body.text).toBe('texto elegido');
    // Y sin él, el de siempre: un llamador antiguo se comporta igual que antes.
    expect(buildMenuCtaPayload('59170000001').interactive.body.text).toBe(MENU_CTA_BODY_TEXT);
  });
});

/**
 * "TU PEDIDO QUEDÓ ASÍ" (05-09-2026).
 *
 * El desglose es el dato que el cliente no tenía: sabía su total, no qué lo
 * compone, y desde el chat no hay forma de mirarlo porque el menú ya se cerró.
 */
describe('la pregunta con el pedido delante', () => {
  const LINEAS = [
    { name: 'Trancapecho', quantity: 1, subtotal: 18 },
    { name: 'Gaseosa 2 L', quantity: 2, subtotal: 20 },
  ];

  it('enseña cada línea con su cantidad y su importe', () => {
    const text = orderReviewText({
      orderNumber: 'ORD-260904-026',
      lines: LINEAS,
      deliveryAmount: 10,
      totalAmount: 48,
      isCash: true,
    });
    expect(text).toContain('1x Trancapecho');
    expect(text).toContain('2x Gaseosa 2 L');
    expect(text).toContain('Bs. 18');
  });

  it('lleva el envío y el total, y cómo se paga', () => {
    const text = orderReviewText({
      orderNumber: 'ORD-260904-026',
      lines: LINEAS,
      deliveryAmount: 10,
      totalAmount: 48,
      isCash: true,
    });
    expect(text).toContain('Envío: Bs. 10');
    expect(text).toContain('Total: Bs. 48');
    expect(text).toContain('efectivo al recibir');
  });

  it('sin envío cotizado no escribe "Envío: Bs. 0"', () => {
    // En `awaiting_location` todavía no existe, y un cero se lee como gratis.
    const text = orderReviewText({
      orderNumber: 'ORD-260904-026',
      lines: LINEAS,
      deliveryAmount: 0,
      totalAmount: 38,
      isCash: false,
    });
    expect(text).not.toContain('Envío');
  });

  it('pregunta en el sentido que hace legible un "no"', () => {
    // "¿Querés agregar algo más?" y no "¿está bien tu pedido?": es lo que hace
    // que un "no" suelto signifique una sola cosa. Ver `order-review-reply`.
    const text = orderReviewText({
      orderNumber: 'ORD-260904-026',
      lines: LINEAS,
      deliveryAmount: 10,
      totalAmount: 48,
      isCash: true,
    });
    expect(text).toContain('¿Querés agregar algo más?');
    expect(text).toContain('1');
    expect(text).toContain('2');
  });

  it('el cliente ve su número corto, no el interno', () => {
    const text = orderReviewText({
      orderNumber: 'ORD-260904-026',
      lines: LINEAS,
      deliveryAmount: 10,
      totalAmount: 48,
      isCash: true,
    });
    expect(text).toContain('#26');
    expect(text).not.toContain('260904');
  });
});

describe('el cierre: "queda así"', () => {
  it('en efectivo le recuerda lo que va a pagar en la puerta', () => {
    const text = orderReviewKeptText('ORD-260904-026', 48, true);
    expect(text).toContain('#26');
    expect(text).toContain('Bs. 48');
    expect(text).toContain('efectivo');
  });

  it('por QR le recuerda el comprobante, que es lo que falta', () => {
    const text = orderReviewKeptText('ORD-260904-026', 48, false);
    expect(text).toContain('comprobante');
    expect(text).not.toContain('efectivo');
  });

  it('no vuelve a preguntar nada: el cliente ya contestó', () => {
    const text = orderReviewKeptText('ORD-260904-026', 48, true);
    expect(text).not.toContain('¿Querés agregar');
    expect(text).not.toContain('Respondé');
  });
});
