import { describe, it, expect } from 'vitest';
import { classifyOutboundType } from './outbound-classify';
import { normalizeOutboundMessage } from './message-history';
import { parseOutboundEvent } from '@/lib/orders/notifications/outbound-event';
import {
  buildOrderReceivedText,
  buildDynamicDeliveryConfirmationText,
  buildConfirmationText,
  buildQrPaymentCaption,
} from '@/lib/orders/notifications/notify-text';

const ORD = 'ORD-000123';

const ORDER_RECEIVED = buildOrderReceivedText(ORD);
const CONF_DYNAMIC = buildDynamicDeliveryConfirmationText({
  order_number: ORD,
  subtotal_amount: 90,
  delivery_amount: 16,
  total_amount: 106,
});
const CONF_QR_CAPTION = buildQrPaymentCaption(CONF_DYNAMIC);
const CONF_LEGACY_PICKUP = (() => {
  const r = buildConfirmationText({
    order_number: ORD,
    delivery_type: 'pickup',
    subtotal_amount: 50,
    total_amount: 50,
    items: [{ product_name_snapshot: 'La Fija', quantity: 1, subtotal: 50 }],
  });
  return r.ok ? r.text : '';
})();

describe('classifyOutboundType — clasificación determinista', () => {
  it('order_received (texto de recepción) → order_received, NO confirmation', () => {
    const t = classifyOutboundType({
      messageKind: 'text',
      interactiveType: null,
      bodyText: ORDER_RECEIVED,
      orderNumber: ORD,
    });
    expect(t).toBe('order_received');
  });

  it('confirmation cash dinámica (Comida/Delivery/Total) → confirmation', () => {
    expect(
      classifyOutboundType({ messageKind: 'text', interactiveType: null, bodyText: CONF_DYNAMIC, orderNumber: ORD }),
    ).toBe('confirmation');
  });

  it('confirmation QR (imagen con caption) → confirmation', () => {
    expect(
      classifyOutboundType({ messageKind: 'image', interactiveType: null, bodyText: CONF_QR_CAPTION, orderNumber: ORD }),
    ).toBe('confirmation');
  });

  it('confirmation legacy («¡Recibí tu pedido…») → confirmation', () => {
    expect(
      classifyOutboundType({ messageKind: 'text', interactiveType: null, bodyText: CONF_LEGACY_PICKUP, orderNumber: ORD }),
    ).toBe('confirmation');
  });

  it('location_request interactivo → location_request', () => {
    expect(
      classifyOutboundType({
        messageKind: 'interactive',
        interactiveType: 'location_request_message',
        bodyText: 'ORD-000123 ubicación',
        orderNumber: ORD,
      }),
    ).toBe('location_request');
  });

  it('texto genérico sin forma reconocible → unknown (ya no "todo texto = confirmation")', () => {
    expect(
      classifyOutboundType({ messageKind: 'text', interactiveType: null, bodyText: 'hola qué tal', orderNumber: null }),
    ).toBe('unknown');
  });

  it('texto de fuera de cobertura (sin ORD) → unknown (no contamina reconciliación)', () => {
    expect(
      classifyOutboundType({
        messageKind: 'text',
        interactiveType: null,
        bodyText: 'Lo sentimos, tu ubicación está fuera de nuestra zona de delivery.',
        orderNumber: null,
      }),
    ).toBe('unknown');
  });
});

// ── Paridad: los DOS clasificadores (historial y webhook) coinciden ──────────

function historyType(msg: Record<string, unknown>): string {
  return normalizeOutboundMessage(msg)?.type ?? 'null';
}

function webhookType(msg: Record<string, unknown>): string {
  const r = parseOutboundEvent('whatsapp.message.sent', { message: { ...msg, to: '59170000000' } });
  return r.ok ? r.event.messageType : 'invalid';
}

describe('paridad historial ↔ webhook (misma semántica de clasificación)', () => {
  const cases: Array<{ name: string; msg: Record<string, unknown>; expected: string }> = [
    {
      name: 'order_received (texto)',
      msg: { id: 'w1', to: '59170000000', type: 'text', text: { body: ORDER_RECEIVED }, timestamp: '2026-08-11T18:00:00.000Z' },
      expected: 'order_received',
    },
    {
      name: 'confirmation cash (texto)',
      msg: { id: 'w2', to: '59170000000', type: 'text', text: { body: CONF_DYNAMIC }, timestamp: '2026-08-11T18:00:00.000Z' },
      expected: 'confirmation',
    },
    {
      name: 'confirmation QR (imagen)',
      msg: { id: 'w3', to: '59170000000', type: 'image', image: { caption: CONF_QR_CAPTION }, timestamp: '2026-08-11T18:00:00.000Z' },
      expected: 'confirmation',
    },
    {
      name: 'location_request (interactivo)',
      msg: {
        id: 'w4',
        to: '59170000000',
        type: 'interactive',
        interactive: { type: 'location_request_message', body: { text: `Pedido ${ORD}` } },
        timestamp: '2026-08-11T18:00:00.000Z',
      },
      expected: 'location_request',
    },
  ];

  for (const c of cases) {
    it(`${c.name}: historial y webhook clasifican igual (${c.expected})`, () => {
      const h = historyType(c.msg);
      const w = webhookType(c.msg);
      expect(h).toBe(c.expected);
      expect(w).toBe(c.expected);
      expect(h).toBe(w);
    });
  }

  it('order_received NUNCA se clasifica como confirmation en ninguna vía', () => {
    const msg = { id: 'w5', to: '59170000000', type: 'text', text: { body: ORDER_RECEIVED }, timestamp: '2026-08-11T18:00:00.000Z' };
    expect(historyType(msg)).not.toBe('confirmation');
    expect(webhookType(msg)).not.toBe('confirmation');
  });
});
