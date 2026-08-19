import { describe, it, expect } from 'vitest';
import {
  processOutboundEvent,
  type OutboundReconciliationStore,
  type ResolvedOrder,
  type WebhookSentResult,
} from './outbound-webhook';
import type { OutboundEvent } from './outbound-event';
import type { NotificationStatesResult, NotificationStateRow } from './retry-plan';
import type { NotificationType } from './web-notify';

const ORDER_ID = 'a1111111-1111-4111-8111-111111111111';
const RECIPIENT = '59170000000';

function event(overrides: Partial<OutboundEvent> = {}): { ok: true; event: OutboundEvent } {
  return {
    ok: true,
    event: {
      externalMessageId: 'wamid.A',
      phoneNumberId: 'pnid-1',
      recipient: RECIPIENT,
      conversationId: null,
      eventStatus: 'sent',
      messageType: 'confirmation',
      orderNumber: 'ORD-000009',
      providerErrorCode: null,
      timestamp: null,
      timestampMs: null,
      ...overrides,
    },
  };
}

function stateRow(overrides: Partial<NotificationStateRow> = {}): NotificationStateRow {
  return {
    notificationType: 'confirmation',
    status: 'pending_reconciliation',
    attemptCount: 1,
    maxAttempts: 5,
    nextAttemptAt: null,
    terminalAt: null,
    manualReviewRequired: false,
    lastErrorCode: 'timeout',
    lastHttpStatus: null,
    ...overrides,
  };
}

interface Calls {
  resolveOrder: string[];
  markSent: Array<{ orderId: string; type: NotificationType; wamid: string }>;
  loadStates: string[];
  markTerminal: Array<{ orderId: string; type: NotificationType; code: string; manual: boolean }>;
}

function fakeStore(opts: {
  order?: ResolvedOrder | null;
  sentResult?: WebhookSentResult;
  states?: NotificationStatesResult;
  terminalOk?: boolean;
}): { store: OutboundReconciliationStore; calls: Calls } {
  const calls: Calls = { resolveOrder: [], markSent: [], loadStates: [], markTerminal: [] };
  const order =
    opts.order === undefined ? { id: ORDER_ID, customerPhoneDigits: RECIPIENT } : opts.order;
  const store: OutboundReconciliationStore = {
    async resolveOrder(orderNumber) {
      calls.resolveOrder.push(orderNumber);
      return order;
    },
    async markSentByWebhook(orderId, type, wamid) {
      calls.markSent.push({ orderId, type, wamid });
      return opts.sentResult ?? 'sent';
    },
    async loadStates(orderId) {
      calls.loadStates.push(orderId);
      return opts.states ?? { rows: [stateRow()], unknownStateCount: 0 };
    },
    async markTerminalByType(orderId, type, code, _http, manual) {
      calls.markTerminal.push({ orderId, type, code, manual });
      return opts.terminalOk ?? true;
    },
  };
  return { store, calls };
}

describe('processOutboundEvent — resolución segura', () => {
  it('1. sent resuelve la confirmación y la marca enviada', async () => {
    const { store, calls } = fakeStore({ sentResult: 'sent' });
    const res = await processOutboundEvent(event(), store);
    expect(res.outcome).toBe('sent');
    expect(calls.markSent).toEqual([
      { orderId: ORDER_ID, type: 'confirmation', wamid: 'wamid.A' },
    ]);
  });

  it('2. sent resuelve location_request y delega el guardado del wamid a la RPC', async () => {
    const { store, calls } = fakeStore({ sentResult: 'sent' });
    const res = await processOutboundEvent(
      event({ messageType: 'location_request', externalMessageId: 'wamid.L' }),
      store,
    );
    expect(res.outcome).toBe('sent');
    expect(calls.markSent).toEqual([
      { orderId: ORDER_ID, type: 'location_request', wamid: 'wamid.L' },
    ]);
  });

  it('3. delivered y read son idempotentes (already_sent) sin efecto extra', async () => {
    for (const eventStatus of ['delivered', 'read'] as const) {
      const { store, calls } = fakeStore({ sentResult: 'already_sent' });
      const res = await processOutboundEvent(event({ eventStatus }), store);
      expect(res.outcome).toBe('already_sent');
      expect(calls.markSent).toHaveLength(1);
    }
  });

  it('5. un wamid distinto sobre una fila enviada produce conflicto seguro', async () => {
    const { store } = fakeStore({ sentResult: 'conflict' });
    const res = await processOutboundEvent(event(), store);
    expect(res.outcome).toBe('conflict');
  });

  it('6. un destinatario que no coincide NO actualiza nada', async () => {
    const { store, calls } = fakeStore({
      order: { id: ORDER_ID, customerPhoneDigits: '59171111111' },
    });
    const res = await processOutboundEvent(event(), store);
    expect(res.outcome).toBe('ignored');
    expect(res.reason).toBe('recipient_mismatch');
    expect(calls.markSent).toEqual([]);
  });

  it('7. un order_number inexistente NO actualiza nada', async () => {
    const { store, calls } = fakeStore({ order: null });
    const res = await processOutboundEvent(event(), store);
    expect(res.outcome).toBe('ignored');
    expect(res.reason).toBe('order_not_found');
    expect(calls.markSent).toEqual([]);
  });

  it('8. un cuerpo sin order_number se ignora', async () => {
    const { store, calls } = fakeStore({});
    const res = await processOutboundEvent(event({ orderNumber: null }), store);
    expect(res.outcome).toBe('ignored');
    expect(res.reason).toBe('no_order_number');
    expect(calls.resolveOrder).toEqual([]);
  });

  it('tipo de mensaje no resoluble se ignora', async () => {
    const { store } = fakeStore({});
    const res = await processOutboundEvent(event({ messageType: 'unknown' }), store);
    expect(res.reason).toBe('unresolved_type');
  });
});

describe('processOutboundEvent — evento failed', () => {
  it('9. failed PERMANENTE cierra terminal y NUNCA envía', async () => {
    // `invalid_phone` es de los pocos códigos que el clasificador considera
    // permanente con certeza.
    const { store, calls } = fakeStore({
      states: { rows: [stateRow({ status: 'sending', lastErrorCode: null })], unknownStateCount: 0 },
      terminalOk: true,
    });
    const res = await processOutboundEvent(
      event({ eventStatus: 'failed', providerErrorCode: 'invalid_phone' }),
      store,
    );
    expect(res.outcome).toBe('terminal');
    expect(calls.markTerminal).toHaveLength(1);
    expect(calls.markSent).toEqual([]);
  });

  it('10. failed AMBIGUO no muta estado ni envía', async () => {
    const { store, calls } = fakeStore({
      states: { rows: [stateRow({ status: 'sending', lastErrorCode: null })], unknownStateCount: 0 },
    });
    const res = await processOutboundEvent(
      event({ eventStatus: 'failed', providerErrorCode: 'timeout' }),
      store,
    );
    expect(res.outcome).toBe('recorded_failure');
    expect(calls.markTerminal).toEqual([]);
    expect(calls.markSent).toEqual([]);
  });

  it('failed sobre una fila ya enviada NO la degrada', async () => {
    const { store, calls } = fakeStore({
      states: { rows: [stateRow({ status: 'sent', lastErrorCode: null })], unknownStateCount: 0 },
    });
    const res = await processOutboundEvent(
      event({ eventStatus: 'failed', providerErrorCode: 'invalid_phone' }),
      store,
    );
    expect(res.outcome).toBe('already_sent');
    expect(calls.markTerminal).toEqual([]);
  });

  it('failed sobre una fila terminal/manual no la modifica', async () => {
    const { store, calls } = fakeStore({
      states: {
        rows: [stateRow({ status: 'failed', terminalAt: '2026-07-01T00:00:00Z' })],
        unknownStateCount: 0,
      },
    });
    const res = await processOutboundEvent(
      event({ eventStatus: 'failed', providerErrorCode: 'invalid_phone' }),
      store,
    );
    expect(res.outcome).toBe('manual_review_required');
    expect(calls.markTerminal).toEqual([]);
  });

  it('failed cuyo tipo no está inicializado se ignora', async () => {
    const { store } = fakeStore({ states: { rows: [], unknownStateCount: 0 } });
    const res = await processOutboundEvent(
      event({ eventStatus: 'failed', providerErrorCode: 'invalid_phone' }),
      store,
    );
    expect(res.reason).toBe('type_not_initialized');
  });
});

describe('processOutboundEvent — 18/19 sin envíos ni fugas', () => {
  it('18. el store no expone ningún método de envío', () => {
    const { store } = fakeStore({});
    expect('sendText' in store).toBe(false);
    expect('sendLocationRequest' in store).toBe(false);
  });

  it('19. la respuesta no contiene teléfono, wamid ni order_id', async () => {
    const { store } = fakeStore({ sentResult: 'sent' });
    const res = await processOutboundEvent(event(), store);
    const serialized = JSON.stringify(res);
    expect(serialized).not.toContain(RECIPIENT);
    expect(serialized).not.toContain('wamid.A');
    expect(serialized).not.toContain(ORDER_ID);
  });
});
