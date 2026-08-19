import { describe, it, expect } from 'vitest';
import {
  reconcileOrder,
  type ReconcileContext,
  type ReconcileDeps,
  type ReconcileRow,
  type ClaimReconResult,
} from './reconcile-runner';
import type { NotificationType } from './web-notify';
import type { MessageHistoryResult, ListOutboundQuery } from '@/lib/kapso/message-history';

const ORDER_ID = 'b2222222-2222-4222-8222-222222222222';
const RECIPIENT = '59170000000';
const NOW = Date.parse('2026-07-22T18:05:00.000Z');
const ATTEMPT_AT = '2026-07-22T18:00:00.000Z';

function row(overrides: Partial<ReconcileRow> = {}): ReconcileRow {
  return {
    notificationType: 'confirmation',
    status: 'pending_reconciliation',
    lastAttemptAt: ATTEMPT_AT,
    ...overrides,
  };
}

function ctx(overrides: Partial<ReconcileContext> = {}): ReconcileContext {
  return {
    orderNumber: 'ORD-000009',
    normalizedRecipient: RECIPIENT,
    phoneNumberId: 'pnid-1',
    orderReceived: null,
    confirmation: row(),
    locationRequest: null,
    ...overrides,
  };
}

/** Mensaje saliente crudo que normaliza a `type` para ORD-000009. */
function outboundMsg(type: NotificationType, status: string, id = 'wamid.X') {
  const base = {
    id,
    to: RECIPIENT,
    timestamp: '2026-07-22T18:00:30.000Z',
    kapso: { direction: 'outbound', status },
  };
  if (type === 'confirmation') {
    // Copy canónico reconocible por el clasificador (marca legacy «¡Recibí…»).
    return { ...base, type: 'text', text: { body: '📦 ¡Recibí tu pedido ORD-000009!' } };
  }
  if (type === 'order_received') {
    return { ...base, type: 'text', text: { body: '📦 Recibimos tu pedido ORD-000009.' } };
  }
  return {
    ...base,
    type: 'interactive',
    interactive: { type: 'location_request_message', body: { text: 'ORD-000009 ubicación' } },
  };
}

interface Calls {
  claim: NotificationType[];
  history: ListOutboundQuery[];
  markSent: number;
  scheduleRetry: number;
  reschedule: number;
  markTerminal: number;
  terminalizeExhausted: NotificationType[];
}

function fakeDeps(opts: {
  context?: ReconcileContext | null;
  history?: (type: NotificationType) => MessageHistoryResult;
  claim?: (type: NotificationType) => ClaimReconResult;
  scheduled?: boolean;
  rescheduled?: boolean;
  rescheduleReason?: string;
  terminalizeExhausted?: (type: NotificationType) => boolean;
}): { deps: ReconcileDeps; calls: Calls } {
  const calls: Calls = {
    claim: [],
    history: [],
    markSent: 0,
    scheduleRetry: 0,
    reschedule: 0,
    markTerminal: 0,
    terminalizeExhausted: [],
  };
  let claimSeq = 0;
  const deps: ReconcileDeps = {
    now: () => NOW,
    async loadContext() {
      return opts.context === undefined ? ctx() : opts.context;
    },
    async claim(_orderId, type) {
      calls.claim.push(type);
      if (opts.claim) return opts.claim(type);
      return {
        claimed: true,
        notificationId: `notif-${++claimSeq}`,
        claimToken: `tok-${claimSeq}`,
      };
    },
    async listOutbound(query) {
      calls.history.push(query);
      // El tipo se infiere de qué notificación se está reconciliando por orden.
      const type: NotificationType = calls.claim[calls.history.length - 1] ?? 'confirmation';
      return opts.history ? opts.history(type) : { ok: true, messages: [], nextCursor: null };
    },
    async markSent() {
      calls.markSent += 1;
      return true;
    },
    async scheduleRetry() {
      calls.scheduleRetry += 1;
      return { scheduled: opts.scheduled ?? true };
    },
    async reschedule() {
      calls.reschedule += 1;
      return { rescheduled: opts.rescheduled ?? true, reason: opts.rescheduleReason };
    },
    async markTerminal() {
      calls.markTerminal += 1;
      return true;
    },
    async terminalizeExhausted(_orderId, type) {
      calls.terminalizeExhausted.push(type);
      return opts.terminalizeExhausted ? opts.terminalizeExhausted(type) : true;
    },
  };
  return { deps, calls };
}

describe('reconcileOrder — decisiones por notificación', () => {
  it('11. matched → mark_reconciliation_sent (source history), sin envío', async () => {
    const { deps, calls } = fakeDeps({
      history: () => ({ ok: true, messages: [outboundMsg('confirmation', 'sent')], nextCursor: null }),
    });
    const res = await reconcileOrder(ORDER_ID, deps);
    expect(res.confirmation).toBe('matched');
    expect(calls.markSent).toBe(1);
    expect(calls.scheduleRetry).toBe(0);
  });

  it('12. not_found → schedule_notification_retry, sin envío', async () => {
    const { deps, calls } = fakeDeps({
      history: () => ({ ok: true, messages: [], nextCursor: null }),
    });
    const res = await reconcileOrder(ORDER_ID, deps);
    expect(res.confirmation).toBe('not_found');
    expect(calls.scheduleRetry).toBe(1);
    expect(calls.markSent).toBe(0);
  });

  it('13. ambiguous → reprograma/manual review, nunca envía', async () => {
    const { deps, calls } = fakeDeps({
      history: () => ({
        ok: true,
        messages: [outboundMsg('confirmation', 'sent', 'w1'), outboundMsg('confirmation', 'delivered', 'w2')],
        nextCursor: null,
      }),
    });
    const res = await reconcileOrder(ORDER_ID, deps);
    expect(res.confirmation).toBe('ambiguous');
    expect(calls.reschedule).toBe(1);
    expect(calls.markSent).toBe(0);
    expect(calls.scheduleRetry).toBe(0);
  });

  it('13b. ambiguous con intentos agotados → cierre a revisión manual', async () => {
    const { deps, calls } = fakeDeps({
      rescheduled: false,
      rescheduleReason: 'max_attempts_reached',
      history: () => ({
        ok: true,
        messages: [outboundMsg('confirmation', 'sent', 'w1'), outboundMsg('confirmation', 'read', 'w2')],
        nextCursor: null,
      }),
    });
    const res = await reconcileOrder(ORDER_ID, deps);
    expect(res.confirmation).toBe('ambiguous');
    expect(calls.markTerminal).toBe(1);
  });

  it('14. error consultando historial → reschedule, NO not_found', async () => {
    const { deps, calls } = fakeDeps({
      history: () => ({ ok: false, error: 'timeout' }),
    });
    const res = await reconcileOrder(ORDER_ID, deps);
    expect(res.confirmation).toBe('ambiguous');
    expect(calls.reschedule).toBe(1);
    expect(calls.scheduleRetry).toBe(0);
  });

  it('provider_failed → cierre para revisión manual, sin envío', async () => {
    const { deps, calls } = fakeDeps({
      history: () => ({ ok: true, messages: [outboundMsg('confirmation', 'failed')], nextCursor: null }),
    });
    const res = await reconcileOrder(ORDER_ID, deps);
    expect(res.confirmation).toBe('provider_failed');
    expect(calls.markTerminal).toBe(1);
    expect(calls.markSent).toBe(0);
  });
});

describe('reconcileOrder — orden y límites', () => {
  it('15. la confirmación no enviada bloquea la reconciliación de la ubicación', async () => {
    const { deps, calls } = fakeDeps({
      context: ctx({
        confirmation: row({ status: 'pending_reconciliation' }),
        locationRequest: row({ notificationType: 'location_request', status: 'pending_reconciliation' }),
      }),
      // La confirmación queda ambigua (no enviada): la ubicación no debe tocarse.
      history: () => ({
        ok: true,
        messages: [outboundMsg('confirmation', 'sent', 'w1'), outboundMsg('confirmation', 'delivered', 'w2')],
        nextCursor: null,
      }),
    });
    const res = await reconcileOrder(ORDER_ID, deps);
    expect(res.confirmation).toBe('ambiguous');
    expect(res.locationRequest).toBe('not_applicable');
    // Solo se reclamó la confirmación.
    expect(calls.claim).toEqual(['confirmation']);
  });

  it('la ubicación sí se reconcilia cuando la confirmación ya está sent', async () => {
    const { deps, calls } = fakeDeps({
      context: ctx({
        confirmation: row({ status: 'sent' }),
        locationRequest: row({ notificationType: 'location_request', status: 'pending_reconciliation' }),
      }),
      history: (type) => ({
        ok: true,
        messages: type === 'location_request' ? [outboundMsg('location_request', 'sent')] : [],
        nextCursor: null,
      }),
    });
    const res = await reconcileOrder(ORDER_ID, deps);
    expect(res.confirmation).toBe('already_sent');
    expect(res.locationRequest).toBe('matched');
    // La confirmación 'sent' no se reclama; solo la ubicación.
    expect(calls.claim).toEqual(['location_request']);
  });

  it('16. un pedido sin notificaciones devuelve not_found', async () => {
    const { deps, calls } = fakeDeps({
      context: ctx({ confirmation: null, locationRequest: null }),
    });
    const res = await reconcileOrder(ORDER_ID, deps);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('not_found');
    expect(calls.claim).toEqual([]);
    expect(calls.history).toEqual([]);
  });

  it('contexto nulo (pedido inexistente) devuelve not_found', async () => {
    const { deps } = fakeDeps({ context: null });
    const res = await reconcileOrder(ORDER_ID, deps);
    expect(res.reason).toBe('not_found');
  });

  it('17. a lo sumo UNA consulta de historial por notificación', async () => {
    const { deps, calls } = fakeDeps({
      context: ctx({
        confirmation: row({ status: 'sent' }),
        locationRequest: row({ notificationType: 'location_request', status: 'pending_reconciliation' }),
      }),
      history: () => ({ ok: true, messages: [], nextCursor: null }),
    });
    await reconcileOrder(ORDER_ID, deps);
    // Solo la ubicación se reconcilia (confirmación ya sent) -> exactamente 1 GET.
    expect(calls.history).toHaveLength(1);
  });

  it('18. las dependencias no exponen ningún método de envío', () => {
    const { deps } = fakeDeps({});
    expect('sendText' in deps).toBe(false);
    expect('sendLocationRequest' in deps).toBe(false);
    expect('dispatch' in deps).toBe(false);
  });
});

describe('reconcileOrder — reconciling stale con intentos agotados (0006)', () => {
  it('claim max_attempts_reached sobre reconciling → cierre terminal, cero GET, cero markSent', async () => {
    const { deps, calls } = fakeDeps({
      context: ctx({ confirmation: row({ status: 'reconciling' }) }),
      claim: () => ({ claimed: false, reason: 'max_attempts_reached' }),
    });
    const res = await reconcileOrder(ORDER_ID, deps);
    expect(res.confirmation).toBe('exhausted_terminal');
    // Se cerró vía la RPC dedicada, sin consultar historial ni marcar enviado.
    expect(calls.terminalizeExhausted).toEqual(['confirmation']);
    expect(calls.history).toEqual([]);
    expect(calls.markSent).toBe(0);
    expect(calls.markTerminal).toBe(0);
  });

  it('si la RPC de cierre no aplica (false) → degrada a ambiguous, sin GET ni envío', async () => {
    const { deps, calls } = fakeDeps({
      context: ctx({ confirmation: row({ status: 'reconciling' }) }),
      claim: () => ({ claimed: false, reason: 'max_attempts_reached' }),
      terminalizeExhausted: () => false,
    });
    const res = await reconcileOrder(ORDER_ID, deps);
    expect(res.confirmation).toBe('ambiguous');
    expect(calls.terminalizeExhausted).toEqual(['confirmation']);
    expect(calls.history).toEqual([]);
    expect(calls.markSent).toBe(0);
  });

  it('max_attempts_reached sobre pending_reconciliation (no reconciling) NO llama al cierre', async () => {
    const { deps, calls } = fakeDeps({
      context: ctx({ confirmation: row({ status: 'pending_reconciliation' }) }),
      claim: () => ({ claimed: false, reason: 'max_attempts_reached' }),
    });
    const res = await reconcileOrder(ORDER_ID, deps);
    expect(res.confirmation).toBe('ambiguous');
    expect(calls.terminalizeExhausted).toEqual([]);
  });

  it('reconciling con intentos disponibles (claim concedido) NO se cierra: se reconcilia', async () => {
    const { deps, calls } = fakeDeps({
      context: ctx({ confirmation: row({ status: 'reconciling' }) }),
      history: () => ({ ok: true, messages: [outboundMsg('confirmation', 'sent')], nextCursor: null }),
    });
    const res = await reconcileOrder(ORDER_ID, deps);
    expect(res.confirmation).toBe('matched');
    expect(calls.terminalizeExhausted).toEqual([]);
    expect(calls.markSent).toBe(1);
  });
});
