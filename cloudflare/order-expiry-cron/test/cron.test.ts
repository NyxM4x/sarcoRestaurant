import { describe, it, expect } from 'vitest';
import {
  runOrderExpiryTick,
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
const TICK_OK = { cancelled: 2 };

describe('cron — la petición', () => {
  it('hace EXACTAMENTE un POST, con Bearer y cuerpo {}', async () => {
    const h = harness(async () => jsonResponse(200, TICK_OK));
    await runOrderExpiryTick(ENV, h.deps);

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
    await runOrderExpiryTick(ENV, h.deps);

    // Ni id, ni evento, ni teléfono, ni límites, ni timestamps. Si el caller
    // pudiera elegir, este Worker dejaría de ser un despertador.
    expect(JSON.parse(h.requests[0].init.body)).toEqual({});
  });

  it('apunta al endpoint de webhook-events, no al de notificaciones', async () => {
    const h = harness(async () => jsonResponse(200, TICK_OK));
    await runOrderExpiryTick(ENV, h.deps);

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
    await runOrderExpiryTick({ WORKER_INTERNAL_TOKEN: 'x' }, h.deps);

    expect(h.requests).toEqual([]);
    expect(h.event('cron_contract_error')?.fields.reason).toBe('missing_url');
  });

  it('sin token no llama a nadie: nunca se dispara sin autenticar', async () => {
    const h = harness(async () => jsonResponse(200, TICK_OK));
    await runOrderExpiryTick({ WORKER_TICK_URL: ENV.WORKER_TICK_URL }, h.deps);

    expect(h.requests).toEqual([]);
    expect(h.event('cron_contract_error')?.fields.reason).toBe('missing_token');
  });
});

describe('cron — traducción de la respuesta', () => {
  it('200 con el contrato real: registra `cancelled` y nada mas', async () => {
    const h = harness(async () => jsonResponse(200, TICK_OK));
    await runOrderExpiryTick(ENV, h.deps);

    expect(h.event('cron_started')).toBeDefined();
    expect(h.event('cron_completed')?.fields).toMatchObject({
      status: 200,
      cancelled: 2,
    });
    expect(h.event('cron_completed')?.fields.duration_ms).toBeGreaterThan(0);
  });

  it('no inventa campos de los otros TRES workers', async () => {
    const h = harness(async () => jsonResponse(200, TICK_OK));
    await runOrderExpiryTick(ENV, h.deps);

    const fields = h.event('cron_completed')!.fields;
    // Un log que informa de algo que este endpoint no devuelve parece una
    // medicion y no lo es. Estos campos son de sus hermanos: `processed` y
    // `budget_exhausted` del inbox de webhooks; `claimed`, `sent`,
    // `rescheduled` y `failed` del outbox de alertas.
    const ajenos = [
      'processed',
      'budget_exhausted',
      'selected',
      'history_reads',
      'claimed',
      'sent',
      'rescheduled',
      'failed',
    ];
    for (const ajeno of ajenos) {
      expect(fields, ajeno).not.toHaveProperty(ajeno);
    }
  });

  it('un tick sin nada que cancelar es el caso NORMAL, no un error', async () => {
    // La mayoria de los minutos no hay ningun pedido caducado: la consulta va
    // por un indice parcial y no encuentra filas. Que esto se tinera de rojo
    // haria que el log util —"este barrido dejo de correr"— se perdiera entre
    // avisos que no significan nada.
    const h = harness(async () => jsonResponse(200, { cancelled: 0 }));
    await runOrderExpiryTick(ENV, h.deps);

    expect(h.event('cron_completed')?.fields).toMatchObject({ cancelled: 0 });
    expect(h.event('cron_upstream_error')).toBeUndefined();
  });

  it('una tanda entera de caducados se registra igual de tranquila', async () => {
    // El tope del barrido son 25 por pasada. Veinticinco cancelaciones seguidas
    // no son una averia: es la primera noche despues de que este Worker exista,
    // con la cola de pedidos que llevaban dias sin barrer.
    const h = harness(async () => jsonResponse(200, { cancelled: 25 }));
    await runOrderExpiryTick(ENV, h.deps);

    expect(h.event('cron_completed')?.fields).toMatchObject({ cancelled: 25 });
    expect(h.event('cron_upstream_error')).toBeUndefined();
  });

  it('si falta `cancelled` en la respuesta, se registra null y no se inventa un cero', async () => {
    // Un cero dicho por nosotros y un cero medido son cosas distintas: el
    // primero haria pensar que el barrido corrio y no encontro nada.
    const h = harness(async () => jsonResponse(200, {}));
    await runOrderExpiryTick(ENV, h.deps);

    expect(h.event('cron_completed')?.fields.cancelled).toBeNull();
  });

  it('200 ilegible o con forma rara: cron_invalid_response, sin reventar', async () => {
    const roto = harness(async () => ({
      status: 200,
      json: async () => {
        throw new Error('no es JSON');
      },
    }));
    await runOrderExpiryTick(ENV, roto.deps);
    expect(roto.event('cron_invalid_response')).toBeDefined();

    const array = harness(async () => jsonResponse(200, [1, 2, 3]));
    await runOrderExpiryTick(ENV, array.deps);
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
      await runOrderExpiryTick(ENV, h.deps);

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
    await runOrderExpiryTick(ENV, h.deps);

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
    await runOrderExpiryTick(ENV, h.deps);

    expect(h.event('cron_timeout')).toBeDefined();
    expect(h.event('cron_fetch_error')).toBeUndefined();
    expect(h.requests).toHaveLength(1);
  });

  it('nunca lanza hacia el caller: un Cron que revienta no vuelve solo', async () => {
    const h = harness(async () => {
      throw new Error('lo que sea');
    });
    await expect(runOrderExpiryTick(ENV, h.deps)).resolves.toBeUndefined();
  });
});

describe('cron — higiene de los logs', () => {
  it('ni el token, ni la URL, ni la cabecera salen en ningún log', async () => {
    const h = harness(async () => jsonResponse(200, TICK_OK));
    await runOrderExpiryTick(ENV, h.deps);

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
