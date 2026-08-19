import { describe, it, expect } from 'vitest';
import {
  isOutboundEventName,
  OUTBOUND_EVENT_NAMES,
  parseOutboundEvent,
  sanitizeProviderErrorCode,
} from './outbound-event';

function sentPayload(overrides: Record<string, unknown> = {}) {
  return {
    phone_number_id: 'pnid-1',
    message: {
      id: 'wamid.TEXT_1',
      timestamp: '2026-07-21T14:01:00.000Z',
      type: 'text',
      to: '59170000001',
      text: { body: '📦 ¡Recibí tu pedido ORD-000006!' },
      kapso: {
        direction: 'outbound',
        status: 'sent',
        whatsapp_conversation_id: 'conv-1',
      },
    },
    ...overrides,
  };
}

function locationPayload() {
  return {
    phone_number_id: 'pnid-1',
    message: {
      id: 'wamid.LOC_1',
      timestamp: '2026-07-21T14:02:00.000Z',
      type: 'interactive',
      to: '59170000001',
      interactive: {
        type: 'location_request_message',
        body: { text: '📍 Pedido ORD-000006: envíame tu ubicación GPS…' },
      },
      kapso: { direction: 'outbound', whatsapp_conversation_id: 'conv-1' },
    },
  };
}

describe('isOutboundEventName', () => {
  it('reconoce los cuatro eventos salientes confirmados por Kapso', () => {
    expect([...OUTBOUND_EVENT_NAMES].sort()).toEqual([
      'whatsapp.message.delivered',
      'whatsapp.message.failed',
      'whatsapp.message.read',
      'whatsapp.message.sent',
    ]);

    for (const name of OUTBOUND_EVENT_NAMES) {
      expect(isOutboundEventName(name)).toBe(true);
    }
  });

  it('rechaza el evento entrante y cualquier otro', () => {
    expect(isOutboundEventName('whatsapp.message.received')).toBe(false);
    expect(isOutboundEventName('otro.evento')).toBe(false);
    expect(isOutboundEventName(null)).toBe(false);
  });
});

describe('parseOutboundEvent', () => {
  it('extrae los campos de un whatsapp.message.sent de texto', () => {
    const parsed = parseOutboundEvent('whatsapp.message.sent', sentPayload());

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.event).toEqual({
      externalMessageId: 'wamid.TEXT_1',
      phoneNumberId: 'pnid-1',
      recipient: '59170000001',
      conversationId: 'conv-1',
      eventStatus: 'sent',
      messageType: 'confirmation',
      orderNumber: 'ORD-000006',
      providerErrorCode: null,
      timestamp: '2026-07-21T14:01:00.000Z',
      timestampMs: Date.parse('2026-07-21T14:01:00.000Z'),
    });
  });

  it('interpreta un timestamp Unix en segundos del evento', () => {
    const parsed = parseOutboundEvent(
      'whatsapp.message.sent',
      sentPayload({ message: { id: 'wamid.UNIX', timestamp: 1730092860 } }),
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.event.timestampMs).toBe(1730092860000);
    expect(parsed.event.timestamp).toBe('2024-10-28T05:21:00.000Z');
  });

  it('un timestamp ilegible queda en null, nunca en la hora actual', () => {
    const parsed = parseOutboundEvent(
      'whatsapp.message.sent',
      sentPayload({ message: { id: 'wamid.BAD', timestamp: 'ayer' } }),
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.event.timestampMs).toBeNull();
    expect(parsed.event.timestamp).toBeNull();
  });

  it('reconoce una solicitud de ubicación y su número de pedido', () => {
    const parsed = parseOutboundEvent('whatsapp.message.delivered', locationPayload());

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.event.messageType).toBe('location_request');
    expect(parsed.event.orderNumber).toBe('ORD-000006');
    expect(parsed.event.eventStatus).toBe('delivered');
  });

  it('deriva eventStatus del nombre del evento', () => {
    const statuses = OUTBOUND_EVENT_NAMES.map((name) => {
      const parsed = parseOutboundEvent(name, sentPayload());
      return parsed.ok ? parsed.event.eventStatus : null;
    });
    expect(statuses).toEqual(['sent', 'delivered', 'read', 'failed']);
  });

  it('acepta la envoltura data.message y la raíz', () => {
    const nested = parseOutboundEvent('whatsapp.message.sent', {
      data: { message: { id: 'wamid.NESTED', type: 'text', text: { body: 'ORD-000009' } } },
    });
    expect(nested.ok).toBe(true);
    if (nested.ok) expect(nested.event.externalMessageId).toBe('wamid.NESTED');

    const root = parseOutboundEvent('whatsapp.message.sent', { id: 'wamid.ROOT' });
    expect(root.ok).toBe(true);
    if (root.ok) expect(root.event.externalMessageId).toBe('wamid.ROOT');
  });

  it('evento no saliente -> unsupported_event', () => {
    expect(parseOutboundEvent('whatsapp.message.received', sentPayload())).toEqual({
      ok: false,
      reason: 'unsupported_event',
    });
    expect(parseOutboundEvent(null, sentPayload())).toEqual({
      ok: false,
      reason: 'unsupported_event',
    });
  });

  it('sin id de mensaje -> invalid_shape', () => {
    expect(parseOutboundEvent('whatsapp.message.sent', { message: {} })).toEqual({
      ok: false,
      reason: 'invalid_shape',
    });
    expect(parseOutboundEvent('whatsapp.message.sent', null)).toEqual({
      ok: false,
      reason: 'invalid_shape',
    });
  });

  it('no confía en campos opcionales ausentes', () => {
    const parsed = parseOutboundEvent('whatsapp.message.sent', { message: { id: 'wamid.MIN' } });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.event).toMatchObject({
      externalMessageId: 'wamid.MIN',
      phoneNumberId: null,
      recipient: null,
      conversationId: null,
      messageType: 'unknown',
      orderNumber: null,
      providerErrorCode: null,
      timestamp: null,
    });
  });

  it('extrae el código de error del proveedor en un failed', () => {
    const parsed = parseOutboundEvent('whatsapp.message.failed', {
      message: { id: 'wamid.FAIL', error: { code: '131047' } },
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.event.eventStatus).toBe('failed');
    expect(parsed.event.providerErrorCode).toBe('131047');
  });

  it('acepta el código en errors[0]', () => {
    const parsed = parseOutboundEvent('whatsapp.message.failed', {
      message: { id: 'wamid.FAIL2', errors: [{ code: 'RATE_LIMIT' }] },
    });
    expect(parsed.ok && parsed.event.providerErrorCode).toBe('RATE_LIMIT');
  });
});

describe('sanitizeProviderErrorCode', () => {
  it('conserva códigos cortos y seguros', () => {
    expect(sanitizeProviderErrorCode('131047')).toBe('131047');
    expect(sanitizeProviderErrorCode(131047)).toBe('131047');
    expect(sanitizeProviderErrorCode('rate.limit_hit:2')).toBe('rate.limit_hit:2');
  });

  it('descarta mensajes técnicos, con espacios o demasiado largos', () => {
    expect(sanitizeProviderErrorCode('Rate limit exceeded for phone')).toBeNull();
    expect(sanitizeProviderErrorCode('a'.repeat(65))).toBeNull();
    expect(sanitizeProviderErrorCode('{"error":"x"}')).toBeNull();
    expect(sanitizeProviderErrorCode('+59170000001')).toBeNull();
  });

  it('descarta valores ausentes o vacíos', () => {
    expect(sanitizeProviderErrorCode(null)).toBeNull();
    expect(sanitizeProviderErrorCode(undefined)).toBeNull();
    expect(sanitizeProviderErrorCode('')).toBeNull();
    expect(sanitizeProviderErrorCode({})).toBeNull();
  });
});
