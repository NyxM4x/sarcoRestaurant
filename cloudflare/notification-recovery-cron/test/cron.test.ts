import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  runNotificationRecoveryTick,
  type CronBindings,
  type CronDeps,
  type CronResponse,
} from '../src/cron';
import worker from '../src/index';

// ── Utilidades de prueba (sin red real) ─────────────────────────────────────

const okBody = () => ({
  ok: true,
  selected: 0,
  processed: 0,
  history_reads: 0,
  network_send_attempts: 0,
  budget_exhausted: false,
  results: [],
});

const jsonRes = (status: number, value: unknown): CronResponse => ({
  status,
  json: async () => value,
});
const badJsonRes = (status: number): CronResponse => ({
  status,
  json: async () => {
    throw new Error('not json');
  },
});

interface HarnessOpts {
  env?: CronBindings;
  fetch?: CronDeps['fetch'];
  response?: CronResponse;
  timeoutMs?: number;
  setTimer?: CronDeps['setTimer'];
}

function harness(opts: HarnessOpts = {}) {
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const fetchFn =
    opts.fetch ?? vi.fn(async (): Promise<CronResponse> => opts.response ?? jsonRes(200, okBody()));
  let clock = 0;
  const deps: CronDeps = {
    fetch: fetchFn,
    now: () => (clock += 5),
    log: (event, fields) => logs.push({ event, fields: fields ?? {} }),
    timeoutMs: opts.timeoutMs ?? 55_000,
    // Por defecto el timer NUNCA dispara (no hay timeout salvo que se pida).
    setTimer: opts.setTimer ?? (() => 0),
    clearTimer: () => {},
  };
  const env: CronBindings = opts.env ?? {
    WORKER_TICK_URL: 'https://endpoint.test/tick',
    WORKER_INTERNAL_TOKEN: 'tok-secret-value',
  };
  return { deps, env, logs, fetchFn };
}

const events = (logs: Array<{ event: string }>) => logs.map((l) => l.event);
const find = (logs: Array<{ event: string; fields: Record<string, unknown> }>, e: string) =>
  logs.find((l) => l.event === e);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── scheduled(): forma exacta de la única petición ──────────────────────────

describe('scheduled — una sola llamada con la forma exacta', () => {
  async function runScheduled(fetchMock: ReturnType<typeof vi.fn>) {
    vi.stubGlobal('fetch', fetchMock);
    let captured: Promise<unknown> | undefined;
    const ctx = {
      waitUntil: (p: Promise<unknown>) => {
        captured = p;
      },
      passThroughOnException: () => {},
    };
    await worker.scheduled(
      { scheduledTime: 1, cron: '* * * * *' },
      { WORKER_TICK_URL: 'https://endpoint.test/tick', WORKER_INTERNAL_TOKEN: 'tok-123' },
      ctx,
    );
    await captured;
  }

  it('1/2/3/4/5. exactamente un POST, body {}, Content-Type y Bearer del secret', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(okBody()), { status: 200 }));
    await runScheduled(fetchMock);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://endpoint.test/tick');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{}');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok-123');
  });

  it('6. la petición no incluye order_id ni datos de clientes', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(okBody()), { status: 200 }));
    await runScheduled(fetchMock);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const serialized = JSON.stringify({ body: init.body, headers: init.headers });
    for (const forbidden of ['order_id', 'order_number', 'restaurant', 'notification_type', 'phone']) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(init.body).toBe('{}');
  });

  it('20. una ejecución nunca hace más de un POST', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(okBody()), { status: 200 }));
    await runScheduled(fetchMock);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ── Health check inerte ─────────────────────────────────────────────────────

describe('fetch() — health check que NUNCA dispara el tick', () => {
  it('responde 200 con estado y no realiza ninguna llamada saliente', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await worker.fetch();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status?: string };
    expect(body.status).toBe('ok');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ── Política de respuestas (núcleo) ─────────────────────────────────────────

describe('runNotificationRecoveryTick — política de respuestas', () => {
  it('7/8. HTTP 200 y tick vacío → cron_completed', async () => {
    const h = harness({ response: jsonRes(200, okBody()) });
    await runNotificationRecoveryTick(h.env, h.deps);
    expect(events(h.logs)).toContain('cron_completed');
    const c = find(h.logs, 'cron_completed');
    expect(c?.fields.ok).toBe(true);
    expect(c?.fields.selected).toBe(0);
    expect(c?.fields.results_count).toBe(0);
    expect(h.fetchFn).toHaveBeenCalledTimes(1);
  });

  it('cron_completed registra los contadores de alerta de forma sanitizada', async () => {
    const h = harness({
      response: jsonRes(200, {
        ...okBody(),
        alerts_selected: 1,
        alert_send_attempts: 1,
        alerts_sent: 1,
        alerts_rescheduled: 0,
      }),
    });
    await runNotificationRecoveryTick(h.env, h.deps);
    const c = find(h.logs, 'cron_completed');
    expect(c?.fields.alerts_selected).toBe(1);
    expect(c?.fields.alert_send_attempts).toBe(1);
    expect(c?.fields.alerts_sent).toBe(1);
    expect(c?.fields.alerts_rescheduled).toBe(0);
    // Nunca el contenido de la alerta.
    expect(JSON.stringify(h.logs)).not.toContain('chat_id');
  });

  it('9. budget_exhausted=true sigue siendo éxito controlado (cron_completed)', async () => {
    const h = harness({ response: jsonRes(200, { ...okBody(), budget_exhausted: true, selected: 5, network_send_attempts: 1 }) });
    await runNotificationRecoveryTick(h.env, h.deps);
    const c = find(h.logs, 'cron_completed');
    expect(c).toBeDefined();
    expect(c?.fields.budget_exhausted).toBe(true);
    expect(c?.fields.network_send_attempts).toBe(1);
    expect(events(h.logs)).not.toContain('cron_upstream_error');
  });

  it('10. HTTP 401 → cron_unauthorized', async () => {
    const h = harness({ response: jsonRes(401, { error: 'unauthorized' }) });
    await runNotificationRecoveryTick(h.env, h.deps);
    expect(events(h.logs)).toContain('cron_unauthorized');
  });

  it('11. HTTP 405 → cron_contract_error', async () => {
    const h = harness({ response: jsonRes(405, { error: 'method_not_allowed' }) });
    await runNotificationRecoveryTick(h.env, h.deps);
    expect(events(h.logs)).toContain('cron_contract_error');
  });

  it('12. HTTP 422 → cron_contract_error', async () => {
    const h = harness({ response: jsonRes(422, { error: 'validation_error' }) });
    await runNotificationRecoveryTick(h.env, h.deps);
    expect(events(h.logs)).toContain('cron_contract_error');
  });

  it('13. HTTP 429 → cron_rate_limited', async () => {
    const h = harness({ response: jsonRes(429, {}) });
    await runNotificationRecoveryTick(h.env, h.deps);
    expect(events(h.logs)).toContain('cron_rate_limited');
  });

  it('14/19. HTTP 500 → cron_upstream_error y NINGÚN segundo POST', async () => {
    const h = harness({ response: jsonRes(500, {}) });
    await runNotificationRecoveryTick(h.env, h.deps);
    expect(events(h.logs)).toContain('cron_upstream_error');
    expect(h.fetchFn).toHaveBeenCalledTimes(1);
  });

  it('15. respuesta no JSON → cron_invalid_response', async () => {
    const h = harness({ response: badJsonRes(200) });
    await runNotificationRecoveryTick(h.env, h.deps);
    expect(events(h.logs)).toContain('cron_invalid_response');
  });

  it('estado inesperado (404) → cron_contract_error, sin segundo POST', async () => {
    const h = harness({ response: jsonRes(404, {}) });
    await runNotificationRecoveryTick(h.env, h.deps);
    expect(events(h.logs)).toContain('cron_contract_error');
    expect(h.fetchFn).toHaveBeenCalledTimes(1);
  });

  it('16. error de red → cron_network_error', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('connection reset');
    });
    const h = harness({ fetch: fetchFn });
    await runNotificationRecoveryTick(h.env, h.deps);
    expect(events(h.logs)).toContain('cron_network_error');
    expect(events(h.logs)).not.toContain('cron_timeout');
  });

  it('17/18. timeout → cron_timeout y NINGÚN segundo POST', async () => {
    const fetchFn = vi.fn(
      (_url: string, init: { signal: AbortSignal }): Promise<CronResponse> =>
        new Promise((_resolve, reject) => {
          const abort = () => {
            const e = new Error('aborted');
            e.name = 'AbortError';
            reject(e);
          };
          if (init.signal.aborted) abort();
          else init.signal.addEventListener('abort', abort);
        }),
    );
    // El timer dispara de inmediato → aborta antes/durante el fetch.
    const h = harness({ fetch: fetchFn as unknown as CronDeps['fetch'], setTimer: (cb) => { cb(); return 0; } });
    await runNotificationRecoveryTick(h.env, h.deps);
    expect(events(h.logs)).toContain('cron_timeout');
    expect(events(h.logs)).not.toContain('cron_network_error');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

// ── Logs saneados ───────────────────────────────────────────────────────────

describe('logs saneados — nunca exponen secretos ni datos de pedidos', () => {
  it('21/22/23/24. sin token, sin Authorization, sin URL, sin datos de pedidos', async () => {
    const h = harness({
      env: { WORKER_TICK_URL: 'https://endpoint.test/tick?x=1', WORKER_INTERNAL_TOKEN: 'super-secret-token' },
      response: jsonRes(200, {
        ...okBody(),
        selected: 2,
        results: [{ order_id: 'ORD-SECRET-999', notification_type: 'confirmation' }],
      }),
    });
    await runNotificationRecoveryTick(h.env, h.deps);
    const dump = JSON.stringify(h.logs);
    expect(dump).not.toContain('super-secret-token');
    expect(dump).not.toContain('Authorization');
    expect(dump).not.toContain('endpoint.test/tick');
    expect(dump).not.toContain('ORD-SECRET-999');
    expect(dump).not.toContain('order_id');
    // Solo el recuento de resultados viaja al log.
    expect(find(h.logs, 'cron_completed')?.fields.results_count).toBe(1);
  });
});

// ── Configuración ausente ───────────────────────────────────────────────────

describe('configuración ausente — fallo local seguro y CERO POST', () => {
  it('25. falta WORKER_TICK_URL → cero POST', async () => {
    const h = harness({ env: { WORKER_INTERNAL_TOKEN: 'tok' } });
    await runNotificationRecoveryTick(h.env, h.deps);
    expect(h.fetchFn).not.toHaveBeenCalled();
    expect(find(h.logs, 'cron_contract_error')?.fields.reason).toBe('missing_url');
  });

  it('26. falta WORKER_INTERNAL_TOKEN → cero POST', async () => {
    const h = harness({ env: { WORKER_TICK_URL: 'https://endpoint.test/tick' } });
    await runNotificationRecoveryTick(h.env, h.deps);
    expect(h.fetchFn).not.toHaveBeenCalled();
    expect(find(h.logs, 'cron_contract_error')?.fields.reason).toBe('missing_token');
  });
});

// ── Configuración Wrangler y ausencia de lógica por cliente ──────────────────

/** Elimina comentarios // y /* *\/ respetando el contenido de las cadenas. */
function stripJsonc(s: string): string {
  let out = '';
  let inStr = false;
  let strCh = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const n = s[i + 1];
    if (inStr) {
      out += c;
      if (c === '\\') {
        out += n ?? '';
        i++;
        continue;
      }
      if (c === strCh) inStr = false;
      continue;
    }
    if (c === '"' || c === "'") {
      inStr = true;
      strCh = c;
      out += c;
      continue;
    }
    if (c === '/' && n === '/') {
      while (i < s.length && s[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && n === '*') {
      i += 2;
      while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++;
      i++;
      continue;
    }
    out += c;
  }
  return out;
}

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

describe('wrangler.jsonc — un único Cron compartido, secret obligatorio, sin valores', () => {
  const raw = read('../wrangler.jsonc');
  const cfg = JSON.parse(stripJsonc(raw)) as {
    name: string;
    compatibility_date: string;
    triggers: { crons: string[] };
    vars: Record<string, unknown>;
    secrets?: { required?: string[] };
  };

  it('27. contiene exactamente un Cron Trigger', () => {
    expect(Array.isArray(cfg.triggers.crons)).toBe(true);
    expect(cfg.triggers.crons).toHaveLength(1);
  });

  it('28. el Cron es una vez por minuto', () => {
    expect(cfg.triggers.crons[0]).toBe('* * * * *');
  });

  it('compatibility_date actualizada a 2026-07-31', () => {
    expect(cfg.compatibility_date).toBe('2026-07-31');
  });

  it('secrets.required declara exactamente WORKER_INTERNAL_TOKEN', () => {
    expect(cfg.secrets?.required).toEqual(['WORKER_INTERNAL_TOKEN']);
  });

  it('el token NO está como valor en la configuración (solo como var pública la URL)', () => {
    // No aparece como clave con valor (vars/secret con valor), solo como
    // elemento de `secrets.required`.
    expect(cfg.vars.WORKER_INTERNAL_TOKEN).toBeUndefined();
    expect(raw).not.toMatch(/"WORKER_INTERNAL_TOKEN"\s*:/);
    // Nunca se filtra el nombre del secreto de Vercel ni un valor hardcodeado.
    expect(raw).not.toContain('VERCEL_INTERNAL_TOKEN');
    // Ningún placeholder que pudiera desplegarse como secreto real.
    expect(raw).not.toMatch(/Bearer\s+\S/);
    expect(cfg.vars.WORKER_TICK_URL).toBe(
      'https://la-fija-orders.vercel.app/api/internal/order-notifications/worker/tick',
    );
  });
});

describe('29/30 — sin hardcodeos de restaurantes ni lógica por cliente', () => {
  // Se evalúa el CÓDIGO sin comentarios: la documentación puede mencionar
  // "restaurante" (un único Cron compartido), pero la lógica no debe ramificar
  // por cliente ni contener identificadores/listas de tenants.
  const sources = [read('../src/cron.ts'), read('../src/index.ts')].map(stripJsonc);

  it('el código del worker no contiene lógica ni listas por restaurante/tenant', () => {
    for (const code of sources) {
      expect(code).not.toMatch(/restaurant/i);
      expect(code).not.toMatch(/\btenant\b/i);
      expect(code).not.toMatch(/organization_id/i);
      expect(code).not.toMatch(/per[_-]?client/i);
      expect(code).not.toMatch(/ORD-\d{4,}/);
      // Un solo endpoint configurado por variable: sin arrays de URLs.
      expect(code).not.toMatch(/https?:\/\//);
    }
  });
});
