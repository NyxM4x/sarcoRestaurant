import { describe, it, expect } from 'vitest';
import {
  runAlertPass,
  type AlertRunnerDeps,
  type AlertClaimResult,
  type AlertRescheduleResult,
} from './alert-runner';
import type { TelegramOutcome } from '@/lib/alerts/telegram';

const NOW = Date.parse('2026-07-31T18:05:00.000Z');

interface Calls {
  select: number;
  claim: string[];
  send: string[];
  mark: Array<[string, string]>;
  reschedule: Array<[string, string, string]>;
}

interface Opts {
  ids?: string[];
  claim?: (id: string) => AlertClaimResult;
  send?: (text: string) => TelegramOutcome;
  mark?: boolean;
  markThrows?: boolean;
  reschedule?: AlertRescheduleResult;
}

function harness(opts: Opts = {}) {
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const calls: Calls = { select: 0, claim: [], send: [], mark: [], reschedule: [] };
  const grantedClaim = (id: string): AlertClaimResult => ({
    claimed: true,
    notificationId: id,
    claimToken: 'tok-' + id,
    notificationType: 'confirmation',
    orderNumber: 'ORD-000042',
    reasonCode: 'provider_failed',
    reviewKind: 'manual_review',
  });
  const deps: AlertRunnerDeps = {
    async selectDueAlerts() {
      calls.select += 1;
      return opts.ids ?? [];
    },
    async claimAlert(id) {
      calls.claim.push(id);
      return opts.claim ? opts.claim(id) : grantedClaim(id);
    },
    async sendAlert(text) {
      calls.send.push(text);
      return opts.send ? opts.send(text) : { kind: 'sent' };
    },
    async markAlerted(id, token) {
      calls.mark.push([id, token]);
      if (opts.markThrows) throw new Error('persist_error');
      return opts.mark ?? true;
    },
    async rescheduleAlert(id, token, code) {
      calls.reschedule.push([id, token, code]);
      return opts.reschedule ?? { rescheduled: true, terminal: false };
    },
    now: () => NOW,
  };
  const log = (event: string, fields?: Record<string, unknown>) =>
    logs.push({ event, fields: fields ?? {} });
  return {
    calls,
    logs,
    run: (budget = 1, limit = 5) => runAlertPass(deps, budget, log, limit),
  };
}

describe('runAlertPass — selección y envío', () => {
  it('1. sin incidencias → cero llamadas Telegram', async () => {
    const h = harness({ ids: [] });
    const r = await h.run();
    expect(h.calls.send).toHaveLength(0);
    expect(r).toMatchObject({ alerts_selected: 0, alert_send_attempts: 0, alerts_sent: 0, alerts_rescheduled: 0 });
  });

  it('2. manual_review pendiente → una alerta enviada y marcada', async () => {
    const h = harness({ ids: ['n1'] });
    const r = await h.run();
    expect(h.calls.send).toHaveLength(1);
    expect(h.calls.mark).toEqual([['n1', 'tok-n1']]);
    expect(r.alerts_sent).toBe(1);
    expect(r.alert_send_attempts).toBe(1);
  });

  it('3. incidencia terminal → una alerta', async () => {
    const h = harness({ ids: ['n1'], claim: (id) => ({ claimed: true, notificationId: id, claimToken: 't', notificationType: 'location_request', orderNumber: 'ORD-1', reasonCode: 'reconciliation_attempts_exhausted', reviewKind: 'terminal' }) });
    const r = await h.run();
    expect(r.alerts_sent).toBe(1);
    expect(h.calls.send).toHaveLength(1);
  });

  it('4. misma incidencia ya alertada → claim denegado, cero envío', async () => {
    const h = harness({ ids: ['n1'], claim: () => ({ claimed: false, reason: 'already_alerted' }) });
    const r = await h.run();
    expect(h.calls.send).toHaveLength(0);
    expect(r.alerts_sent).toBe(0);
    expect(h.logs.some((l) => l.event === 'alert_skipped')).toBe(true);
  });

  it('5. dos workers concurrentes → un solo claim ganador', async () => {
    // Simula: el primer claim gana, el segundo ve in_flight.
    let granted = false;
    const claim = (id: string): AlertClaimResult =>
      granted ? { claimed: false, reason: 'in_flight' } : ((granted = true), { claimed: true, notificationId: id, claimToken: 't', notificationType: 'confirmation', orderNumber: 'O', reasonCode: 'x', reviewKind: 'manual_review' });
    const a = harness({ ids: ['n1'], claim });
    const b = harness({ ids: ['n1'], claim });
    const ra = await a.run();
    const rb = await b.run();
    expect(ra.alerts_sent + rb.alerts_sent).toBe(1);
    expect(a.calls.send.length + b.calls.send.length).toBe(1);
  });

  it('6/7. claim fresco (in_flight) no se roba → cero envío', async () => {
    const h = harness({ ids: ['n1'], claim: () => ({ claimed: false, reason: 'in_flight' }) });
    const r = await h.run();
    expect(h.calls.send).toHaveLength(0);
    expect(r.alert_send_attempts).toBe(0);
  });

  it('9/10. dos alertas pendientes → solo una por tick (budget 1)', async () => {
    const h = harness({ ids: ['n1', 'n2'] });
    const r = await h.run(1);
    expect(h.calls.send).toHaveLength(1);
    expect(r.alert_send_attempts).toBe(1);
    expect(h.logs.some((l) => l.event === 'alert_budget_exhausted')).toBe(true);
  });

  it('11. Telegram 200 → markAlerted invocado (alerted_at)', async () => {
    const h = harness({ ids: ['n1'], send: () => ({ kind: 'sent' }) });
    await h.run();
    expect(h.calls.mark).toHaveLength(1);
  });
});

describe('runAlertPass — resultados de Telegram no exitosos', () => {
  const cases: Array<[string, TelegramOutcome, string]> = [
    ['12. 400 permanente', { kind: 'permanent', code: 'http_400' }, 'telegram_permanent'],
    ['13. 429', { kind: 'rate_limited', retryAfterSeconds: 30 }, 'telegram_rate_limited'],
    ['14/15/16. transitorio', { kind: 'transient', code: 'timeout' }, 'telegram_transient'],
    ['17. inválido', { kind: 'invalid' }, 'telegram_invalid'],
  ];
  for (const [name, outcome, code] of cases) {
    it(name + ' → reprograma, NO marca enviada', async () => {
      const h = harness({ ids: ['n1'], send: () => outcome });
      const r = await h.run();
      expect(h.calls.mark).toHaveLength(0); // nunca se marca enviada
      expect(h.calls.reschedule).toEqual([['n1', 'tok-n1', code]]);
      expect(r.alerts_rescheduled).toBe(1);
      expect(r.alerts_sent).toBe(0);
    });
  }

  it('19. fallo de Telegram solo reprograma la ALERTA (no toca WhatsApp)', async () => {
    // AlertRunnerDeps no expone ningún método que modifique la notificación
    // WhatsApp: estructuralmente imposible. Ante fallo, solo reschedule.
    const h = harness({ ids: ['n1'], send: () => ({ kind: 'transient', code: 'http_500' }) });
    await h.run();
    expect(h.calls.reschedule).toHaveLength(1);
    expect(h.calls.mark).toHaveLength(0);
  });

  it('reschedule terminal (intentos agotados) → alert_terminal, sin contar rescheduled', async () => {
    const h = harness({ ids: ['n1'], send: () => ({ kind: 'permanent', code: 'http_400' }), reschedule: { rescheduled: false, terminal: true } });
    const r = await h.run();
    expect(r.alerts_rescheduled).toBe(0);
    expect(h.logs.some((l) => l.event === 'alert_terminal')).toBe(true);
  });
});

describe('runAlertPass — persistencia ambigua y aislamiento', () => {
  it('18. persistencia falla tras Telegram 200 → sin segundo envío en el tick', async () => {
    const h = harness({ ids: ['n1', 'n2'], markThrows: true });
    const r = await h.run(1);
    expect(h.calls.send).toHaveLength(1); // el intento consumió el presupuesto
    expect(r.alerts_sent).toBe(0); // no se pudo confirmar
    expect(h.logs.some((l) => l.event === 'alert_error')).toBe(true);
  });

  it('un claim denegado NO consume presupuesto: otra alerta sí se envía', async () => {
    let first = true;
    const claim = (id: string): AlertClaimResult =>
      first ? ((first = false), { claimed: false, reason: 'in_flight' }) : { claimed: true, notificationId: id, claimToken: 't', notificationType: 'confirmation', orderNumber: 'O', reasonCode: 'x', reviewKind: 'manual_review' };
    const h = harness({ ids: ['n1', 'n2'], claim });
    const r = await h.run(1);
    expect(h.calls.send).toHaveLength(1);
    expect(r.alerts_sent).toBe(1);
  });

  it('29. los logs no exponen el número de pedido ni el texto de la alerta', async () => {
    const h = harness({ ids: ['n1'] });
    await h.run();
    const dump = JSON.stringify(h.logs);
    expect(dump).not.toContain('ORD-000042');
    expect(dump).not.toContain('Revisión requerida');
    expect(dump).not.toContain('chat_id');
  });
});
