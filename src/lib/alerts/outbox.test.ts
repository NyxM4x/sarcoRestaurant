import { describe, it, expect } from 'vitest';
import {
  ALERT_BACKOFF_SECONDS,
  MAX_RETRY_AFTER_SECONDS,
  backoffSecondsFor,
  dispositionForOutcome,
  nextAttemptAt,
  type AlertSendOutcome,
  type TelegramAlertRow,
} from './outbox';
import {
  runAlertOutboxTick,
  runClaimedAlert,
  trySendNow,
  type AlertOutboxStore,
} from './outbox-runner';

const NOW = Date.parse('2026-09-01T03:00:00.000Z');

const fila = (over: Partial<TelegramAlertRow> = {}): TelegramAlertRow => ({
  id: 'alert-1',
  kind: 'delivery_notice',
  targetRef: 'order-1',
  body: 'Pedido ORD-000001 …',
  attempts: 1,
  maxAttempts: 5,
  ...over,
});

/** Doble del store que registra cada escritura. */
function store(filas: TelegramAlertRow[] = []) {
  const escrituras: Array<{ op: string; id: string; arg?: string }> = [];
  const s: AlertOutboxStore = {
    async claimDue(limit) {
      return filas.slice(0, limit);
    },
    async claimById(id) {
      return filas.find((f) => f.id === id) ?? null;
    },
    async markSent(id, at) {
      escrituras.push({ op: 'sent', id, arg: at });
    },
    async reschedule(id, at, error) {
      escrituras.push({ op: 'reschedule', id, arg: `${at}|${error}` });
    },
    async markFailed(id, error) {
      escrituras.push({ op: 'failed', id, arg: error });
    },
  };
  return { s, escrituras };
}

const deps = (s: AlertOutboxStore, outcome: AlertSendOutcome, enviados: string[] = []) => ({
  store: s,
  send: async (_k: TelegramAlertRow['kind'], body: string) => {
    enviados.push(body);
    return outcome;
  },
  now: () => NOW,
});

describe('outbox — el estado se escribe DESPUÉS del envío', () => {
  it('un envío confirmado marca `sent`, y solo entonces', () => {
    // La inversión que arregla el fallo: antes se marcaba enviado y luego se
    // mandaba, así que un fallo de Telegram dejaba el pedido marcado para
    // siempre sin que nadie saliera a repartirlo.
    expect(dispositionForOutcome({ kind: 'sent' }, 1, 5)).toEqual({ kind: 'sent' });
  });

  it('un fallo transitorio devuelve la alerta a la cola, NO la cierra', async () => {
    const { s, escrituras } = store();
    const r = await runClaimedAlert(fila(), deps(s, { kind: 'transient', code: 'timeout' }));
    expect(r).toBe('rescheduled');
    expect(escrituras[0].op).toBe('reschedule');
    expect(escrituras[0].arg).toContain('transient:timeout');
  });

  it('nunca marca `sent` lo que no salió', async () => {
    for (const outcome of [
      { kind: 'transient', code: 'x' },
      { kind: 'rate_limited' },
      { kind: 'permanent', code: 'http_403' },
      { kind: 'invalid' },
    ] as AlertSendOutcome[]) {
      const { s, escrituras } = store();
      await runClaimedAlert(fila(), deps(s, outcome));
      expect(escrituras.some((e) => e.op === 'sent'), outcome.kind).toBe(false);
    }
  });
});

describe('outbox — qué se reintenta y qué no', () => {
  it('un chat inexistente o un token malo NO se reintentan', () => {
    // Cinco intentos darían cinco fallos idénticos y retrasarían media hora el
    // momento en que una persona ve el problema.
    const d = dispositionForOutcome({ kind: 'permanent', code: 'http_403' }, 1, 5);
    expect(d).toEqual({ kind: 'failed', error: 'permanent:http_403' });
  });

  it('una respuesta ilegible NO se reintenta: el mensaje pudo salir', () => {
    // En el grupo de reparto un duplicado es peor que una ausencia: dos
    // personas podrían salir con el mismo pedido.
    expect(dispositionForOutcome({ kind: 'invalid' }, 1, 5)).toEqual({
      kind: 'failed',
      error: 'invalid_response',
    });
  });

  it('agotados los intentos, se rinde y queda visible', () => {
    const d = dispositionForOutcome({ kind: 'transient', code: 'x' }, 5, 5);
    expect(d.kind).toBe('failed');
    expect(d).toMatchObject({ error: 'exhausted:transient:x' });
  });

  it('el backoff crece y se estabiliza en el último tramo', () => {
    expect(ALERT_BACKOFF_SECONDS.map((_, i) => backoffSecondsFor(i + 1)))
      .toEqual([...ALERT_BACKOFF_SECONDS]);
    // Más allá del último tramo no crece indefinidamente.
    expect(backoffSecondsFor(99)).toBe(ALERT_BACKOFF_SECONDS[ALERT_BACKOFF_SECONDS.length - 1]);
  });

  it('respeta el `retry_after` de Telegram, con un techo', () => {
    const corto = dispositionForOutcome({ kind: 'rate_limited', retryAfterSeconds: 300 }, 1, 5);
    expect(corto).toMatchObject({ kind: 'retry', delaySeconds: 300 });

    // Un 429 con una espera enorme dejaría el aviso para mañana.
    const largo = dispositionForOutcome({ kind: 'rate_limited', retryAfterSeconds: 99_999 }, 1, 5);
    expect(largo).toMatchObject({ delaySeconds: MAX_RETRY_AFTER_SECONDS });
  });

  it('un `retry_after` menor que el backoff no acelera el reintento', () => {
    const d = dispositionForOutcome({ kind: 'rate_limited', retryAfterSeconds: 1 }, 1, 5);
    expect(d).toMatchObject({ delaySeconds: backoffSecondsFor(1) });
  });
});

describe('outbox — el tick y el fast path', () => {
  it('el tick procesa lo vencido y cuenta cada desenlace', async () => {
    const { s } = store([fila({ id: 'a' }), fila({ id: 'b' })]);
    const r = await runAlertOutboxTick(deps(s, { kind: 'sent' }));
    expect(r).toEqual({ ok: true, claimed: 2, sent: 2, rescheduled: 0, failed: 0 });
  });

  it('el fast path manda la alerta recién encolada', async () => {
    const enviados: string[] = [];
    const { s, escrituras } = store([fila({ id: 'a', body: 'texto' })]);
    const r = await trySendNow('a', deps(s, { kind: 'sent' }, enviados));
    expect(r).toBe('sent');
    expect(enviados).toEqual(['texto']);
    expect(escrituras[0].op).toBe('sent');
  });

  it('si otro la tiene reclamada, el fast path se retira sin tocar nada', async () => {
    const enviados: string[] = [];
    const { s, escrituras } = store([]);
    expect(await trySendNow('a', deps(s, { kind: 'sent' }, enviados))).toBe('skipped');
    expect(enviados).toEqual([]);
    expect(escrituras).toEqual([]);
  });

  it('un fallo del transporte no tumba a quien encoló', async () => {
    const { s } = store([fila({ id: 'a' })]);
    const rotas = {
      store: s,
      send: async () => {
        throw new Error('red caída');
      },
      now: () => NOW,
    };
    // Se trata como transitorio: no se marca enviado algo que no se sabe.
    expect(await trySendNow('a', rotas)).toBe('rescheduled');
  });
});

describe('outbox — la próxima cita', () => {
  it('agenda en el futuro, en ISO', () => {
    expect(nextAttemptAt(NOW, 30)).toBe(new Date(NOW + 30_000).toISOString());
  });
});
