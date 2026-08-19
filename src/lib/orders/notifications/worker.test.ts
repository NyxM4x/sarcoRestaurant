import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  runWorkerTick,
  MAX_HISTORY_READS_PER_WORKER_RUN,
  type WorkerDeps,
  type WorkerConfig,
} from './worker';
import {
  handleWorkerTick,
  type NotificationWorkerDeps,
} from './worker-handler';
import type { NotificationStateRow, NotificationStatesResult } from './retry-plan';
import type { NotificationType } from './recovery-state';
import type { ReconcileOutcome } from './reconcile-runner';
import type { AlertRunnerDeps } from './alert-runner';

const NOW = 1_000_000;
const FAR_DEADLINE = NOW + 60_000;

function row(overrides: Partial<NotificationStateRow> = {}): NotificationStateRow {
  return {
    notificationType: 'confirmation',
    status: 'pending',
    attemptCount: 1,
    maxAttempts: 5,
    nextAttemptAt: null,
    terminalAt: null,
    manualReviewRequired: false,
    lastErrorCode: null,
    lastHttpStatus: null,
    ...overrides,
  };
}
function states(rows: NotificationStateRow[], unknownStateCount = 0): NotificationStatesResult {
  return { rows, unknownStateCount };
}

interface Calls {
  selectDue: number;
  loadStates: string[];
  recoverStale: Array<[string, NotificationType]>;
  reconcile: Array<[string, NotificationType]>;
  send: Array<[string, NotificationType]>;
}

interface HarnessOpts {
  orders?: string[];
  states?: Record<string, NotificationStatesResult>;
  send?: (o: string, t: NotificationType) => { outcome: string; sendAttempted: boolean };
  reconcile?: (o: string, t: NotificationType) => { outcome: ReconcileOutcome; historyRead: boolean };
  recoverStale?: (o: string, t: NotificationType) => { recovered: boolean; reason?: string };
  loadStatesThrows?: (o: string) => boolean;
  selectThrows?: boolean;
  deadline?: number;
  now?: number;
  cfg?: WorkerConfig;
  alerts?: AlertRunnerDeps;
}

function harness(opts: HarnessOpts = {}) {
  const orders = opts.orders ?? ['o1'];
  const calls: Calls = { selectDue: 0, loadStates: [], recoverStale: [], reconcile: [], send: [] };
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const deps: WorkerDeps = {
    async selectDue() {
      calls.selectDue += 1;
      if (opts.selectThrows) throw new Error('select failed');
      return orders;
    },
    async loadStates(o) {
      calls.loadStates.push(o);
      if (opts.loadStatesThrows?.(o)) throw new Error('load failed');
      return opts.states?.[o] ?? states([]);
    },
    async recoverStale(o, t) {
      calls.recoverStale.push([o, t]);
      return opts.recoverStale ? opts.recoverStale(o, t) : { recovered: true };
    },
    async reconcileNotification(o, t) {
      calls.reconcile.push([o, t]);
      return opts.reconcile ? opts.reconcile(o, t) : { outcome: 'matched', historyRead: true };
    },
    async sendNotification(o, t) {
      calls.send.push([o, t]);
      return opts.send ? opts.send(o, t) : { outcome: 'sent', sendAttempted: true };
    },
    now: () => opts.now ?? NOW,
    deadline: opts.deadline ?? FAR_DEADLINE,
    log: (event, fields) => logs.push({ event, fields: fields ?? {} }),
    alerts: opts.alerts,
  };
  return { deps, calls, logs, run: () => runWorkerTick(deps, opts.cfg ?? {}) };
}

describe('runWorkerTick — selección y ramas base', () => {
  it('5. select_due vacío → 200-equivalente sin trabajo', async () => {
    const h = harness({ orders: [] });
    const r = await h.run();
    expect(r.selected).toBe(0);
    expect(r.processed).toBe(0);
    expect(r.network_send_attempts).toBe(0);
    expect(h.calls.loadStates).toEqual([]);
  });

  it('37. pedido histórico sin filas nunca se inicializa', async () => {
    const h = harness({ orders: ['o1'], states: { o1: states([]) } });
    const r = await h.run();
    expect(r.network_send_attempts).toBe(0);
    expect(r.history_reads).toBe(0);
    expect(h.calls.send).toEqual([]);
    expect(h.calls.reconcile).toEqual([]);
  });
});

describe('runWorkerTick — A. sending stale', () => {
  it('6. recovered_stale, cero envío y cero GET', async () => {
    const h = harness({ orders: ['o1'], states: { o1: states([row({ status: 'sending' })]) } });
    const r = await h.run();
    expect(r.results[0]).toMatchObject({ action: 'recovered_stale' });
    expect(r.network_send_attempts).toBe(0);
    expect(r.history_reads).toBe(0);
  });

  it('7. no continúa a reconciliación en el mismo tick', async () => {
    const h = harness({ orders: ['o1'], states: { o1: states([row({ status: 'sending' })]) } });
    await h.run();
    expect(h.calls.recoverStale).toEqual([['o1', 'confirmation']]);
    expect(h.calls.reconcile).toEqual([]);
    expect(h.calls.send).toEqual([]);
  });

  it('sending fresco (no recuperable) → skip sin efectos', async () => {
    const h = harness({
      orders: ['o1'],
      states: { o1: states([row({ status: 'sending' })]) },
      recoverStale: () => ({ recovered: false, reason: 'still_fresh' }),
    });
    const r = await h.run();
    expect(r.results[0]).toMatchObject({ action: 'skipped', outcome: 'still_fresh' });
    expect(r.network_send_attempts).toBe(0);
  });
});

describe('runWorkerTick — B. reconciliación', () => {
  const pr = (t: NotificationType = 'confirmation') =>
    row({ notificationType: t, status: 'pending_reconciliation', lastErrorCode: 'timeout' });

  it('8. matched → reconciled vía history, cero envío', async () => {
    const h = harness({
      orders: ['o1'], states: { o1: states([pr()]) },
      reconcile: () => ({ outcome: 'matched', historyRead: true }),
    });
    const r = await h.run();
    expect(r.results[0]).toMatchObject({ action: 'reconciled', outcome: 'matched' });
    expect(r.history_reads).toBe(1);
    expect(r.network_send_attempts).toBe(0);
  });

  it('9. not_found → retry programado, cero envío', async () => {
    const h = harness({
      orders: ['o1'], states: { o1: states([pr()]) },
      reconcile: () => ({ outcome: 'not_found', historyRead: true }),
    });
    const r = await h.run();
    expect(r.results[0]).toMatchObject({ action: 'scheduled_retry', outcome: 'not_found' });
    expect(r.network_send_attempts).toBe(0);
    expect(h.calls.send).toEqual([]);
  });

  it('10/11. ambiguous o error de GET → reprogramación, cero envío', async () => {
    const h = harness({
      orders: ['o1'], states: { o1: states([pr()]) },
      reconcile: () => ({ outcome: 'ambiguous', historyRead: true }),
    });
    const r = await h.run();
    expect(r.results[0]).toMatchObject({ action: 'reconciled', outcome: 'ambiguous' });
    expect(r.network_send_attempts).toBe(0);
  });

  it('12. provider_failed → manual review, cero envío', async () => {
    const h = harness({
      orders: ['o1'], states: { o1: states([pr()]) },
      reconcile: () => ({ outcome: 'provider_failed', historyRead: true }),
    });
    const r = await h.run();
    expect(r.results[0]).toMatchObject({ action: 'manual_review', outcome: 'provider_failed' });
    expect(r.network_send_attempts).toBe(0);
  });

  it('25. webhook marcó sent durante la reconciliación → already_sent idempotente', async () => {
    const h = harness({
      orders: ['o1'], states: { o1: states([pr()]) },
      reconcile: () => ({ outcome: 'already_sent', historyRead: false }),
    });
    const r = await h.run();
    expect(r.results[0]).toMatchObject({ action: 'skipped', outcome: 'already_sent' });
    expect(r.network_send_attempts).toBe(0);
  });

  it('reconciling stale agotado → manual_review, cero GET, cero envío (0006)', async () => {
    // La reconciliación cierra la fila internamente vía terminalize_exhausted:
    // no consume historial (historyRead=false) ni intenta ningún POST.
    const h = harness({
      orders: ['o1'],
      states: { o1: states([row({ status: 'reconciling' })]) },
      reconcile: () => ({ outcome: 'exhausted_terminal', historyRead: false }),
    });
    const r = await h.run();
    expect(r.results[0]).toMatchObject({ action: 'manual_review', outcome: 'attempts_exhausted' });
    expect(r.history_reads).toBe(0);
    expect(r.network_send_attempts).toBe(0);
    expect(h.calls.send).toEqual([]);
  });
});

describe('runWorkerTick — D/E. envío programado', () => {
  it('13. retry vencido y permitido → un envío', async () => {
    const h = harness({ orders: ['o1'], states: { o1: states([row({ status: 'pending' })]) } });
    const r = await h.run();
    expect(r.results[0]).toMatchObject({ action: 'sent', outcome: 'sent' });
    expect(r.network_send_attempts).toBe(1);
  });

  it('14/34. dos retries vencidos → solo uno envía por ejecución', async () => {
    const h = harness({
      orders: ['o1', 'o2'],
      states: {
        o1: states([row({ status: 'pending' })]),
        o2: states([row({ status: 'pending' })]),
      },
    });
    const r = await h.run();
    expect(r.network_send_attempts).toBe(1);
    expect(r.budget_exhausted).toBe(true);
    expect(h.calls.send).toHaveLength(1); // el segundo ni siquiera se intenta
  });

  it('R1. primer envío con timeout consume el cupo: no hay segundo POST en el tick', async () => {
    const h = harness({
      orders: ['o1', 'o2'],
      states: {
        o1: states([row({ status: 'pending' })]),
        o2: states([row({ status: 'pending' })]),
      },
      // El sender se invocó y expiró: es un intento (sendAttempted=true).
      send: () => ({ outcome: 'pending_reconciliation', sendAttempted: true }),
    });
    const r = await h.run();
    expect(r.network_send_attempts).toBe(1);
    expect(h.calls.send).toHaveLength(1); // el segundo ni se intenta
    expect(r.budget_exhausted).toBe(true);
  });

  it('R1. claim rechazado (sender no invocado) no consume el cupo: otro trabajo lo usa', async () => {
    const h = harness({
      orders: ['o1', 'o2'],
      states: {
        o1: states([row({ status: 'pending' })]),
        o2: states([row({ status: 'pending' })]),
      },
      // o1: claim perdido (sendAttempted=false) → cupo intacto. o2: envío real.
      send: (o) =>
        o === 'o1'
          ? { outcome: 'in_flight', sendAttempted: false }
          : { outcome: 'sent', sendAttempted: true },
    });
    const r = await h.run();
    expect(h.calls.send).toEqual([['o1', 'confirmation'], ['o2', 'confirmation']]);
    expect(r.network_send_attempts).toBe(1);
  });

  it('19. claim in_flight → skip, cero envío', async () => {
    const h = harness({
      orders: ['o1'], states: { o1: states([row({ status: 'pending' })]) },
      send: () => ({ outcome: 'in_flight', sendAttempted: false }),
    });
    const r = await h.run();
    expect(r.results[0]).toMatchObject({ action: 'skipped', outcome: 'in_flight' });
    expect(r.network_send_attempts).toBe(0);
  });

  it('20. claim requires_reconciliation → skip, cero envío', async () => {
    const h = harness({
      orders: ['o1'], states: { o1: states([row({ status: 'pending' })]) },
      send: () => ({ outcome: 'requires_reconciliation', sendAttempted: false }),
    });
    const r = await h.run();
    expect(r.results[0]).toMatchObject({ action: 'skipped', outcome: 'requires_reconciliation' });
    expect(r.network_send_attempts).toBe(0);
  });

  it('21. fila terminal → skip', async () => {
    const h = harness({
      orders: ['o1'],
      states: { o1: states([row({ status: 'failed', terminalAt: '2026-07-01T00:00:00Z' })]) },
    });
    const r = await h.run();
    expect(r.results[0]).toMatchObject({ action: 'skipped', outcome: 'terminal' });
    expect(h.calls.send).toEqual([]);
  });

  it('22. manual_review_required → skip', async () => {
    const h = harness({
      orders: ['o1'],
      states: { o1: states([row({ status: 'pending', manualReviewRequired: true })]) },
    });
    const r = await h.run();
    expect(r.results[0]).toMatchObject({ action: 'manual_review' });
    expect(h.calls.send).toEqual([]);
  });

  it('23. max_attempts_reached → skip, cero envío', async () => {
    const h = harness({
      orders: ['o1'],
      states: { o1: states([row({ status: 'pending', attemptCount: 5, maxAttempts: 5 })]) },
    });
    const r = await h.run();
    expect(r.results[0]).toMatchObject({ action: 'skipped', outcome: 'max_attempts_reached' });
    expect(r.network_send_attempts).toBe(0);
  });

  it('24. failed sin next_attempt_at → skip (no se auto-programa)', async () => {
    const h = harness({
      orders: ['o1'],
      states: {
        o1: states([row({ status: 'failed', lastErrorCode: 'http_error', lastHttpStatus: 500, nextAttemptAt: null })]),
      },
    });
    const r = await h.run();
    expect(r.results[0].action).toBe('skipped');
    expect(r.network_send_attempts).toBe(0);
    expect(h.calls.send).toEqual([]);
  });

  it('26/27. claim perdido por carrera → cero envío (un solo ganador)', async () => {
    const h = harness({
      orders: ['o1'], states: { o1: states([row({ status: 'pending' })]) },
      send: () => ({ outcome: 'already_sent', sendAttempted: false }),
    });
    const r = await h.run();
    expect(r.network_send_attempts).toBe(0);
    expect(r.results[0]).toMatchObject({ action: 'skipped', outcome: 'already_sent' });
  });
});

describe('runWorkerTick — orden confirmation → location_request', () => {
  it('16. location bloqueada si confirmation no está sent', async () => {
    const h = harness({
      orders: ['o1'],
      states: {
        o1: states([
          row({ notificationType: 'confirmation', status: 'pending_reconciliation', lastErrorCode: 'timeout' }),
          row({ notificationType: 'location_request', status: 'pending' }),
        ]),
      },
      reconcile: () => ({ outcome: 'ambiguous', historyRead: true }),
    });
    const r = await h.run();
    const loc = r.results.find((x) => x.notification_type === 'location_request');
    expect(loc).toMatchObject({ action: 'skipped', outcome: 'blocked_by_confirmation' });
    // La ubicación no se reconcilió ni envió.
    expect(h.calls.reconcile).toEqual([['o1', 'confirmation']]);
    expect(h.calls.send).toEqual([]);
  });

  it('17. confirmation se procesa antes que location', async () => {
    const h = harness({
      orders: ['o1'],
      states: {
        o1: states([
          row({ notificationType: 'confirmation', status: 'sent' }),
          row({ notificationType: 'location_request', status: 'pending' }),
        ]),
      },
    });
    const r = await h.run();
    expect(r.results[0].notification_type).toBe('confirmation');
    expect(r.results[1].notification_type).toBe('location_request');
  });

  it('18. confirmation matched no fuerza location en el mismo tick', async () => {
    const h = harness({
      orders: ['o1'],
      states: {
        o1: states([
          row({ notificationType: 'confirmation', status: 'pending_reconciliation', lastErrorCode: 'timeout' }),
          row({ notificationType: 'location_request', status: 'pending' }),
        ]),
      },
      reconcile: () => ({ outcome: 'matched', historyRead: true }),
    });
    const r = await h.run();
    const loc = r.results.find((x) => x.notification_type === 'location_request');
    expect(loc).toMatchObject({ action: 'skipped', outcome: 'blocked_by_confirmation' });
    expect(r.network_send_attempts).toBe(0);
  });

  it('location se envía cuando confirmation ya está sent', async () => {
    const h = harness({
      orders: ['o1'],
      states: {
        o1: states([
          row({ notificationType: 'confirmation', status: 'sent' }),
          row({ notificationType: 'location_request', status: 'pending' }),
        ]),
      },
      send: (_o, t) => ({ outcome: t === 'location_request' ? 'sent' : 'sent', sendAttempted: t === 'location_request' }),
    });
    const r = await h.run();
    expect(h.calls.send).toEqual([['o1', 'location_request']]);
    expect(r.network_send_attempts).toBe(1);
  });
});

describe('runWorkerTick — presupuesto y tiempo', () => {
  it('31. presupuesto de envío agotado → no inicia otro POST', async () => {
    const h = harness({
      orders: ['o1'], states: { o1: states([row({ status: 'pending' })]) },
      cfg: { sendBudget: 0 },
    });
    const r = await h.run();
    expect(r.results[0]).toMatchObject({ action: 'skipped', outcome: 'send_budget_exhausted' });
    expect(r.budget_exhausted).toBe(true);
    expect(h.calls.send).toEqual([]);
  });

  it('32/35. presupuesto de historial agotado tras dos GET', async () => {
    const pr = () => states([row({ status: 'pending_reconciliation', lastErrorCode: 'timeout' })]);
    const h = harness({
      orders: ['o1', 'o2', 'o3'],
      states: { o1: pr(), o2: pr(), o3: pr() },
      reconcile: () => ({ outcome: 'ambiguous', historyRead: true }),
    });
    const r = await h.run();
    expect(r.history_reads).toBe(MAX_HISTORY_READS_PER_WORKER_RUN); // 2
    expect(h.calls.reconcile).toHaveLength(2); // el tercero ni se intenta
    expect(r.budget_exhausted).toBe(true);
  });

  it('33. tiempo insuficiente → no inicia trabajo nuevo', async () => {
    const h = harness({
      orders: ['o1'], states: { o1: states([row({ status: 'pending' })]) },
      deadline: NOW + 1_000, // muy por debajo del coste mínimo
    });
    const r = await h.run();
    expect(r.budget_exhausted).toBe(true);
    expect(h.calls.loadStates).toEqual([]);
    expect(r.network_send_attempts).toBe(0);
  });
});

describe('runWorkerTick — estados desconocidos y aislamiento', () => {
  it('29. status desconocido → no envío', async () => {
    const weird = { ...row(), status: 'algo_raro' } as unknown as NotificationStateRow;
    const h = harness({ orders: ['o1'], states: { o1: states([weird]) } });
    const r = await h.run();
    expect(r.results[0]).toMatchObject({ action: 'skipped', outcome: 'unknown' });
    expect(r.network_send_attempts).toBe(0);
  });

  it('30. notification_type desconocido (unknownStateCount) → no envío', async () => {
    const h = harness({ orders: ['o1'], states: { o1: states([], 1) } });
    const r = await h.run();
    expect(r.results.some((x) => x.outcome === 'unknown_state')).toBe(true);
    expect(r.network_send_attempts).toBe(0);
  });

  it('40. un error aislado no impide procesar trabajos posteriores', async () => {
    const h = harness({
      orders: ['bad', 'good'],
      states: { good: states([row({ status: 'sending' })]) },
      loadStatesThrows: (o) => o === 'bad',
    });
    const r = await h.run();
    expect(r.results.some((x) => x.outcome === 'order_error')).toBe(true);
    expect(h.calls.recoverStale).toEqual([['good', 'confirmation']]);
  });
});

describe('runWorkerTick — respuesta y logs saneados', () => {
  it('38/39. ni la respuesta ni los logs exponen el order_id', async () => {
    const oid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const h = harness({ orders: [oid], states: { [oid]: states([row({ status: 'pending' })]) } });
    const r = await h.run();
    expect(JSON.stringify(r)).not.toContain(oid);
    expect(JSON.stringify(h.logs)).not.toContain(oid);
  });
});

// ── Alertas Telegram (Fase 5.2D.5E.2) ───────────────────────────────────────

function alertDeps(ids: string[]) {
  const calls = { select: 0, send: [] as string[] };
  const deps: AlertRunnerDeps = {
    async selectDueAlerts() { calls.select += 1; return ids; },
    async claimAlert(id) {
      return { claimed: true, notificationId: id, claimToken: 't', notificationType: 'confirmation', orderNumber: 'ORD-000042', reasonCode: 'provider_failed', reviewKind: 'manual_review' };
    },
    async sendAlert(text) { calls.send.push(text); return { kind: 'sent' }; },
    async markAlerted() { return true; },
    async rescheduleAlert() { return { rescheduled: true, terminal: false }; },
    now: () => NOW,
  };
  return { deps, calls };
}

describe('runWorkerTick — pase de alertas', () => {
  it('sin alertas pendientes → cero llamadas Telegram, contadores en 0', async () => {
    const a = alertDeps([]);
    const h = harness({ orders: [], alerts: a.deps });
    const r = await h.run();
    expect(a.calls.send).toHaveLength(0);
    expect(r.alerts_selected).toBe(0);
    expect(r.alerts_sent).toBe(0);
  });

  it('21/22/23/24. una alerta no llama Kapso, no consulta GET, ni consume envío/historial', async () => {
    const a = alertDeps(['n1']);
    const h = harness({ orders: [], alerts: a.deps });
    const r = await h.run();
    expect(r.alerts_sent).toBe(1);
    expect(a.calls.send).toHaveLength(1);
    // La alerta jamás toca la recuperación:
    expect(h.calls.send).toEqual([]); // sin POST a Kapso
    expect(h.calls.reconcile).toEqual([]); // sin GET /messages
    expect(r.network_send_attempts).toBe(0);
    expect(r.history_reads).toBe(0);
  });

  it('28. la respuesta del worker no expone token, chat_id ni texto de alerta', async () => {
    const a = alertDeps(['n1']);
    const h = harness({ orders: [], alerts: a.deps });
    const r = await h.run();
    const dump = JSON.stringify(r);
    expect(dump).not.toContain('chat_id');
    expect(dump).not.toContain('token');
    expect(dump).not.toContain('ORD-000042');
    expect(dump).not.toContain('Revisión requerida');
  });

  it('el trabajo de recuperación y las alertas conviven en el mismo tick', async () => {
    const a = alertDeps(['n1']);
    const h = harness({
      orders: ['o1'],
      states: { o1: states([row({ status: 'pending' })]) },
      alerts: a.deps,
    });
    const r = await h.run();
    expect(r.network_send_attempts).toBe(1); // recuperación: un POST
    expect(r.alerts_sent).toBe(1); // alerta: un envío Telegram
  });

  it('sin deps de alerta el comportamiento previo queda intacto (contadores 0)', async () => {
    const h = harness({ orders: ['o1'], states: { o1: states([row({ status: 'pending' })]) } });
    const r = await h.run();
    expect(r.alerts_selected).toBe(0);
    expect(r.alert_send_attempts).toBe(0);
    expect(r.alerts_sent).toBe(0);
    expect(r.alerts_rescheduled).toBe(0);
  });
});

// ── Handler HTTP ────────────────────────────────────────────────────────────

function baseDeps(over: Partial<NotificationWorkerDeps> = {}): NotificationWorkerDeps {
  return {
    internalToken: 'tok',
    async selectDue() { return []; },
    async loadStates() { return states([]); },
    async recoverStale() { return { recovered: false }; },
    async reconcileNotification() { return { outcome: 'not_applicable', historyRead: false }; },
    async sendNotification() { return { outcome: 'skipped', sendAttempted: false }; },
    now: () => NOW,
    deadline: FAR_DEADLINE,
    ...over,
  };
}
function req(method = 'POST', body?: unknown, token = 'tok'): Request {
  return new Request('http://localhost/api/internal/order-notifications/worker/tick', {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('handleWorkerTick — códigos HTTP', () => {
  it('1. sin Bearer → 401', async () => {
    const r = new Request('http://x/worker/tick', { method: 'POST' });
    expect((await handleWorkerTick(r, baseDeps())).status).toBe(401);
  });
  it('2. Bearer incorrecto → 401', async () => {
    expect((await handleWorkerTick(req('POST', undefined, 'malo'), baseDeps())).status).toBe(401);
  });
  it('3. método incorrecto → 405', async () => {
    expect((await handleWorkerTick(req('GET'), baseDeps())).status).toBe(405);
  });
  it('4. body con campos no permitidos → 422', async () => {
    expect((await handleWorkerTick(req('POST', { order_id: 'x' }), baseDeps())).status).toBe(422);
  });
  it('body vacío u objeto vacío → 200', async () => {
    expect((await handleWorkerTick(req('POST', {}), baseDeps())).status).toBe(200);
    expect((await handleWorkerTick(req('POST'), baseDeps())).status).toBe(200);
  });
  it('43. sin trabajo → 200', async () => {
    const res = await handleWorkerTick(req('POST', {}), baseDeps());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.selected).toBe(0);
  });
  it('41/42. error aislado → 200; fallo de selección → 500', async () => {
    const isolated = baseDeps({
      async selectDue() { return ['o1']; },
      async loadStates() { throw new Error('boom'); },
    });
    expect((await handleWorkerTick(req('POST', {}), isolated)).status).toBe(200);

    const selFail = baseDeps({ async selectDue() { throw new Error('db down'); } });
    const res = await handleWorkerTick(req('POST', {}), selFail);
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('db down');
  });
  it('44. budget_exhausted → 200', async () => {
    const deps = baseDeps({
      async selectDue() { return ['o1', 'o2']; },
      async loadStates() { return states([row({ status: 'pending' })]); },
      async sendNotification() { return { outcome: 'sent', sendAttempted: true }; },
    });
    const res = await handleWorkerTick(req('POST', {}), deps);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.budget_exhausted).toBe(true);
    expect(body.network_send_attempts).toBe(1);
  });
});

describe('body del tick — forma para el futuro Cloudflare Worker', () => {
  // Decisión: el Cloudflare Worker enviará POST con body `{}` (Content-Length 0
  // es aceptado igual). Se prueba explícitamente la forma que se usará.
  it('POST con body {} → 200 (forma elegida para Cloudflare)', async () => {
    const res = await handleWorkerTick(req('POST', {}), baseDeps());
    expect(res.status).toBe(200);
  });
  it('POST sin body → 200 (también aceptado)', async () => {
    const res = await handleWorkerTick(req('POST'), baseDeps());
    expect(res.status).toBe(200);
  });
});

// ── Riesgo 2: descubrimiento de reconciling stale ───────────────────────────

describe('Riesgo 2 — select_due_notification_orders y reconciling stale', () => {
  const AMBIGUOUS = new Set(['timeout', 'network_error', 'invalid_response', 'http_error', 'persistence_error', 'stale_sending_unknown']);
  const isAmbiguous = (c: string | null) => c != null && (AMBIGUOUS.has(c) || c.startsWith('http_'));
  const T = NOW;
  const past = T - 1000;

  interface DueRow {
    status: string;
    nextAttemptAt?: number | null;
    reconciliationDueAt?: number | null;
    claimedAt?: number | null;
    attemptCount?: number;
    reconciliationAttemptCount?: number;
    maxAttempts?: number;
    lastErrorCode?: string | null;
    terminalAt?: number | null;
    manualReviewRequired?: boolean;
  }

  /** Modela EXACTAMENTE las tres ramas de 0005 (por fila). */
  function currentlySelectable(r: DueRow): boolean {
    if (r.terminalAt != null || r.manualReviewRequired) return false;
    const max = r.maxAttempts ?? 5;
    const sendDue =
      (r.status === 'pending' || r.status === 'failed') &&
      r.nextAttemptAt != null && r.nextAttemptAt <= T &&
      (r.attemptCount ?? 0) < max && !isAmbiguous(r.lastErrorCode ?? null);
    const reconDue =
      r.status === 'pending_reconciliation' &&
      r.reconciliationDueAt != null && r.reconciliationDueAt <= T &&
      (r.reconciliationAttemptCount ?? 0) < max;
    const staleSending =
      r.status === 'sending' && r.claimedAt != null && r.claimedAt < T - 120_000;
    return sendDue || reconDue || staleSending;
  }

  it('6. reconciling stale aislado NO es seleccionable por la función actual', () => {
    // Escenario exacto: confirmation sent (no vencida) + location reconciling
    // stale, sin ninguna otra fila vencida para el pedido.
    const confirmation: DueRow = { status: 'sent' };
    const locationReconcilingStale: DueRow = { status: 'reconciling', claimedAt: past - 600_000 };
    expect(currentlySelectable(confirmation)).toBe(false);
    expect(currentlySelectable(locationReconcilingStale)).toBe(false);
    // => El order_id NO se selecciona; claim_notification_reconciliation nunca
    // llega a ejecutarse. Brecha de descubrimiento (requiere 0006).
  });

  it('el SQL aplicado (0005) no contiene una rama de descubrimiento para reconciling', () => {
    const sql = readFileSync(
      fileURLToPath(new URL('../../../../supabase/migrations/0005_order_notification_recovery.sql', import.meta.url)),
      'utf8',
    );
    const start = sql.indexOf('function public.select_due_notification_orders');
    const body = sql.slice(start, sql.indexOf('$$;', start));
    // Ramas presentes hoy:
    expect(body).toContain("n.status in ('pending', 'failed')");
    expect(body).toContain("n.status = 'pending_reconciliation'");
    expect(body).toContain("n.status = 'sending'");
    // Rama ausente (la brecha):
    expect(body).not.toContain("n.status = 'reconciling'");
  });
});

// ── 0006: descubrimiento y cierre de reconciling stale (incl. agotado) ───────

describe('0006 — reconciling stale es descubrible incluso con intentos agotados', () => {
  const T = NOW;
  const STALE = 300_000; // 300 s, alineado con claim_notification_reconciliation

  interface DueRow {
    status: string;
    claimedAt?: number | null;
    reconciliationAttemptCount?: number;
    maxAttempts?: number;
    terminalAt?: number | null;
    manualReviewRequired?: boolean;
    /** Para location_request: si su confirmation hermana está sent. */
    confirmationSent?: boolean;
    notificationType?: NotificationType;
  }

  /** Modela SOLO la nueva rama 'reconciling' de 0006 (con guard de location). */
  function reconcilingSelectable(r: DueRow): boolean {
    if (r.terminalAt != null || r.manualReviewRequired) return false;
    const stale = r.status === 'reconciling' && r.claimedAt != null && r.claimedAt < T - STALE;
    if (!stale) return false;
    // Guard confirmation → location_request (idéntico a las otras ramas).
    if (r.notificationType === 'location_request' && r.confirmationSent !== true) return false;
    return true;
  }

  it('1. reconciling fresco NO es seleccionable (no se roba un claim vigente)', () => {
    expect(reconcilingSelectable({ status: 'reconciling', claimedAt: T - 10_000 })).toBe(false);
  });

  it('2. reconciling stale con intentos disponibles ES seleccionable', () => {
    expect(
      reconcilingSelectable({ status: 'reconciling', claimedAt: T - 600_000, reconciliationAttemptCount: 2, maxAttempts: 5 }),
    ).toBe(true);
  });

  it('3/4. reconciling stale con intentos AGOTADOS sigue siendo seleccionable', () => {
    // El punto de 0006: count = max NO lo excluye. La decisión (cerrar) la toma
    // terminalize_exhausted_reconciliation tras el descubrimiento.
    expect(
      reconcilingSelectable({ status: 'reconciling', claimedAt: T - 600_000, reconciliationAttemptCount: 5, maxAttempts: 5 }),
    ).toBe(true);
  });

  it('5. location_request reconciling stale con confirmation sent ES seleccionable', () => {
    expect(
      reconcilingSelectable({ status: 'reconciling', claimedAt: T - 600_000, notificationType: 'location_request', confirmationSent: true }),
    ).toBe(true);
  });

  it('6. location_request reconciling stale SIN confirmation sent NO es seleccionable', () => {
    expect(
      reconcilingSelectable({ status: 'reconciling', claimedAt: T - 600_000, notificationType: 'location_request', confirmationSent: false }),
    ).toBe(false);
  });

  it('fila terminal o en revisión manual nunca se descubre', () => {
    expect(reconcilingSelectable({ status: 'reconciling', claimedAt: T - 600_000, terminalAt: T - 1000 })).toBe(false);
    expect(reconcilingSelectable({ status: 'reconciling', claimedAt: T - 600_000, manualReviewRequired: true })).toBe(false);
  });

  it('10. el archivo 0006 añade la rama reconciling SIN filtro de intentos y la RPC de cierre', () => {
    const sql = readFileSync(
      fileURLToPath(new URL('../../../../supabase/migrations/0006_discover_stale_reconciling_notifications.sql', import.meta.url)),
      'utf8',
    );

    // Exactamente UNA definición de select_due_notification_orders (las demás
    // apariciones son grants/revokes, que no son definiciones).
    const defs = sql.match(/create or replace function public\.select_due_notification_orders/g) ?? [];
    expect(defs).toHaveLength(1);

    // La rama reconciling existe y usa 300 s; nunca la excluye por intentos.
    const start = sql.indexOf('function public.select_due_notification_orders');
    const body = sql.slice(start, sql.indexOf('$$;', start));
    expect(body).toContain("n.status = 'reconciling'");
    expect(body).toContain("n.claimed_at < now() - interval '300 seconds'");
    // La rama reconciling NO condiciona por reconciliation_attempt_count.
    const reconBranch = body.slice(body.indexOf("n.status = 'reconciling'"));
    expect(reconBranch).not.toContain('reconciliation_attempt_count');

    // RPC de cierre atómico presente, con sus guards y sin abrir envíos.
    expect(sql).toContain('function public.terminalize_exhausted_reconciliation');
    expect(sql).toMatch(/status\s+=\s+'failed'/);
    expect(sql).toContain("'reconciliation_attempts_exhausted'");
    expect(sql).toMatch(/manual_review_required\s+=\s+true/);
    expect(sql).toContain('for update');
    // El cierre limpia el claim y no toca external_message_id/sent_at.
    expect(sql).not.toMatch(/external_message_id\s+=/);

    // Conserva permisos service_role para ambas funciones.
    expect(sql).toContain('grant execute on function public.select_due_notification_orders(integer) to service_role;');
    expect(sql).toContain('grant execute on function public.terminalize_exhausted_reconciliation(uuid, text, integer) to service_role;');

    // Atómica y sin tocar otras tablas.
    expect(sql).toContain('begin;');
    expect(sql).toContain('commit;');
    expect(sql).not.toMatch(/alter table/i);
  });
});

// ── Escaneos de fuente ──────────────────────────────────────────────────────

describe('worker — sin envíos ocultos ni valores hardcodeados', () => {
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
  const workerSrc = read('./worker.ts');
  const handlerSrc = read('./worker-handler.ts');
  const routeSrc = read('../../../app/api/internal/order-notifications/worker/tick/route.ts');

  it('36. nunca usa initializeAndDispatch', () => {
    for (const s of [workerSrc, handlerSrc, routeSrc]) {
      expect(s).not.toContain('initializeAndDispatch');
    }
  });

  it('45. sin valores hardcodeados de cliente/producción', () => {
    for (const s of [workerSrc, handlerSrc, routeSrc]) {
      expect(s).not.toMatch(/La Fija/i);
      expect(s).not.toMatch(/ORD-\d{4,}/);
      expect(s).not.toMatch(/\bnorganizationId|restaurant_id\b/);
      expect(s).not.toMatch(/api\.kapso\.ai/);
      expect(s).not.toMatch(/\b\d{11,15}\b/); // sin números de teléfono
    }
  });

  it('la ruta declara runtime/dynamic/maxDuration y sólo POST', async () => {
    const route = await import('@/app/api/internal/order-notifications/worker/tick/route');
    expect(route.runtime).toBe('nodejs');
    expect(route.dynamic).toBe('force-dynamic');
    expect(route.maxDuration).toBe(60);
    expect(typeof route.POST).toBe('function');
    expect('GET' in route).toBe(false);
  });
});

// ── 6D.2C: worker DINÁMICO — order_received → location_request → confirmation ──

describe('runWorkerTick — delivery dinámico (3 fases)', () => {
  it('order_received pendiente: se envía primero; location queda bloqueada', async () => {
    const { deps, calls } = harness({
      orders: ['o1'],
      states: {
        o1: states([
          row({ notificationType: 'order_received', status: 'pending' }),
          row({ notificationType: 'location_request', status: 'pending' }),
          row({ notificationType: 'confirmation', status: 'pending' }),
        ]),
      },
    });
    const res = await runWorkerTick(deps);

    // Solo se envía order_received (1 POST/tick); la ubicación no se adelanta.
    expect(calls.send).toEqual([['o1', 'order_received']]);
    const loc = res.results.find((r) => r.notification_type === 'location_request');
    expect(loc?.outcome).toBe('blocked_by_order_received');
  });

  it('order_received ya enviado: la ubicación sí se procesa', async () => {
    const { deps, calls } = harness({
      orders: ['o1'],
      states: {
        o1: states([
          row({ notificationType: 'order_received', status: 'sent' }),
          row({ notificationType: 'location_request', status: 'pending' }),
        ]),
      },
    });
    await runWorkerTick(deps);

    // order_received 'sent' no reenvía; la ubicación es el único POST.
    expect(calls.send).toEqual([['o1', 'location_request']]);
  });
});
