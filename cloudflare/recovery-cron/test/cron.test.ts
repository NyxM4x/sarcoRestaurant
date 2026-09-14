import { describe, it, expect } from 'vitest';
import {
  MAX_CONEXIONES_SIMULTANEAS,
  RECOVERIES,
  resolveOrigin,
  runRecoveryTick,
  TICK_TIMEOUT_MS,
  type CronBindings,
  type CronDeps,
  type CronFetchInit,
  type CronResponse,
} from '../src/cron';

/**
 * Pruebas sin red real, sin secretos reales y sin relojes reales.
 *
 * Lo que se protege aquí no es "que llame": es que llame UNA vez a CADA
 * endpoint, que los cuatro salgan a la vez, que uno roto no tumbe a los otros,
 * y que nunca escriba en el log algo que no debería salir de este proceso.
 */

const ORIGIN = 'https://ejemplo.test';

const ENV: CronBindings = {
  APP_BASE_URL: ORIGIN,
  WORKER_INTERNAL_TOKEN: 'token-de-prueba',
};

/** Respuestas con el contrato REAL de cada endpoint. */
const BODIES: Record<string, unknown> = {
  webhook_events: { ok: true, claimed: 1, processed: 1, failed: 0, budget_exhausted: false },
  order_notifications: {
    ok: true,
    selected: 2,
    processed: 2,
    history_reads: 1,
    network_send_attempts: 2,
    budget_exhausted: false,
    results: [{ id: 'a' }, { id: 'b' }],
    alerts_selected: 0,
    alert_send_attempts: 0,
    alerts_sent: 0,
    alerts_rescheduled: 0,
  },
  telegram_alerts: { ok: true, claimed: 1, sent: 1, rescheduled: 0, failed: 0 },
  order_expiry: { cancelled: 3, cash_unconfirmed: 1, abandoned_carts: 1, unpaid_orders: 1 },
};

const nameOf = (url: string): string =>
  RECOVERIES.find((r) => url === `${ORIGIN}${r.path}`)?.name ?? 'desconocido';

interface Recorded {
  url: string;
  init: CronFetchInit;
}

type Responder = (name: string, init: CronFetchInit) => Promise<CronResponse>;

function jsonResponse(status: number, body: unknown): CronResponse {
  return { status, json: async () => body };
}

const okResponder: Responder = async (name) => jsonResponse(200, BODIES[name]);

function harness(responder: Responder = okResponder, overrides: Partial<CronDeps> = {}) {
  const requests: Recorded[] = [];
  const logs: { event: string; fields: Record<string, unknown> }[] = [];
  let clock = 1_000;

  const deps: CronDeps = {
    async fetch(url, init) {
      requests.push({ url, init });
      clock += 250;
      return responder(nameOf(url), init);
    },
    now: () => clock,
    log: (event, fields = {}) => logs.push({ event, fields }),
    timeoutMs: TICK_TIMEOUT_MS,
    setTimer: () => 0,
    clearTimer: () => {},
    ...overrides,
  };

  /** El log de UNA recuperación con ese evento. */
  const of = (recovery: string, event: string) =>
    logs.find((l) => l.event === event && l.fields.recovery === recovery);

  return { deps, requests, logs, of, event: (n: string) => logs.find((l) => l.event === n) };
}

describe('las cuatro recuperaciones', () => {
  it('son exactamente las cuatro conocidas, sin repetir nombre ni ruta', () => {
    expect(RECOVERIES.map((r) => r.name)).toEqual([
      'webhook_events',
      'order_notifications',
      'telegram_alerts',
      'order_expiry',
    ]);
    expect(new Set(RECOVERIES.map((r) => r.path)).size).toBe(RECOVERIES.length);
  });

  it('caben en las conexiones simultáneas de una invocación', () => {
    // Por encima de seis, Cloudflare hace esperar a la séptima a que termine
    // otra: volverían los tiempos compartidos que los cuatro Workers evitaban.
    expect(RECOVERIES.length).toBeLessThanOrEqual(MAX_CONEXIONES_SIMULTANEAS);
  });
});

describe('cron — las peticiones', () => {
  it('hace EXACTAMENTE un POST por endpoint, con Bearer y cuerpo {}', async () => {
    const h = harness();
    await runRecoveryTick(ENV, h.deps);

    expect(h.requests).toHaveLength(RECOVERIES.length);
    expect(h.requests.map((r) => r.url).sort()).toEqual(
      RECOVERIES.map((r) => `${ORIGIN}${r.path}`).sort(),
    );
    for (const { init } of h.requests) {
      expect(init.method).toBe('POST');
      expect(init.body).toBe('{}');
      expect(JSON.parse(init.body)).toEqual({});
      expect(init.headers.Authorization).toBe('Bearer token-de-prueba');
      expect(init.headers['Content-Type']).toBe('application/json');
    }
  });

  it('los cuatro salen A LA VEZ: ninguno espera la respuesta de otro', async () => {
    // Si se encadenaran, el inbox —que puede tardar un turno entero del agente—
    // le comería el tiempo al aviso de reparto. Aquí ninguna respuesta llega
    // hasta que las cuatro peticiones ya salieron.
    const pendientes: ((r: CronResponse) => void)[] = [];
    const h = harness(
      (name) =>
        new Promise<CronResponse>((resolve) => {
          pendientes.push(() => resolve(jsonResponse(200, BODIES[name])));
        }),
    );

    const tick = runRecoveryTick(ENV, h.deps);
    expect(h.requests).toHaveLength(RECOVERIES.length);

    for (const resolver of pendientes) resolver(jsonResponse(200, {}));
    await tick;
    expect(h.event('cron_finished')?.fields.all_completed).toBe(true);
  });

  it('cada endpoint tiene su PROPIO AbortController', async () => {
    const h = harness();
    await runRecoveryTick(ENV, h.deps);

    const signals = new Set(h.requests.map((r) => r.init.signal));
    expect(signals.size).toBe(RECOVERIES.length);
  });

  it('uno colgado no retiene los logs de los otros tres', async () => {
    let soltarExpiry: () => void = () => {};
    const h = harness((name) =>
      name === 'order_expiry'
        ? new Promise<CronResponse>((resolve) => {
            soltarExpiry = () => resolve(jsonResponse(200, BODIES.order_expiry));
          })
        : okResponder(name, {} as CronFetchInit),
    );

    const tick = runRecoveryTick(ENV, h.deps);
    await new Promise((r) => setTimeout(r, 0));

    // Los otros tres ya terminaron y lo dijeron, con expiry todavía en vuelo.
    expect(h.of('webhook_events', 'cron_completed')).toBeDefined();
    expect(h.of('order_notifications', 'cron_completed')).toBeDefined();
    expect(h.of('telegram_alerts', 'cron_completed')).toBeDefined();
    expect(h.of('order_expiry', 'cron_completed')).toBeUndefined();
    expect(h.event('cron_finished')).toBeUndefined();

    soltarExpiry();
    await tick;
    expect(h.of('order_expiry', 'cron_completed')).toBeDefined();
  });
});

describe('cron — configuración ausente o inválida: cero POST', () => {
  it('sin APP_BASE_URL no llama a nadie', async () => {
    const h = harness();
    await runRecoveryTick({ WORKER_INTERNAL_TOKEN: 'x' }, h.deps);

    expect(h.requests).toEqual([]);
    expect(h.event('cron_contract_error')?.fields.reason).toBe('missing_url');
  });

  it('sin token no llama a nadie: nunca se dispara sin autenticar', async () => {
    const h = harness();
    await runRecoveryTick({ APP_BASE_URL: ORIGIN }, h.deps);

    expect(h.requests).toEqual([]);
    expect(h.event('cron_contract_error')?.fields.reason).toBe('missing_token');
  });

  it('con la URL completa de un tick en vez del origen, no llama a nadie', async () => {
    // El error natural al migrar: los Workers viejos tenían `WORKER_TICK_URL`
    // con la ruta entera. Pegarla aquí duplicaría las rutas y daría cuatro 404.
    const h = harness();
    await runRecoveryTick(
      { ...ENV, APP_BASE_URL: `${ORIGIN}/api/internal/orders/expiry/worker/tick` },
      h.deps,
    );

    expect(h.requests).toEqual([]);
    expect(h.event('cron_contract_error')?.fields.reason).toBe('invalid_url');
  });

  it('sin `cron_finished`: un minuto que no llamó a nadie no se resume como si corriera', async () => {
    const h = harness();
    await runRecoveryTick({}, h.deps);
    expect(h.event('cron_finished')).toBeUndefined();
  });
});

describe('resolveOrigin', () => {
  it('acepta el origen, con o sin barra final', () => {
    expect(resolveOrigin('https://sarco.test')).toEqual({ origin: 'https://sarco.test' });
    expect(resolveOrigin('  https://sarco.test/  ')).toEqual({ origin: 'https://sarco.test' });
  });

  it('rechaza http fuera de local: el Bearer no viaja en claro', () => {
    expect(resolveOrigin('http://sarco.test')).toEqual({ reason: 'invalid_url' });
    expect(resolveOrigin('http://localhost:3000')).toEqual({ origin: 'http://localhost:3000' });
  });

  it('rechaza rutas, query, fragmentos, credenciales y basura', () => {
    for (const malo of [
      'https://sarco.test/api',
      'https://sarco.test/?x=1',
      'https://sarco.test/#x',
      'https://user:pass@sarco.test',
      'sarco.test',
      'ftp://sarco.test',
    ]) {
      expect(resolveOrigin(malo), malo).toEqual({ reason: 'invalid_url' });
    }
  });
});

describe('cron — traducción de cada respuesta', () => {
  it('200 con el contrato real: cada una registra SUS recuentos', async () => {
    const h = harness();
    await runRecoveryTick(ENV, h.deps);

    expect(h.event('cron_started')).toBeDefined();
    expect(h.of('webhook_events', 'cron_completed')?.fields).toMatchObject({
      status: 200,
      ok: true,
      claimed: 1,
      processed: 1,
      failed: 0,
      budget_exhausted: false,
    });
    expect(h.of('order_notifications', 'cron_completed')?.fields).toMatchObject({
      status: 200,
      selected: 2,
      results_count: 2,
      alerts_sent: 0,
    });
    expect(h.of('telegram_alerts', 'cron_completed')?.fields).toMatchObject({
      status: 200,
      claimed: 1,
      sent: 1,
      rescheduled: 0,
    });
    expect(h.of('order_expiry', 'cron_completed')?.fields).toMatchObject({
      status: 200,
      cancelled: 3,
      cash_unconfirmed: 1,
      abandoned_carts: 1,
      unpaid_orders: 1,
    });
    for (const r of RECOVERIES) {
      expect(h.of(r.name, 'cron_completed')?.fields.duration_ms).toBeGreaterThan(0);
    }
  });

  it('ninguna inventa campos de otra', async () => {
    // Un log que informa de algo que ESE endpoint no devuelve parece una
    // medición y no lo es.
    const h = harness();
    await runRecoveryTick(ENV, h.deps);

    expect(h.of('order_expiry', 'cron_completed')!.fields).not.toHaveProperty('claimed');
    expect(h.of('order_expiry', 'cron_completed')!.fields).not.toHaveProperty('ok');
    expect(h.of('telegram_alerts', 'cron_completed')!.fields).not.toHaveProperty('cancelled');
    expect(h.of('webhook_events', 'cron_completed')!.fields).not.toHaveProperty('sent');
    expect(h.of('order_notifications', 'cron_completed')!.fields).not.toHaveProperty('claimed');
  });

  it('el contenido de `results` NUNCA sale al log, solo cuántos son', async () => {
    const h = harness(async (name) =>
      jsonResponse(
        200,
        name === 'order_notifications'
          ? { ...(BODIES.order_notifications as object), results: [{ phone: '+59170000000' }] }
          : BODIES[name],
      ),
    );
    await runRecoveryTick(ENV, h.deps);

    expect(JSON.stringify(h.logs)).not.toContain('59170000000');
    expect(h.of('order_notifications', 'cron_completed')?.fields.results_count).toBe(1);
  });

  it('si falta un recuento, se registra null y no se inventa un cero', async () => {
    // Un cero dicho por nosotros y un cero medido son cosas distintas: el
    // primero haría pensar que la recuperación corrió y no encontró nada.
    const h = harness(async () => jsonResponse(200, {}));
    await runRecoveryTick(ENV, h.deps);

    expect(h.of('order_expiry', 'cron_completed')?.fields.cancelled).toBeNull();
    expect(h.of('webhook_events', 'cron_completed')?.fields.claimed).toBeNull();
  });

  it('200 ilegible o con forma rara: cron_invalid_response, sin reventar', async () => {
    const roto = harness(async () => ({
      status: 200,
      json: async () => {
        throw new Error('no es JSON');
      },
    }));
    await runRecoveryTick(ENV, roto.deps);
    expect(roto.of('telegram_alerts', 'cron_invalid_response')).toBeDefined();

    const array = harness(async () => jsonResponse(200, [1, 2, 3]));
    await runRecoveryTick(ENV, array.deps);
    expect(array.of('order_expiry', 'cron_invalid_response')).toBeDefined();
  });
});

describe('cron — errores: se registran por endpoint y NO se reintenta', () => {
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
    it(`${status} en el inbox → ${evento}; los otros tres completan, y nadie reintenta`, async () => {
      const h = harness(async (name) =>
        name === 'webhook_events' ? jsonResponse(status, {}) : jsonResponse(200, BODIES[name]),
      );
      await runRecoveryTick(ENV, h.deps);

      expect(h.of('webhook_events', evento)?.fields.status).toBe(status);
      expect(h.of('telegram_alerts', 'cron_completed')).toBeDefined();
      expect(h.of('order_expiry', 'cron_completed')).toBeDefined();
      // Ni un segundo intento: la recuperación es el siguiente Cron.
      expect(h.requests).toHaveLength(RECOVERIES.length);
    });
  }

  it('fallo de red en uno: cron_fetch_error solo para ese', async () => {
    const h = harness(async (name) => {
      if (name === 'order_notifications') throw new Error('ECONNRESET');
      return jsonResponse(200, BODIES[name]);
    });
    await runRecoveryTick(ENV, h.deps);

    expect(h.of('order_notifications', 'cron_fetch_error')).toBeDefined();
    expect(h.of('webhook_events', 'cron_completed')).toBeDefined();
    expect(h.requests).toHaveLength(RECOVERIES.length);
  });

  it('timeout en uno: se distingue de un fallo de red y no aborta a los demás', async () => {
    // Solo vence el primer temporizador armado (el del inbox). Los demás
    // controladores siguen intactos: por eso cada uno tiene el suyo.
    let armados = 0;
    const h = harness(
      async (name, init) => {
        if (init.signal.aborted) throw new Error('abortado');
        return jsonResponse(200, BODIES[name]);
      },
      {
        setTimer: (cb) => {
          armados += 1;
          if (armados === 1) cb();
          return 0;
        },
      },
    );
    await runRecoveryTick(ENV, h.deps);

    expect(h.of('webhook_events', 'cron_timeout')).toBeDefined();
    expect(h.of('webhook_events', 'cron_fetch_error')).toBeUndefined();
    expect(h.of('order_notifications', 'cron_completed')).toBeDefined();
    expect(h.of('telegram_alerts', 'cron_completed')).toBeDefined();
    expect(h.of('order_expiry', 'cron_completed')).toBeDefined();
  });

  it('una respuesta que manda cabeceras y se cuelga en el cuerpo también es timeout', async () => {
    // Los temporizadores se arman en el orden de RECOVERIES, antes de cada
    // fetch. El de expiry vence MIENTRAS se lee su cuerpo: si se limpiara al
    // llegar las cabeceras, ese cuelgue no tendría quien lo cortara.
    // Un temporizador limpiado ya no puede vencer, como uno real.
    const timers: { cb: () => void; armado: boolean }[] = [];
    const iExpiry = RECOVERIES.findIndex((r) => r.name === 'order_expiry');
    const h = harness(
      async (name) =>
        name === 'order_expiry'
          ? {
              status: 200,
              json: async () => {
                if (timers[iExpiry].armado) timers[iExpiry].cb();
                throw new Error('abortado a mitad del cuerpo');
              },
            }
          : jsonResponse(200, BODIES[name]),
      {
        setTimer: (cb) => timers.push({ cb, armado: true }) - 1,
        clearTimer: (handle) => {
          timers[handle as number].armado = false;
        },
      },
    );
    await runRecoveryTick(ENV, h.deps);

    expect(h.of('order_expiry', 'cron_timeout')?.fields.status).toBe(200);
    expect(h.of('order_expiry', 'cron_invalid_response')).toBeUndefined();
    expect(h.of('telegram_alerts', 'cron_completed')).toBeDefined();
  });

  it('cada temporizador se limpia, pase lo que pase', async () => {
    const limpiados: unknown[] = [];
    let n = 0;
    const h = harness(
      async (name) => {
        if (name === 'webhook_events') throw new Error('ECONNRESET');
        return jsonResponse(name === 'telegram_alerts' ? 503 : 200, BODIES[name]);
      },
      { setTimer: () => n++, clearTimer: (handle) => limpiados.push(handle) },
    );
    await runRecoveryTick(ENV, h.deps);

    expect([...limpiados].sort()).toEqual([0, 1, 2, 3]);
  });

  it('nunca lanza hacia el caller: un Cron que revienta no vuelve solo', async () => {
    const h = harness(async () => {
      throw new Error('lo que sea');
    });
    await expect(runRecoveryTick(ENV, h.deps)).resolves.toBeUndefined();
  });
});

describe('cron — el resumen del minuto', () => {
  it('cron_finished dice cómo le fue a CADA una, en una sola línea', async () => {
    const h = harness(async (name) =>
      name === 'telegram_alerts' ? jsonResponse(401, {}) : jsonResponse(200, BODIES[name]),
    );
    await runRecoveryTick(ENV, h.deps);

    const fin = h.event('cron_finished')!.fields;
    expect(fin).toMatchObject({
      all_completed: false,
      completed: 3,
      total: 4,
      outcomes: {
        webhook_events: 'completed',
        order_notifications: 'completed',
        telegram_alerts: 'unauthorized',
        order_expiry: 'completed',
      },
    });
    // Y es lo ÚLTIMO que se escribe en el minuto.
    expect(h.logs.at(-1)?.event).toBe('cron_finished');
  });

  it('con las cuatro sanas, all_completed es true', async () => {
    const h = harness();
    await runRecoveryTick(ENV, h.deps);
    expect(h.event('cron_finished')?.fields).toMatchObject({ all_completed: true, completed: 4 });
  });
});

describe('cron — higiene de los logs', () => {
  it('ni el token, ni las URLs, ni la cabecera salen en ningún log', async () => {
    const h = harness();
    await runRecoveryTick(ENV, h.deps);

    const dump = JSON.stringify(h.logs);
    expect(dump).not.toContain('token-de-prueba');
    expect(dump).not.toContain('Bearer');
    expect(dump).not.toContain(ORIGIN);
    for (const r of RECOVERIES) expect(dump).not.toContain(r.path);
  });

  it('el timeout está por debajo del maxDuration de los endpoints', () => {
    // 55 s < 60 s del `maxDuration` de las rutas, y por encima del presupuesto
    // interno de reloj del inbox (42 s) para que le dé tiempo a responder.
    expect(TICK_TIMEOUT_MS).toBeLessThan(60_000);
    expect(TICK_TIMEOUT_MS).toBeGreaterThan(42_000);
  });
});
