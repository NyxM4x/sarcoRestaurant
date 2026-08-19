import { describe, it, expect } from 'vitest';
import {
  buildImagePayload,
  buildLocationRequestPayload,
  buildTextPayload,
  buildWebLocationRequestBodyText,
  LOCATION_REQUEST_BODY_TEXT,
  PAYMENT_QR_URL,
} from './messages';

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
  it('sin bodyText usa EXACTAMENTE el copy actual del WhatsApp Flow', () => {
    const payload = buildLocationRequestPayload('59170000001');
    expect(payload).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '59170000001',
      type: 'interactive',
      interactive: {
        type: 'location_request_message',
        body: { text: LOCATION_REQUEST_BODY_TEXT },
        action: { name: 'send_location' },
      },
    });
    // Blindaje del copy por defecto: no debe cambiar.
    expect(LOCATION_REQUEST_BODY_TEXT).toBe(
      'Por favor comparte tu ubicación actual para coordinar el delivery.',
    );
  });

  it('con el copy web cambia solo el texto del cuerpo', () => {
    const payload = buildLocationRequestPayload('59170000001', WEB_LOCATION_REQUEST_BODY_TEXT);
    expect(payload.interactive.body.text).toBe(WEB_LOCATION_REQUEST_BODY_TEXT);
  });

  it('interactive.type y action.name permanecen intactos con y sin bodyText', () => {
    const def = buildLocationRequestPayload('59170000001');
    const web = buildLocationRequestPayload('59170000001', WEB_LOCATION_REQUEST_BODY_TEXT);
    for (const payload of [def, web]) {
      expect(payload.type).toBe('interactive');
      expect(payload.interactive.type).toBe('location_request_message');
      expect(payload.interactive.action.name).toBe('send_location');
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
    // El flujo del Flow no pasa bodyText: conserva su texto original.
    const flow = buildLocationRequestPayload('59170000001');
    expect(flow.interactive.body.text).toBe(LOCATION_REQUEST_BODY_TEXT);
    expect(flow.interactive.body.text).not.toContain('Pedido');
    expect(flow.interactive.body.text).not.toContain('ORD-');
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
    expect(PAYMENT_QR_URL).toBe('https://sarco-restaurant.vercel.app/payment/qr.png');
  });
});
