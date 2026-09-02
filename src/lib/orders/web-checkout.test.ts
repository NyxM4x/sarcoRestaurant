import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  createNotificationScheduler,
  handleCreateWebOrder,
  type CreateOrderWebOutcome,
  type CreateOrderWebParams,
  type CreateOrderWebRow,
  type ScheduleNotificationDispatchInput,
  type WebCheckoutDeps,
} from './web-checkout';
import type { DispatchResult } from '@/lib/orders/notifications/web-notify';
import { calculateCheckoutFingerprint } from './fingerprint';
import { hashMenuSessionToken } from '@/lib/menu/session-token';

const SESSION_TOKEN = 'token-opaco-de-prueba';
const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const ORDER_ID = '22222222-2222-4222-8222-222222222222';
const PHONE = '59170000000';

function row(overrides: Partial<CreateOrderWebRow> = {}): CreateOrderWebRow {
  return {
    order_id: ORDER_ID,
    order_number: 'ORD-000123',
    customer_name: 'Juan García',
    delivery_type: 'delivery',
    status: 'awaiting_location',
    subtotal_amount: 40,
    delivery_amount: 0,
    total_amount: 40,
    payment_method: 'cash',
    created_at: '2026-07-20T14:30:00.000Z',
    created: true,
    ...overrides,
  };
}

/** Doble de las dependencias: registra lo que recibiría la RPC, sin tocar Supabase. */
class FakeDeps implements WebCheckoutDeps {
  sessionId: string | null = SESSION_ID;
  sessionLookupError: Error | null = null;
  outcome: CreateOrderWebOutcome = { data: row(), errorCode: null };
  rpcThrows: Error | null = null;

  lookupCalls: string[] = [];
  rpcCalls: CreateOrderWebParams[] = [];

  /** Programaciones recibidas; debe haber exactamente una por respuesta exitosa. */
  scheduleCalls: ScheduleNotificationDispatchInput[] = [];
  scheduleThrows: Error | null = null;

  async findSessionIdByTokenHash(tokenHash: string): Promise<string | null> {
    this.lookupCalls.push(tokenHash);
    if (this.sessionLookupError) throw this.sessionLookupError;
    return this.sessionId;
  }

  async callCreateOrderWeb(params: CreateOrderWebParams): Promise<CreateOrderWebOutcome> {
    this.rpcCalls.push(params);
    if (this.rpcThrows) throw this.rpcThrows;
    return this.outcome;
  }

  scheduleNotificationDispatch = (input: ScheduleNotificationDispatchInput): void => {
    this.scheduleCalls.push(input);
    if (this.scheduleThrows) throw this.scheduleThrows;
  };
}

function request(body: unknown, opts: { rawBody?: string } = {}): Request {
  return new Request('http://localhost/api/store/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: opts.rawBody ?? JSON.stringify(body),
  });
}

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_token: SESSION_TOKEN,
    customer_name: 'Juan García',
    delivery_type: 'delivery',
    payment_method: 'cash',
    notes: 'Sin cebolla',
    items: [
      { code: 'la_fija', quantity: 1 },
      { code: 'gaseosa_2l', quantity: 1 },
    ],
    ...overrides,
  };
}

// Los logs estructurales no se verifican aquí; se silencian para no ensuciar la salida.
beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('handleCreateWebOrder', () => {
  describe('body', () => {
    it('JSON inválido -> 400', async () => {
      const deps = new FakeDeps();
      const res = await handleCreateWebOrder(request(null, { rawBody: 'no-es-json' }), deps);
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({ error: 'invalid_json' });
      expect(deps.rpcCalls).toHaveLength(0);
    });

    it('body inválido -> 422 sin llamar a la RPC', async () => {
      const deps = new FakeDeps();
      const res = await handleCreateWebOrder(request(validBody({ customer_name: '' })), deps);
      expect(res.status).toBe(422);
      await expect(res.json()).resolves.toMatchObject({ error: 'validation_error' });
      expect(deps.rpcCalls).toHaveLength(0);
    });

    it('campo desconocido (customer_phone) -> 422 sin llamar a la RPC', async () => {
      const deps = new FakeDeps();
      const res = await handleCreateWebOrder(
        request(validBody({ customer_phone: PHONE })),
        deps,
      );
      expect(res.status).toBe(422);
      expect(deps.rpcCalls).toHaveLength(0);
    });

    it('no consulta la sesión si el body es inválido', async () => {
      const deps = new FakeDeps();
      await handleCreateWebOrder(request(validBody({ items: [] })), deps);
      expect(deps.lookupCalls).toHaveLength(0);
    });
  });

  describe('sesión', () => {
    it('sesión inexistente -> 401', async () => {
      const deps = new FakeDeps();
      deps.sessionId = null;
      const res = await handleCreateWebOrder(request(validBody()), deps);
      expect(res.status).toBe(401);
      await expect(res.json()).resolves.toMatchObject({ error: 'invalid_session' });
      expect(deps.rpcCalls).toHaveLength(0);
    });

    it('sesión vencida -> 401 (findByHash filtra por expires_at y devuelve null)', async () => {
      const deps = new FakeDeps();
      deps.sessionId = null;
      const res = await handleCreateWebOrder(request(validBody()), deps);
      expect(res.status).toBe(401);
      expect(deps.rpcCalls).toHaveLength(0);
    });

    it('busca la sesión por el hash del token, nunca por el token en claro', async () => {
      const deps = new FakeDeps();
      await handleCreateWebOrder(request(validBody()), deps);
      expect(deps.lookupCalls).toEqual([hashMenuSessionToken(SESSION_TOKEN)]);
      expect(deps.lookupCalls[0]).not.toContain(SESSION_TOKEN);
      expect(deps.lookupCalls[0]).toMatch(/^[0-9a-f]{64}$/);
    });

    it('fallo al consultar la sesión -> 500 genérico', async () => {
      const deps = new FakeDeps();
      deps.sessionLookupError = new Error('connection refused to db.internal:5432');
      const res = await handleCreateWebOrder(request(validBody()), deps);
      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json).toMatchObject({ error: 'internal_error' });
      expect(JSON.stringify(json)).not.toContain('db.internal');
    });
  });

  describe('pedidos nuevos', () => {
    it('delivery nuevo -> 201 con next_action de ubicación', async () => {
      const deps = new FakeDeps();
      deps.outcome = {
        data: row({ delivery_type: 'delivery', status: 'awaiting_location', created: true }),
        errorCode: null,
      };
      const res = await handleCreateWebOrder(request(validBody()), deps);
      expect(res.status).toBe(201);
      await expect(res.json()).resolves.toEqual({
        order: {
          id: ORDER_ID,
          order_number: 'ORD-000123',
          customer_name: 'Juan García',
          delivery_type: 'delivery',
          status: 'awaiting_location',
          subtotal_amount: 40,
          delivery_amount: 0,
          total_amount: 40,
          created_at: '2026-07-20T14:30:00.000Z',
        },
        created: true,
        next_action: 'return_to_whatsapp_for_location',
      });
    });

    it('pickup nuevo -> 201 con next_action order_confirmed', async () => {
      const deps = new FakeDeps();
      deps.outcome = {
        data: row({ delivery_type: 'pickup', status: 'confirmed', created: true }),
        errorCode: null,
      };
      const res = await handleCreateWebOrder(request(validBody({ delivery_type: 'pickup' })), deps);
      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.created).toBe(true);
      expect(json.next_action).toBe('order_confirmed');
      expect(json.order.status).toBe('confirmed');
    });
  });

  describe('reintento legítimo', () => {
    it('created=false -> 200 con el mismo pedido', async () => {
      const deps = new FakeDeps();
      deps.outcome = { data: row({ created: false }), errorCode: null };
      const res = await handleCreateWebOrder(request(validBody()), deps);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.created).toBe(false);
      expect(json.order.order_number).toBe('ORD-000123');
    });

    it('pickup reintentado -> 200 con order_confirmed', async () => {
      const deps = new FakeDeps();
      deps.outcome = {
        data: row({ delivery_type: 'pickup', status: 'confirmed', created: false }),
        errorCode: null,
      };
      const res = await handleCreateWebOrder(request(validBody({ delivery_type: 'pickup' })), deps);
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({
        created: false,
        next_action: 'order_confirmed',
      });
    });
  });

  describe('mapeo de SQLSTATE', () => {
    const casos: Array<[string, number, string]> = [
      ['P1001', 401, 'invalid_session'],
      ['P1002', 422, 'product_unavailable'],
      ['P1003', 409, 'session_already_used'],
      ['22023', 422, 'validation_error'],
    ];

    for (const [sqlstate, status, error] of casos) {
      it(`${sqlstate} -> ${status} ${error}`, async () => {
        const deps = new FakeDeps();
        deps.outcome = { data: null, errorCode: sqlstate };
        const res = await handleCreateWebOrder(request(validBody()), deps);
        expect(res.status).toBe(status);
        await expect(res.json()).resolves.toMatchObject({ error });
      });
    }

    it('P1003 devuelve el mensaje de enlace ya utilizado', async () => {
      const deps = new FakeDeps();
      deps.outcome = { data: null, errorCode: 'P1003' };
      const res = await handleCreateWebOrder(request(validBody()), deps);
      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toEqual({
        error: 'session_already_used',
        message: 'Este enlace ya fue utilizado. Vuelve a WhatsApp para solicitar un nuevo enlace.',
      });
    });

    it('SQLSTATE desconocido -> 500 genérico', async () => {
      const deps = new FakeDeps();
      deps.outcome = { data: null, errorCode: '42P01' };
      const res = await handleCreateWebOrder(request(validBody()), deps);
      expect(res.status).toBe(500);
      await expect(res.json()).resolves.toMatchObject({ error: 'internal_error' });
    });

    it('errorCode null sin datos -> 500 genérico', async () => {
      const deps = new FakeDeps();
      deps.outcome = { data: null, errorCode: null };
      const res = await handleCreateWebOrder(request(validBody()), deps);
      expect(res.status).toBe(500);
    });

    it('excepción de la RPC -> 500 sin filtrar el detalle', async () => {
      const deps = new FakeDeps();
      deps.rpcThrows = new Error('relation "public.secret_table" does not exist');
      const res = await handleCreateWebOrder(request(validBody()), deps);
      expect(res.status).toBe(500);
      const texto = JSON.stringify(await res.json());
      expect(texto).not.toContain('secret_table');
      expect(texto).not.toContain('relation');
    });
  });

  describe('valores que recibe la RPC', () => {
    it('recibe el menu_session_id resuelto por el servidor', async () => {
      const deps = new FakeDeps();
      await handleCreateWebOrder(request(validBody()), deps);
      expect(deps.rpcCalls[0].p_menu_session_id).toBe(SESSION_ID);
    });

    it('recibe valores normalizados (nombre, códigos, notas)', async () => {
      const deps = new FakeDeps();
      await handleCreateWebOrder(
        request(
          validBody({
            customer_name: '   Juan García   ',
            notes: '   ',
            items: [{ code: '  la_fija  ', quantity: 2 }],
          }),
        ),
        deps,
      );
      const params = deps.rpcCalls[0];
      expect(params.p_customer_name).toBe('Juan García');
      expect(params.p_notes).toBeNull();
      expect(params.p_items_json).toEqual([{ code: 'la_fija', quantity: 2 }]);
    });

    it('recibe el fingerprint calculado por el servidor', async () => {
      const deps = new FakeDeps();
      const body = validBody();
      await handleCreateWebOrder(request(body), deps);
      const esperado = calculateCheckoutFingerprint({
        customer_name: 'Juan García',
        delivery_type: 'delivery',
        payment_method: 'cash',
        notes: 'Sin cebolla',
        items: [
          { code: 'la_fija', quantity: 1 },
          { code: 'gaseosa_2l', quantity: 1 },
        ],
      });
      expect(deps.rpcCalls[0].p_checkout_fingerprint).toBe(esperado);
      expect(deps.rpcCalls[0].p_checkout_fingerprint).toMatch(/^[0-9a-f]{64}$/);
    });

    it('ignora un fingerprint enviado por el cliente (el body lo rechaza)', async () => {
      const deps = new FakeDeps();
      const res = await handleCreateWebOrder(
        request(validBody({ checkout_fingerprint: 'f'.repeat(64) })),
        deps,
      );
      expect(res.status).toBe(422);
      expect(deps.rpcCalls).toHaveLength(0);
    });

    it('el mismo carrito en otro orden produce el mismo fingerprint', async () => {
      const depsA = new FakeDeps();
      const depsB = new FakeDeps();
      await handleCreateWebOrder(request(validBody()), depsA);
      await handleCreateWebOrder(
        request(
          validBody({
            items: [
              { code: 'gaseosa_2l', quantity: 1 },
              { code: 'la_fija', quantity: 1 },
            ],
          }),
        ),
        depsB,
      );
      expect(depsA.rpcCalls[0].p_checkout_fingerprint).toBe(
        depsB.rpcCalls[0].p_checkout_fingerprint,
      );
    });

    it('un carrito distinto produce un fingerprint distinto', async () => {
      const depsA = new FakeDeps();
      const depsB = new FakeDeps();
      await handleCreateWebOrder(request(validBody()), depsA);
      await handleCreateWebOrder(
        request(validBody({ items: [{ code: 'la_fija', quantity: 5 }] })),
        depsB,
      );
      expect(depsA.rpcCalls[0].p_checkout_fingerprint).not.toBe(
        depsB.rpcCalls[0].p_checkout_fingerprint,
      );
    });

    it('no envía el teléfono ni el token a la RPC', async () => {
      const deps = new FakeDeps();
      await handleCreateWebOrder(request(validBody()), deps);
      const enviado = JSON.stringify(deps.rpcCalls[0]);
      expect(enviado).not.toContain(SESSION_TOKEN);
      expect(enviado).not.toContain(PHONE);
      expect(Object.keys(deps.rpcCalls[0]).sort()).toEqual([
        'p_checkout_fingerprint',
        'p_customer_name',
        'p_delivery_type',
        'p_items_json',
        'p_menu_session_id',
        'p_notes',
        'p_payment_method',
        'p_promotions_json',
      ]);
      expect(deps.rpcCalls[0].p_payment_method).toBe('cash');
    });
  });

  describe('la respuesta no filtra datos sensibles', () => {
    it('no incluye teléfono, token, hash ni fingerprint', async () => {
      const deps = new FakeDeps();
      const res = await handleCreateWebOrder(request(validBody()), deps);
      const texto = JSON.stringify(await res.json());
      expect(texto).not.toContain(PHONE);
      expect(texto).not.toContain(SESSION_TOKEN);
      expect(texto).not.toContain(hashMenuSessionToken(SESSION_TOKEN));
      expect(texto).not.toContain('customer_phone');
      expect(texto).not.toContain('phone_number_id');
      expect(texto).not.toContain('token_hash');
      expect(texto).not.toContain('checkout_fingerprint');
      expect(texto).not.toContain('menu_session_id');
    });

    it('devuelve solo los campos de la lista blanca aunque la RPC añada extras', async () => {
      const deps = new FakeDeps();
      deps.outcome = {
        data: {
          ...row(),
          // Campos que la RPC no devuelve hoy, pero que no deben propagarse.
          customer_phone: PHONE,
          checkout_fingerprint: 'a'.repeat(64),
        } as CreateOrderWebRow,
        errorCode: null,
      };
      const res = await handleCreateWebOrder(request(validBody()), deps);
      const json = await res.json();
      expect(Object.keys(json).sort()).toEqual(['created', 'next_action', 'order']);
      expect(Object.keys(json.order).sort()).toEqual([
        'created_at',
        'customer_name',
        'delivery_amount',
        'delivery_type',
        'id',
        'order_number',
        'status',
        'subtotal_amount',
        'total_amount',
      ]);
    });
  });

  describe('sin escrituras directas', () => {
    it('la ruta no hace inserts ni updates sobre orders/order_items', () => {
      const routePath = fileURLToPath(
        new URL('../../app/api/store/orders/route.ts', import.meta.url),
      );
      const source = readFileSync(routePath, 'utf8');

      expect(source).not.toMatch(/\.insert\s*\(/);
      expect(source).not.toMatch(/\.update\s*\(/);
      expect(source).not.toMatch(/\.upsert\s*\(/);
      expect(source).not.toMatch(/\.delete\s*\(/);
      expect(source).not.toMatch(/from\(['"]orders['"]\)/);
      expect(source).not.toMatch(/from\(['"]order_items['"]\)/);
      // La única vía de escritura es la RPC transaccional. 0032: el código nuevo
      // llama create_order_web_v4 (8 args); NUNCA v3, v2 ni la legacy.
      expect(source).toMatch(/rpc\(['"]create_order_web_v4['"]/);
      expect(source).not.toMatch(/rpc\(['"]create_order_web_v2['"]/);
      expect(source).not.toMatch(/rpc\(['"]create_order_web_v3['"]/);
      expect(source).not.toMatch(/rpc\(['"]create_order_web['"]/);
    });

    it('la ruta resuelve la sesión con findValidIdByHash, no con findByHash', () => {
      const routePath = fileURLToPath(
        new URL('../../app/api/store/orders/route.ts', import.meta.url),
      );
      const source = readFileSync(routePath, 'utf8');

      expect(source).toMatch(/findValidIdByHash\(/);
      // findByHash traería la sesión completa (teléfono, phone_number_id, hash).
      expect(source).not.toMatch(/\.findByHash\(/);
      // La ruta no declara ni tipa ningún objeto MenuSession completo.
      // `\b` evita colisionar con `createMenuSessionRepository`.
      expect(source).not.toMatch(/\bMenuSession\b/);
    });

    it('el orquestador no conoce las tablas de pedidos', () => {
      const modulePath = fileURLToPath(new URL('./web-checkout.ts', import.meta.url));
      const source = readFileSync(modulePath, 'utf8');

      expect(source).not.toMatch(/from\(['"]orders['"]\)/);
      expect(source).not.toMatch(/from\(['"]order_items['"]\)/);
      expect(source).not.toMatch(/\.insert\s*\(/);
    });

    it('no importa next/server ni after directamente', () => {
      const modulePath = fileURLToPath(new URL('./web-checkout.ts', import.meta.url));
      const source = readFileSync(modulePath, 'utf8');

      expect(source).not.toMatch(/from\s+['"]next\/server['"]/);
      expect(source).not.toMatch(/\bimport\s*\{[^}]*\bafter\b[^}]*\}/);
    });
  });

  describe('programación de la notificación (Fase 5.2D.3)', () => {
    it('created:true programa exactamente una vez en modo initialize_and_dispatch', async () => {
      const deps = new FakeDeps();
      deps.outcome = { data: row({ created: true }), errorCode: null };

      const res = await handleCreateWebOrder(request(validBody()), deps);

      expect(res.status).toBe(201);
      expect(deps.scheduleCalls).toEqual([
        { orderId: ORDER_ID, mode: 'initialize_and_dispatch' },
      ]);
    });

    it('created:false programa exactamente una vez en modo dispatch_existing', async () => {
      const deps = new FakeDeps();
      deps.outcome = { data: row({ created: false }), errorCode: null };

      const res = await handleCreateWebOrder(request(validBody()), deps);

      expect(res.status).toBe(200);
      expect(deps.scheduleCalls).toEqual([{ orderId: ORDER_ID, mode: 'dispatch_existing' }]);
    });

    it('PROTECCIÓN de pedidos antiguos: created:false nunca inicializa', async () => {
      const deps = new FakeDeps();
      deps.outcome = { data: row({ created: false }), errorCode: null };

      await handleCreateWebOrder(request(validBody()), deps);

      expect(deps.scheduleCalls).toHaveLength(1);
      expect(deps.scheduleCalls[0].mode).toBe('dispatch_existing');
      expect(deps.scheduleCalls.some((c) => c.mode === 'initialize_and_dispatch')).toBe(false);
    });

    it('la respuesta 201 no cambia por programar', async () => {
      const withScheduler = new FakeDeps();
      withScheduler.outcome = { data: row({ created: true }), errorCode: null };
      const scheduled = await handleCreateWebOrder(request(validBody()), withScheduler);

      const plain = new FakeDeps();
      plain.outcome = { data: row({ created: true }), errorCode: null };
      plain.scheduleNotificationDispatch = undefined as never;
      const unscheduled = await handleCreateWebOrder(request(validBody()), plain);

      expect(scheduled.status).toBe(201);
      expect(unscheduled.status).toBe(201);
      await expect(scheduled.json()).resolves.toEqual(await unscheduled.json());
    });

    it('la respuesta 200 no cambia por programar', async () => {
      const deps = new FakeDeps();
      deps.outcome = { data: row({ created: false }), errorCode: null };

      const res = await handleCreateWebOrder(request(validBody()), deps);

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({
        created: false,
        order: { id: ORDER_ID, order_number: 'ORD-000123' },
      });
    });

    it('un scheduler que lanza no altera la respuesta exitosa', async () => {
      const deps = new FakeDeps();
      deps.outcome = { data: row({ created: true }), errorCode: null };
      deps.scheduleThrows = new Error('after() fuera de contexto de request');

      const res = await handleCreateWebOrder(request(validBody()), deps);

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body).toMatchObject({ created: true, order: { id: ORDER_ID } });
      // El mensaje técnico no llega al navegador.
      expect(JSON.stringify(body)).not.toContain('after()');
      expect(JSON.stringify(body)).not.toContain('fuera de contexto');
    });

    it('solo recibe orderId y mode: ni token, ni teléfono, ni carrito', async () => {
      const deps = new FakeDeps();
      deps.outcome = { data: row({ created: true }), errorCode: null };

      await handleCreateWebOrder(request(validBody()), deps);

      const input = deps.scheduleCalls[0];
      expect(Object.keys(input).sort()).toEqual(['mode', 'orderId']);
      const serialized = JSON.stringify(input);
      for (const secret of [SESSION_TOKEN, PHONE, 'la_fija', 'gaseosa_2l', 'Juan', 'Sin cebolla']) {
        expect(serialized).not.toContain(secret);
      }
    });

    describe('no programa en respuestas de error', () => {
      it('400 (JSON inválido)', async () => {
        const deps = new FakeDeps();
        const res = await handleCreateWebOrder(request(null, { rawBody: 'no-es-json' }), deps);
        expect(res.status).toBe(400);
        expect(deps.scheduleCalls).toEqual([]);
      });

      it('401 (sesión inválida o vencida)', async () => {
        const deps = new FakeDeps();
        deps.sessionId = null;
        const res = await handleCreateWebOrder(request(validBody()), deps);
        expect(res.status).toBe(401);
        expect(deps.scheduleCalls).toEqual([]);
      });

      it('409 (sesión usada con otro carrito)', async () => {
        const deps = new FakeDeps();
        deps.outcome = { data: null, errorCode: 'P1003' };
        const res = await handleCreateWebOrder(request(validBody()), deps);
        expect(res.status).toBe(409);
        expect(deps.scheduleCalls).toEqual([]);
      });

      it('422 (producto inactivo y validación)', async () => {
        const unavailable = new FakeDeps();
        unavailable.outcome = { data: null, errorCode: 'P1002' };
        expect((await handleCreateWebOrder(request(validBody()), unavailable)).status).toBe(422);
        expect(unavailable.scheduleCalls).toEqual([]);

        const invalid = new FakeDeps();
        const res = await handleCreateWebOrder(
          request(validBody({ customer_name: '' })),
          invalid,
        );
        expect(res.status).toBe(422);
        expect(invalid.scheduleCalls).toEqual([]);
      });

      it('500 (error inesperado de la RPC)', async () => {
        const unknown = new FakeDeps();
        unknown.outcome = { data: null, errorCode: 'XX000' };
        expect((await handleCreateWebOrder(request(validBody()), unknown)).status).toBe(500);
        expect(unknown.scheduleCalls).toEqual([]);

        const threw = new FakeDeps();
        threw.rpcThrows = new Error('conexión perdida');
        expect((await handleCreateWebOrder(request(validBody()), threw)).status).toBe(500);
        expect(threw.scheduleCalls).toEqual([]);
      });
    });
  });
});

describe('createNotificationScheduler', () => {
  const ORDER = ORDER_ID;

  function dispatchResult(overrides: Partial<DispatchResult> = {}): DispatchResult {
    return {
      ok: true,
      orderId: ORDER,
      confirmation: 'sent',
      locationRequest: 'sent',
      ...overrides,
    };
  }

  /** `after` falso: guarda el callback SIN ejecutarlo. */
  function fakeAfter() {
    const callbacks: Array<() => void | Promise<void>> = [];
    const after = (cb: () => void | Promise<void>) => {
      callbacks.push(cb);
    };
    return { after, callbacks, run: async () => Promise.all(callbacks.map((cb) => cb())) };
  }

  function runners(options: { throws?: boolean } = {}) {
    const initializeCalls: string[] = [];
    const existingCalls: string[] = [];
    return {
      initializeCalls,
      existingCalls,
      impl: {
        async initializeAndDispatch(orderId: string) {
          initializeCalls.push(orderId);
          if (options.throws) throw new Error('fallo interno con x-api-key=SECRETO');
          return dispatchResult();
        },
        async dispatchExisting(orderId: string) {
          existingCalls.push(orderId);
          if (options.throws) throw new Error('fallo interno con x-api-key=SECRETO');
          return dispatchResult({ confirmation: 'already_sent' });
        },
      },
    };
  }

  it('entrega a after() un callback, no una promesa ya ejecutada', () => {
    const a = fakeAfter();
    const r = runners();

    createNotificationScheduler(a.after, r.impl)({
      orderId: ORDER,
      mode: 'initialize_and_dispatch',
    });

    expect(a.callbacks).toHaveLength(1);
    expect(typeof a.callbacks[0]).toBe('function');
    // Nada se ejecutó todavía: el trabajo ocurre después de responder.
    expect(r.initializeCalls).toEqual([]);
    expect(r.existingCalls).toEqual([]);
  });

  it('initialize_and_dispatch invoca initializeAndDispatch con el orderId', async () => {
    const a = fakeAfter();
    const r = runners();

    createNotificationScheduler(a.after, r.impl)({
      orderId: ORDER,
      mode: 'initialize_and_dispatch',
    });
    await a.run();

    expect(r.initializeCalls).toEqual([ORDER]);
    expect(r.existingCalls).toEqual([]);
  });

  it('dispatch_existing invoca dispatchExisting y NUNCA initializeAndDispatch', async () => {
    const a = fakeAfter();
    const r = runners();

    createNotificationScheduler(a.after, r.impl)({ orderId: ORDER, mode: 'dispatch_existing' });
    await a.run();

    expect(r.existingCalls).toEqual([ORDER]);
    expect(r.initializeCalls).toEqual([]);
  });

  it('un throw del dispatch queda capturado dentro del callback', async () => {
    const a = fakeAfter();
    const r = runners({ throws: true });

    createNotificationScheduler(a.after, r.impl)({
      orderId: ORDER,
      mode: 'initialize_and_dispatch',
    });

    // No se propaga ni deja una promesa rechazada sin manejar.
    await expect(a.run()).resolves.toBeDefined();
    expect(r.initializeCalls).toEqual([ORDER]);
  });

  it('registrar el trabajo no ejecuta Supabase ni Kapso', () => {
    const a = fakeAfter();
    const r = runners();
    const schedule = createNotificationScheduler(a.after, r.impl);

    schedule({ orderId: ORDER, mode: 'initialize_and_dispatch' });
    schedule({ orderId: ORDER, mode: 'dispatch_existing' });

    expect(a.callbacks).toHaveLength(2);
    expect(r.initializeCalls).toEqual([]);
    expect(r.existingCalls).toEqual([]);
  });
});
