import { describe, it, expect } from 'vitest';
import {
  runAlertOutboxTick,
  TICK_TIMEOUT_MS,
  type CronBindings,
  type CronDeps,
  type CronFetchInit,
  type CronResponse,
} from '../src/cron';

/**
 * Pruebas sin red real, sin secretos reales y sin relojes reales.
 *
 * Lo que se protege aquí no es "que llame": es que llame UNA sola vez, que no
 * reintente por su cuenta, y que nunca escriba en el log algo que no debería
 * salir de este proceso.
 */

const ENV: CronBindings = {
  WORKER_TICK_URL: 'https://ejemplo.test/api/internal/telegram-alerts/worker/tick',
  WORKER_INTERNAL_TOKEN: 'token-de-prueba',
};

interface Recorded {
  url: string;
  init: CronFetchInit;
}

function harness(
  responder: () => Promise<CronResponse>,
  overrides: Partial<CronDeps> = {},
) {
  const requests: Recorded[] = [];
  const logs: { event: string; fields: Record<string, unknown> }[] = [];
  let clock = 1_000;

  const deps: CronDeps = {
    async fetch(url, init) {
      requests.push({ url, init });
      clock += 250;
      return responder();
    },
    now: () => clock,
    log: (event, fields = {}) => logs.push({ event, fields }),
    timeoutMs: TICK_TIMEOUT_MS,
    setTimer: () => 0,
    clearTimer: () => {},
    ...overrides,
  };

  return { deps, requests, logs, event: (n: string) => logs.find((l) => l.event === n) };
}

function jsonResponse(status: number, body: unknown): CronResponse {
  return { status, json: async () => body };
}

/** Contrato REAL de `/api/internal/telegram-alerts/worker/tick`. */
const TICK_OK = { ok: true, claimed: 2, sent: 2, rescheduled: 0, failed: 0 };

describe('cron — la petición', () => {
  it('hace EXACTAMENTE un POST, con Bearer y cuerpo {}', async () => {
    const h = harness(async () => jsonResponse(200, TICK_OK));
    await runAlertOutboxTick(ENV, h.deps);

    expect(h.requests).toHaveLength(1);
    const { url, init } = h.requests[0];
    expect(url).toBe(ENV.WORKER_TICK_URL);
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{}');
    expect(init.headers.Authorization).toBe('Bearer token-de-prueba');
    expect(init.headers['Content-Type']).toBe('application/json');
  });

  it('el cuerpo no lleva NADA: el caller no elige qué se recupera', async () => {
    const h = harness(async () => jsonResponse(200, TICK_OK));
    await runAlertOutboxTick(ENV, h.deps);

    // Ni id, ni evento, ni teléfono, ni límites, ni timestamps. Si el caller
    // pudiera elegir, este Worker dejaría de ser un despertador.
    expect(JSON.parse(h.requests[0].init.body)).toEqual({});
  });

  it('apunta al endpoint de webhook-events, no al de notificaciones', async () => {
    const h = harness(async () => jsonResponse(200, TICK_OK));
    await runAlertOutboxTick(ENV, h.deps);

    expect(h.requests[0].url).toContain('/telegram-alerts/worker/tick');
    // Ni el de webhooks ni el de notificaciones: este paquete nace copiado del
    // primero, y apuntar al worker de origen es el error fácil de cometer.
    expect(h.requests[0].url).not.toContain('webhook-events');
    expect(h.requests[0].url).not.toContain('order-notifications');
  });
});

describe('cron — configuración ausente: cero POST', () => {
  it('sin URL no llama a nadie', async () => {
    const h = harness(async () => jsonResponse(200, TICK_OK));
    await runAlertOutboxTick({ WORKER_INTERNAL_TOKEN: 'x' }, h.deps);

    expect(h.requests).toEqual([]);
    expect(h.event('cron_contract_error')?.fields.reason).toBe('missing_url');
  });

  it('sin token no llama a nadie: nunca se dispara sin autenticar', async () => {
    const h = harness(async () => jsonResponse(200, TICK_OK));
    await runAlertOutboxTick({ WORKER_TICK_URL: ENV.WORKER_TICK_URL }, h.deps);

    expect(h.requests).toEqual([]);
    expect(h.event('cron_contract_error')?.fields.reason).toBe('missing_token');
  });
});

describe('cron — traducción de la respuesta', () => {
  it('200 con el contrato real: registra claimed/sent/rescheduled/failed', async () => {
    const h = harness(async () => jsonResponse(200, TICK_OK));
    await runAlertOutboxTick(ENV, h.deps);

    expect(h.event('cron_started')).toBeDefined();
    expect(h.event('cron_completed')?.fields).toMatchObject({
      status: 200,
      ok: true,
      claimed: 2,
      sent: 2,
      rescheduled: 0,
      failed: 0,
    });
    expect(h.event('cron_completed')?.fields.duration_ms).toBeGreaterThan(0);
  });

  it('no inventa campos de los otros dos workers', async () => {
    const h = harness(async () => jsonResponse(200, TICK_OK));
    await runAlertOutboxTick(ENV, h.deps);

    const fields = h.event('cron_completed')!.fields;
    // Un log que informa de algo que este endpoint no devuelve parece una
    // medición y no lo es. `processed` y `budget_exhausted` son del inbox de
    // webhooks; este endpoint no los devuelve.
    for (const ajeno of ['processed', 'budget_exhausted', 'selected', 'history_reads']) {
      expect(fields, ajeno).not.toHaveProperty(ajeno);
    }
  });

  it('un tick sin trabajo es un no-op sano, no un error', async () => {
    // Es el caso NORMAL: el camino habitual es el fast path del que encola, y
    // esto solo recoge lo que aquel no consiguió mandar.
    const h = harness(async () =>
      jsonResponse(200, { ok: true, claimed: 0, sent: 0, rescheduled: 0, failed: 0 }),
    );
    await runAlertOutboxTick(ENV, h.deps);

    expect(h.event('cron_completed')?.fields).toMatchObject({ ok: true, claimed: 0 });
  });

  it('alertas reprogramadas y agotadas se registran, y no tiñen el tick de rojo', async () => {
    // `rescheduled` es el sistema funcionando: Telegram falló y la alerta vuelve
    // con backoff. `failed` son las que agotaron intentos y quedan visibles en
    // el panel para que una persona avise a mano — el tick las cerró bien.
    const h = harness(async () =>
      jsonResponse(200, { ok: true, claimed: 3, sent: 1, rescheduled: 1, failed: 1 }),
    );
    await runAlertOutboxTick(ENV, h.deps);

    expect(h.event('cron_completed')?.fields).toMatchObject({
      ok: true,
      rescheduled: 1,
      failed: 1,
    });
    expect(h.event('cron_upstream_error')).toBeUndefined();
  });

  it('200 ilegible o con forma rara: cron_invalid_response, sin reventar', async () => {
    const roto = harness(async () => ({
      status: 200,
      json: async () => {
        throw new Error('no es JSON');
      },
    }));
    await runAlertOutboxTick(ENV, roto.deps);
    expect(roto.event('cron_invalid_response')).toBeDefined();

    const array = harness(async () => jsonResponse(200, [1, 2, 3]));
    await runAlertOutboxTick(ENV, array.deps);
    expect(array.event('cron_invalid_response')).toBeDefined();
  });
});

describe('cron — errores: se registran y NO se reintenta', () => {
  const casos: [number, string][] = [
    [401, 'cron_unauthorized'],
    [405, 'cron_contract_error'],
    [422, 'cron_contract_error'],
    [400, 'cron_contract_error'],
    [429, 'cron_rate_limited'],
    [500, 'cron_upstream_error'],
    [503, 'cron_upstream_error'],
    [404, 'cron_contract_error'],
    [302, 'cron_contract_error'],
  ];

  for (const [status, evento] of casos) {
    it(`${status} → ${evento}, con UN solo POST`, async () => {
      const h = harness(async () => jsonResponse(status, {}));
      await runAlertOutboxTick(ENV, h.deps);

      expect(h.event(evento)?.fields.status).toBe(status);
      // Lo importante: ni un segundo intento. La recuperación es el siguiente
      // Cron, dentro de un minuto, con el trabajo intacto en la base.
      expect(h.requests).toHaveLength(1);
    });
  }

  it('fallo de red: cron_fetch_error y ningún reintento', async () => {
    const h = harness(async () => {
      throw new Error('ECONNRESET');
    });
    await runAlertOutboxTick(ENV, h.deps);

    expect(h.event('cron_fetch_error')).toBeDefined();
    expect(h.requests).toHaveLength(1);
  });

  it('timeout: se distingue de un fallo de red y tampoco reintenta', async () => {
    // Se dispara el temporizador antes de que el fetch responda: es lo que hace
    // el AbortController real.
    const h = harness(
      async () => {
        throw new Error('abortado');
      },
      { setTimer: (cb) => { cb(); return 0; } },
    );
    await runAlertOutboxTick(ENV, h.deps);

    expect(h.event('cron_timeout')).toBeDefined();
    expect(h.event('cron_fetch_error')).toBeUndefined();
    expect(h.requests).toHaveLength(1);
  });

  it('nunca lanza hacia el caller: un Cron que revienta no vuelve solo', async () => {
    const h = harness(async () => {
      throw new Error('lo que sea');
    });
    await expect(runAlertOutboxTick(ENV, h.deps)).resolves.toBeUndefined();
  });
});

describe('cron — higiene de los logs', () => {
  it('ni el token, ni la URL, ni la cabecera salen en ningún log', async () => {
    const h = harness(async () => jsonResponse(200, TICK_OK));
    await runAlertOutboxTick(ENV, h.deps);

    const dump = JSON.stringify(h.logs);
    expect(dump).not.toContain('token-de-prueba');
    expect(dump).not.toContain('Bearer');
    expect(dump).not.toContain(ENV.WORKER_TICK_URL!);
  });

  it('el timeout está por debajo del maxDuration del endpoint', () => {
    // 55 s < 60 s del `maxDuration` de la ruta, y por encima del presupuesto
    // interno de reloj del endpoint (42 s) para que le dé tiempo a responder
    // recuentos en vez de que le cortemos.
    expect(TICK_TIMEOUT_MS).toBeLessThan(60_000);
    expect(TICK_TIMEOUT_MS).toBeGreaterThan(42_000);
  });
});
