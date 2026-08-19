import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { handleNotificationRetry, type NotificationRetryDeps } from './retry-handler';
import type { NotificationStateRow, NotificationStatesResult } from './retry-plan';
import type { DispatchResult, NotificationType } from './web-notify';

const TOKEN = 'token-interno-de-prueba';
const ORDER_ID = '22222222-2222-4222-8222-222222222222';
const PHONE = '59170000000';

function result(overrides: Partial<DispatchResult> = {}): DispatchResult {
  return {
    ok: true,
    orderId: ORDER_ID,
    confirmation: 'sent',
    locationRequest: 'sent',
    ...overrides,
  };
}

const NOW = Date.parse('2026-07-22T18:00:00.000Z');
const PAST = '2026-07-22T17:59:00.000Z';

/** Fila de estado por defecto: confirmación `pending` (reintentable). */
function stateRow(overrides: Partial<NotificationStateRow> = {}): NotificationStateRow {
  return {
    notificationType: 'confirmation',
    status: 'pending',
    attemptCount: 0,
    maxAttempts: 5,
    nextAttemptAt: null,
    terminalAt: null,
    manualReviewRequired: false,
    lastErrorCode: null,
    lastHttpStatus: null,
    ...overrides,
  };
}

/** Doble de dependencias: registra las llamadas, sin tocar Supabase ni Kapso. */
class FakeDeps implements NotificationRetryDeps {
  internalToken: string | null = TOKEN;
  outcome: DispatchResult = result();
  throws: Error | null = null;
  states: NotificationStatesResult = { rows: [stateRow()], unknownStateCount: 0 };
  scheduleResult = true;

  calls: string[] = [];
  scheduleCalls: string[] = [];

  now = (): number => NOW;

  loadStates = async (): Promise<NotificationStatesResult> => this.states;

  scheduleSend = async (_orderId: string, type: NotificationType): Promise<boolean> => {
    this.scheduleCalls.push(type);
    return this.scheduleResult;
  };

  dispatch = async (orderId: string): Promise<DispatchResult> => {
    this.calls.push(orderId);
    if (this.throws) throw this.throws;
    return this.outcome;
  };
}

function request(
  body: unknown,
  opts: { token?: string | null; rawBody?: string } = {},
): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const token = opts.token === undefined ? TOKEN : opts.token;
  if (token !== null) headers.authorization = `Bearer ${token}`;

  return new Request('http://localhost/api/internal/order-notifications/retry', {
    method: 'POST',
    headers,
    body: opts.rawBody ?? JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('handleNotificationRetry — autenticación', () => {
  it('sin cabecera Authorization -> 401 y no ejecuta el dispatch', async () => {
    const deps = new FakeDeps();
    const res = await handleNotificationRetry(request({ order_id: ORDER_ID }, { token: null }), deps);

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: 'unauthorized' });
    expect(deps.calls).toEqual([]);
  });

  it('Bearer inválido -> 401 y no ejecuta el dispatch', async () => {
    const deps = new FakeDeps();
    const res = await handleNotificationRetry(
      request({ order_id: ORDER_ID }, { token: 'token-equivocado' }),
      deps,
    );

    expect(res.status).toBe(401);
    expect(deps.calls).toEqual([]);
  });

  it('esquema distinto de Bearer -> 401', async () => {
    const deps = new FakeDeps();
    const req = new Request('http://localhost/api/internal/order-notifications/retry', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Basic ${TOKEN}` },
      body: JSON.stringify({ order_id: ORDER_ID }),
    });

    expect((await handleNotificationRetry(req, deps)).status).toBe(401);
    expect(deps.calls).toEqual([]);
  });

  it('token interno no configurado -> 401 aunque el request traiga un Bearer', async () => {
    const deps = new FakeDeps();
    deps.internalToken = null;

    const res = await handleNotificationRetry(request({ order_id: ORDER_ID }), deps);

    expect(res.status).toBe(401);
    expect(deps.calls).toEqual([]);
    // No se revela el estado de configuración.
    await expect(res.json()).resolves.toEqual({ error: 'unauthorized' });
  });

  it('token vacío en el request no se acepta contra token vacío configurado', async () => {
    const deps = new FakeDeps();
    deps.internalToken = '';

    const res = await handleNotificationRetry(request({ order_id: ORDER_ID }, { token: '' }), deps);
    expect(res.status).toBe(401);
    expect(deps.calls).toEqual([]);
  });

  it('token válido -> ejecuta exactamente una vez', async () => {
    const deps = new FakeDeps();
    const res = await handleNotificationRetry(request({ order_id: ORDER_ID }), deps);

    expect(res.status).toBe(200);
    expect(deps.calls).toEqual([ORDER_ID]);
  });

  it('usa la utilidad timing-safe existente, no comparación directa', () => {
    const modulePath = fileURLToPath(new URL('./retry-handler.ts', import.meta.url));
    const source = readFileSync(modulePath, 'utf8');

    expect(source).toContain('safeCompare');
    expect(source).toContain('extractBearer');
    // Nunca se compara el secreto con === / !==.
    expect(source).not.toMatch(/internalToken\s*===/);
    expect(source).not.toMatch(/internalToken\s*!==/);
    expect(source).not.toMatch(/provided\s*===/);
  });
});

describe('handleNotificationRetry — contrato del cuerpo', () => {
  it('JSON malformado -> 400', async () => {
    const deps = new FakeDeps();
    const res = await handleNotificationRetry(
      request(null, { rawBody: 'no-es-json' }),
      deps,
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: 'invalid_json' });
    expect(deps.calls).toEqual([]);
  });

  it('order_id ausente -> 422', async () => {
    const deps = new FakeDeps();
    const res = await handleNotificationRetry(request({}), deps);

    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toEqual({ error: 'validation_error' });
    expect(deps.calls).toEqual([]);
  });

  it('UUID inválido -> 422', async () => {
    const deps = new FakeDeps();
    for (const value of ['no-es-uuid', 'ORD-000003', '', '1234', null, 42]) {
      const res = await handleNotificationRetry(request({ order_id: value }), deps);
      expect(res.status).toBe(422);
    }
    expect(deps.calls).toEqual([]);
  });

  it('campo extra -> 422', async () => {
    const deps = new FakeDeps();
    const res = await handleNotificationRetry(
      request({ order_id: ORDER_ID, extra: 'x' }),
      deps,
    );

    expect(res.status).toBe(422);
    expect(deps.calls).toEqual([]);
  });

  it('no acepta teléfono, phone_number_id, texto, modo ni session_token', async () => {
    const deps = new FakeDeps();
    const rejected = [
      { order_id: ORDER_ID, customer_phone: PHONE },
      { order_id: ORDER_ID, phone: PHONE },
      { order_id: ORDER_ID, phone_number_id: 'pnid-atacante' },
      { order_id: ORDER_ID, text: 'texto arbitrario' },
      { order_id: ORDER_ID, body_text: 'texto arbitrario' },
      { order_id: ORDER_ID, mode: 'dispatch_existing' },
      { order_id: ORDER_ID, session_token: 'token-robado' },
      { order_id: ORDER_ID, order_number: 'ORD-000003' },
    ];

    for (const body of rejected) {
      const res = await handleNotificationRetry(request(body), deps);
      expect(res.status).toBe(422);
    }
    expect(deps.calls).toEqual([]);
  });

  it('pasa únicamente el order_id al dispatch', async () => {
    const deps = new FakeDeps();
    await handleNotificationRetry(request({ order_id: ORDER_ID }), deps);

    expect(deps.calls).toEqual([ORDER_ID]);
    expect(deps.dispatch.length).toBe(1);
  });
});

describe('handleNotificationRetry — decisión por estado (5.2D.5B.2)', () => {
  /** Ejecuta el endpoint con un estado dado y devuelve el cuerpo + las deps. */
  async function run(rows: NotificationStateRow[], unknownStateCount = 0) {
    const deps = new FakeDeps();
    deps.states = { rows, unknownStateCount };
    const res = await handleNotificationRetry(request({ order_id: ORDER_ID }), deps);
    return { deps, status: res.status, body: await res.json() };
  }

  it('sent -> already_sent y NO despacha', async () => {
    const { deps, status, body } = await run([stateRow({ status: 'sent' })]);
    expect(status).toBe(200);
    expect(body.outcome).toBe('already_sent');
    expect(deps.calls).toEqual([]);
    expect(deps.scheduleCalls).toEqual([]);
  });

  it('pending -> despacha sin programar', async () => {
    const { deps, body } = await run([stateRow({ status: 'pending' })]);
    expect(body.outcome).toBe('dispatched');
    expect(deps.calls).toEqual([ORDER_ID]);
    expect(deps.scheduleCalls).toEqual([]);
  });

  it('failed PERMANENTE (invalid_phone/text/body_text) -> no programa ni envía', async () => {
    for (const code of ['invalid_phone', 'invalid_text', 'invalid_body_text']) {
      const { deps, body } = await run([
        stateRow({ status: 'failed', lastErrorCode: code, nextAttemptAt: PAST }),
      ]);
      expect(body.outcome).toBe('permanent_failure');
      expect(deps.scheduleCalls).toEqual([]);
      expect(deps.calls).toEqual([]);
    }
  });

  it('failed AMBIGUO -> requires_reconciliation y NO despacha', async () => {
    for (const code of ['timeout', 'network_error', 'invalid_response', 'persistence_error']) {
      const { deps, body } = await run([
        stateRow({ status: 'failed', lastErrorCode: code, nextAttemptAt: PAST }),
      ]);
      expect(body.outcome).toBe('requires_reconciliation');
      expect(deps.calls).toEqual([]);
      expect(deps.scheduleCalls).toEqual([]);
    }
  });

  it('failed + http_error SIN status -> ambiguo, no se adivina 4xx ni 5xx', async () => {
    const { deps, body } = await run([
      stateRow({ status: 'failed', lastErrorCode: 'http_error', lastHttpStatus: null }),
    ]);
    expect(body.outcome).toBe('requires_reconciliation');
    expect(deps.scheduleCalls).toEqual([]);
    expect(deps.calls).toEqual([]);
  });

  it('failed + HTTP 5xx/429 con certeza -> programa y despacha UNA vez', async () => {
    for (const status of [500, 503, 429]) {
      const { deps, body } = await run([
        stateRow({ status: 'failed', lastErrorCode: 'http_error', lastHttpStatus: status }),
      ]);
      expect(body.outcome).toBe('scheduled_and_dispatched');
      expect(deps.scheduleCalls).toEqual(['confirmation']);
      expect(deps.calls).toEqual([ORDER_ID]); // exactamente un dispatch
    }
  });

  it('failed + HTTP 4xx permanente -> no programa ni despacha', async () => {
    for (const status of [400, 403, 404]) {
      const { deps, body } = await run([
        stateRow({ status: 'failed', lastErrorCode: 'http_error', lastHttpStatus: status }),
      ]);
      expect(body.outcome).toBe('permanent_failure');
      expect(deps.scheduleCalls).toEqual([]);
      expect(deps.calls).toEqual([]);
    }
  });

  it('failed + HTTP 409 -> ambiguo pese a tener status', async () => {
    const { deps, body } = await run([
      stateRow({ status: 'failed', lastErrorCode: 'http_error', lastHttpStatus: 409 }),
    ]);
    expect(body.outcome).toBe('requires_reconciliation');
    expect(deps.scheduleCalls).toEqual([]);
  });

  it('failed con código DESCONOCIDO o vacío -> manual_review, nunca retryable', async () => {
    for (const code of ['codigo_que_no_conocemos', '', null]) {
      const { deps, body } = await run([
        stateRow({ status: 'failed', lastErrorCode: code, nextAttemptAt: PAST }),
      ]);
      expect(body.outcome).toBe('manual_review_required');
      expect(deps.scheduleCalls).toEqual([]);
      expect(deps.calls).toEqual([]);
    }
  });

  it('fila existente con status DESCONOCIDO -> unknown_state, nunca not_found', async () => {
    const { deps, body } = await run([], 1);
    expect(body.outcome).toBe('unknown_state');
    expect(body.outcome).not.toBe('not_found');
    expect(deps.scheduleCalls).toEqual([]);
    expect(deps.calls).toEqual([]);
  });

  it('un status desconocido junto a filas válidas tampoco autoriza envío', async () => {
    const { deps, body } = await run([stateRow({ status: 'pending' })], 1);
    expect(body.outcome).toBe('unknown_state');
    expect(deps.calls).toEqual([]);
  });

  it('pending_reconciliation -> NO despacha', async () => {
    const { deps, body } = await run([
      stateRow({ status: 'pending_reconciliation', lastErrorCode: 'timeout' }),
    ]);
    expect(body.outcome).toBe('requires_reconciliation');
    expect(deps.calls).toEqual([]);
  });

  it('reconciling -> NO despacha', async () => {
    const { deps, body } = await run([stateRow({ status: 'reconciling' })]);
    expect(body.outcome).toBe('reconciliation_in_progress');
    expect(deps.calls).toEqual([]);
  });

  it('sending -> NO despacha', async () => {
    const { deps, body } = await run([stateRow({ status: 'sending' })]);
    expect(body.outcome).toBe('in_flight');
    expect(deps.calls).toEqual([]);
  });

  it('terminal y manual_review_required -> NO despachan', async () => {
    const terminal = await run([
      stateRow({ status: 'failed', lastErrorCode: 'invalid_text', terminalAt: PAST }),
    ]);
    expect(terminal.body.outcome).toBe('terminal');
    expect(terminal.deps.calls).toEqual([]);

    const manual = await run([stateRow({ status: 'pending', manualReviewRequired: true })]);
    expect(manual.body.outcome).toBe('manual_review_required');
    expect(manual.deps.calls).toEqual([]);
  });

  it('pedido histórico SIN notificaciones -> not_found, nunca las inicializa', async () => {
    const { deps, body } = await run([]);
    expect(body.outcome).toBe('not_found');
    expect(deps.calls).toEqual([]);
    expect(deps.scheduleCalls).toEqual([]);
  });

  it('la respuesta nunca filtra datos sensibles', async () => {
    const { body } = await run([stateRow({ status: 'pending' })]);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(PHONE);
    expect(serialized).not.toContain('claim_token');
    expect(serialized).not.toContain('wamid');
    expect(serialized).not.toContain(TOKEN);
  });
});

describe('handleNotificationRetry — resultado', () => {
  it('respuesta exitosa sanitizada con los campos exactos', async () => {
    const deps = new FakeDeps();
    const res = await handleNotificationRetry(request({ order_id: ORDER_ID }), deps);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      ok: true,
      order_id: ORDER_ID,
      outcome: 'dispatched',
      confirmation: 'sent',
      location_request: 'sent',
      reason: null,
    });
    expect(Object.keys(body).sort()).toEqual([
      'confirmation',
      'location_request',
      'ok',
      'order_id',
      'outcome',
      'reason',
    ]);
  });

  it('resultado failed sigue devolviendo 200 con estados seguros', async () => {
    const deps = new FakeDeps();
    deps.outcome = result({
      ok: false,
      confirmation: 'failed',
      locationRequest: 'blocked_by_confirmation',
    });

    const res = await handleNotificationRetry(request({ order_id: ORDER_ID }), deps);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: false,
      order_id: ORDER_ID,
      outcome: 'dispatched',
      confirmation: 'failed',
      location_request: 'blocked_by_confirmation',
      reason: null,
    });
  });

  it('propaga el reason seguro del orquestador', async () => {
    const deps = new FakeDeps();
    deps.outcome = result({
      ok: false,
      confirmation: 'not_initialized',
      locationRequest: 'not_applicable',
      reason: 'invalid_order',
    });

    const res = await handleNotificationRetry(request({ order_id: ORDER_ID }), deps);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ reason: 'invalid_order' });
  });

  it('excepción inesperada -> 500 genérico sin filtrar el mensaje', async () => {
    const deps = new FakeDeps();
    deps.throws = new Error('supabase down: postgres://user:PASS@host x-api-key=SECRETO');

    const res = await handleNotificationRetry(request({ order_id: ORDER_ID }), deps);
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).toEqual({ error: 'internal_error' });
    const serialized = JSON.stringify(body);
    for (const secret of ['supabase down', 'postgres://', 'PASS', 'SECRETO', 'x-api-key']) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('la respuesta nunca contiene datos sensibles', async () => {
    const deps = new FakeDeps();
    const res = await handleNotificationRetry(request({ order_id: ORDER_ID }), deps);
    const serialized = JSON.stringify(await res.json());

    for (const secret of [
      PHONE,
      TOKEN,
      'pnid',
      'claim_token',
      'wamid',
      'external_message_id',
      'La Fija',
      'Recibí',
      'Bs.',
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });
});

describe('ruta /api/internal/order-notifications/retry', () => {
  const routePath = fileURLToPath(
    new URL('../../../app/api/internal/order-notifications/retry/route.ts', import.meta.url),
  );
  const source = readFileSync(routePath, 'utf8');
  /** Código sin comentarios: los guards deben mirar lo que se ejecuta. */
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  it('declara runtime, dynamic y maxDuration', async () => {
    const route = await import('@/app/api/internal/order-notifications/retry/route');

    expect(route.runtime).toBe('nodejs');
    expect(route.dynamic).toBe('force-dynamic');
    expect(route.maxDuration).toBe(60);
  });

  it('expone POST cableado al handler', async () => {
    const route = await import('@/app/api/internal/order-notifications/retry/route');

    expect(typeof route.POST).toBe('function');
    expect(source).toContain('handleNotificationRetry');
  });

  it('usa dispatchExisting y NUNCA initializeAndDispatch', () => {
    // 5.2D.5B.2: inicializar aqui podria CREAR filas nuevas para un pedido
    // historico y convertirlo en trabajo pendiente del futuro worker.
    expect(code).toContain('dispatchExistingWebOrderWhatsApp');
    expect(code).not.toContain('initializeAndDispatchWebOrderWhatsApp');
  });

  it('no usa after(): el dispatch se espera antes de responder', () => {
    expect(code).not.toMatch(/from\s+['"]next\/server['"]/);
    expect(code).not.toMatch(/\bafter\s*\(/);
  });

  it('no acepta destino ni escanea pedidos', () => {
    expect(code).not.toMatch(/customer_phone/);
    expect(code).not.toMatch(/phone_number_id/);
    expect(code).not.toMatch(/order_number/);
    expect(code).not.toMatch(/\.select\(/);
  });
});
