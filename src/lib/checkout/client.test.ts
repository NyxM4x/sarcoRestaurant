import { describe, it, expect, vi } from 'vitest';
import { CHECKOUT_ENDPOINT, CHECKOUT_TIMEOUT_MS, submitOrder } from './client';
import type { NormalizedCheckout } from './form';

const TOKEN = 'token-opaco-de-prueba';

const CHECKOUT: NormalizedCheckout = {
  customer_name: 'Juan García',
  delivery_type: 'delivery',
  payment_method: 'cash',
  notes: 'Sin cebolla',
  items: [
    { code: 'la_fija', quantity: 1 },
    { code: 'gaseosa_2l', quantity: 2 },
  ],
};

/** Pedido válido y completo, tal como lo devuelve el backend. */
function validOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    order_number: 'ORD-000123',
    customer_name: 'Juan García',
    delivery_type: 'delivery',
    status: 'awaiting_location',
    subtotal_amount: 40,
    delivery_amount: 0,
    total_amount: 40,
    created_at: '2026-07-20T14:30:00.000Z',
    ...overrides,
  };
}

function orderPayload(overrides: Record<string, unknown> = {}, created = true) {
  return {
    order: validOrder(overrides),
    created,
    next_action: 'return_to_whatsapp_for_location',
  };
}

/** `fetch` falso que devuelve una respuesta fija y registra la llamada. */
function fakeFetch(response: Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Respuesta cuyo cuerpo nunca llega hasta que se aborta la señal. */
function hangingBodyResponse(status: number, signal: AbortSignal): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      }),
  } as unknown as Response;
}

describe('submitOrder — éxito', () => {
  it('201 devuelve el pedido con created true', async () => {
    const { impl } = fakeFetch(jsonResponse(201, orderPayload()));
    const result = await submitOrder(TOKEN, CHECKOUT, { fetchImpl: impl });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.created).toBe(true);
      expect(result.order.order_number).toBe('ORD-000123');
      expect(result.order.total_amount).toBe(40);
      expect(result.order.status).toBe('awaiting_location');
    }
  });

  it('200 idempotente devuelve created false con el mismo pedido', async () => {
    const { impl } = fakeFetch(jsonResponse(200, orderPayload({}, false)));
    const result = await submitOrder(TOKEN, CHECKOUT, { fetchImpl: impl });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.created).toBe(false);
      expect(result.order.id).toBe('22222222-2222-4222-8222-222222222222');
    }
  });

  it('pickup con status confirmed se mapea correctamente', async () => {
    const { impl } = fakeFetch(
      jsonResponse(201, orderPayload({ delivery_type: 'pickup', status: 'confirmed' })),
    );
    const result = await submitOrder(TOKEN, { ...CHECKOUT, delivery_type: 'pickup' }, {
      fetchImpl: impl,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.order.delivery_type).toBe('pickup');
      expect(result.order.status).toBe('confirmed');
    }
  });

  it('acepta montos en cero', async () => {
    const { impl } = fakeFetch(
      jsonResponse(201, orderPayload({ subtotal_amount: 0, total_amount: 0 })),
    );
    const result = await submitOrder(TOKEN, CHECKOUT, { fetchImpl: impl });
    expect(result.ok).toBe(true);
  });
});

describe('submitOrder — body enviado', () => {
  it('llama al endpoint correcto con POST y JSON', async () => {
    const { impl, calls } = fakeFetch(jsonResponse(201, orderPayload()));
    await submitOrder(TOKEN, CHECKOUT, { fetchImpl: impl });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(CHECKOUT_ENDPOINT);
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.headers).toMatchObject({ 'content-type': 'application/json' });
  });

  it('envía exactamente las seis claves permitidas', async () => {
    const { impl, calls } = fakeFetch(jsonResponse(201, orderPayload()));
    await submitOrder(TOKEN, CHECKOUT, { fetchImpl: impl });

    const body = JSON.parse(calls[0].init.body as string);
    expect(Object.keys(body).sort()).toEqual([
      'customer_name',
      'delivery_type',
      'items',
      'notes',
      'payment_method',
      'session_token',
    ]);
    expect(body.payment_method).toBe('cash');
  });

  it('cada item lleva solo code y quantity', async () => {
    const { impl, calls } = fakeFetch(jsonResponse(201, orderPayload()));
    await submitOrder(TOKEN, CHECKOUT, { fetchImpl: impl });

    const body = JSON.parse(calls[0].init.body as string);
    for (const item of body.items) {
      expect(Object.keys(item).sort()).toEqual(['code', 'quantity']);
    }
  });

  it('no envía precios, montos, teléfono, fingerprint ni estado', async () => {
    const { impl, calls } = fakeFetch(jsonResponse(201, orderPayload()));
    await submitOrder(TOKEN, CHECKOUT, { fetchImpl: impl });

    const raw = calls[0].init.body as string;
    for (const prohibido of [
      'price',
      'subtotal',
      'total_amount',
      'delivery_amount',
      'customer_phone',
      'phone_number_id',
      'menu_session_id',
      'checkout_fingerprint',
      'status',
      'order_number',
      'currency',
    ]) {
      expect(raw).not.toContain(prohibido);
    }
  });

  it('envía notes null cuando no hay notas', async () => {
    const { impl, calls } = fakeFetch(jsonResponse(201, orderPayload()));
    await submitOrder(TOKEN, { ...CHECKOUT, notes: null }, { fetchImpl: impl });

    expect(JSON.parse(calls[0].init.body as string).notes).toBeNull();
  });

  it('adjunta el token solo en el body de la petición', async () => {
    const { impl, calls } = fakeFetch(jsonResponse(201, orderPayload()));
    await submitOrder(TOKEN, CHECKOUT, { fetchImpl: impl });

    expect(JSON.parse(calls[0].init.body as string).session_token).toBe(TOKEN);
    expect(calls[0].url).not.toContain(TOKEN);
    expect(JSON.stringify(calls[0].init.headers)).not.toContain(TOKEN);
  });
});

describe('submitOrder — errores HTTP con cuerpo JSON', () => {
  const casos: Array<[number, string, string, string]> = [
    [400, 'invalid_json', 'invalid_json', 'retry_same'],
    [401, 'invalid_session', 'invalid_session', 'none'],
    [409, 'session_already_used', 'session_already_used', 'none'],
    [422, 'validation_error', 'validation_error', 'fix_form'],
    [422, 'product_unavailable', 'product_unavailable', 'fix_cart'],
    [500, 'internal_error', 'internal_error', 'retry_same'],
  ];

  for (const [status, code, kind, recovery] of casos) {
    it(`${status} ${code} → ${kind} (${recovery})`, async () => {
      const { impl } = fakeFetch(jsonResponse(status, { error: code, message: 'mensaje seguro' }));
      const result = await submitOrder(TOKEN, CHECKOUT, { fetchImpl: impl });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.failure.kind).toBe(kind);
        expect(result.failure.recovery).toBe(recovery);
      }
    });
  }
});

describe('submitOrder — cuerpo no interpretable como JSON', () => {
  // Regla: si el cuerpo no se puede leer, el resultado es ambiguo SIEMPRE,
  // antes de mirar el status. No sabemos qué ocurrió realmente en el servidor.
  const statuses = [200, 201, 400, 401, 409, 422, 500, 502];

  for (const status of statuses) {
    it(`${status} con cuerpo no JSON → unreadable_response ambiguo`, async () => {
      const { impl } = fakeFetch(new Response('<html>oops</html>', { status }));
      const result = await submitOrder(TOKEN, CHECKOUT, { fetchImpl: impl });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.failure.kind).toBe('unreadable_response');
        expect(result.failure.ambiguous).toBe(true);
        expect(result.failure.recovery).toBe('retry_same');
      }
    });
  }

  it('no expone el cuerpo crudo en el mensaje', async () => {
    const { impl } = fakeFetch(new Response('P0001: relation "public.orders"', { status: 500 }));
    const result = await submitOrder(TOKEN, CHECKOUT, { fetchImpl: impl });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(JSON.stringify(result.failure)).not.toContain('P0001');
      expect(JSON.stringify(result.failure)).not.toContain('public.orders');
    }
  });
});

describe('submitOrder — validación estricta de respuestas 2xx', () => {
  async function submitWith(payload: unknown) {
    const { impl } = fakeFetch(jsonResponse(201, payload));
    return submitOrder(TOKEN, CHECKOUT, { fetchImpl: impl });
  }

  async function expectUnreadable(payload: unknown) {
    const result = await submitWith(payload);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe('unreadable_response');
      expect(result.failure.ambiguous).toBe(true);
      expect(result.failure.recovery).toBe('retry_same');
    }
  }

  it('sin order es ilegible', async () => {
    await expectUnreadable({ created: true });
  });

  it('sin created es ilegible', async () => {
    await expectUnreadable({ order: validOrder() });
  });

  it('created no booleano es ilegible', async () => {
    await expectUnreadable({ order: validOrder(), created: 'true' });
  });

  const camposRequeridos = [
    'id',
    'order_number',
    'customer_name',
    'created_at',
    'delivery_type',
    'status',
    'subtotal_amount',
    'delivery_amount',
    'total_amount',
  ];

  for (const campo of camposRequeridos) {
    it(`sin ${campo} es ilegible`, async () => {
      const order = validOrder();
      delete (order as Record<string, unknown>)[campo];
      await expectUnreadable({ order, created: true });
    });
  }

  const camposTexto = ['id', 'order_number', 'customer_name', 'created_at'];

  for (const campo of camposTexto) {
    it(`${campo} vacío es ilegible`, async () => {
      await expectUnreadable({ order: validOrder({ [campo]: '' }), created: true });
    });

    it(`${campo} solo con espacios es ilegible`, async () => {
      await expectUnreadable({ order: validOrder({ [campo]: '   ' }), created: true });
    });
  }

  const camposMonto = ['subtotal_amount', 'delivery_amount', 'total_amount'];

  for (const campo of camposMonto) {
    it(`${campo} como string numérico es ilegible`, async () => {
      await expectUnreadable({ order: validOrder({ [campo]: '40' }), created: true });
    });

    it(`${campo} NaN es ilegible`, async () => {
      await expectUnreadable({ order: validOrder({ [campo]: Number.NaN }), created: true });
    });

    it(`${campo} negativo es ilegible`, async () => {
      await expectUnreadable({ order: validOrder({ [campo]: -1 }), created: true });
    });

    it(`${campo} null es ilegible`, async () => {
      await expectUnreadable({ order: validOrder({ [campo]: null }), created: true });
    });
  }

  it('Infinity es ilegible', async () => {
    // JSON.stringify convierte Infinity en null; se prueba directamente.
    const response = new Response('{"order":{"total_amount":1e999},"created":true}', {
      status: 201,
    });
    const { impl } = fakeFetch(response);
    const result = await submitOrder(TOKEN, CHECKOUT, { fetchImpl: impl });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.kind).toBe('unreadable_response');
  });

  it('status desconocido es ilegible', async () => {
    await expectUnreadable({ order: validOrder({ status: 'shipped_to_mars' }), created: true });
  });

  it('status vacío es ilegible', async () => {
    await expectUnreadable({ order: validOrder({ status: '' }), created: true });
  });

  it('delivery_type inválido es ilegible', async () => {
    await expectUnreadable({ order: validOrder({ delivery_type: 'express' }), created: true });
  });

  it('acepta todos los estados válidos del catálogo', async () => {
    for (const status of ['draft', 'awaiting_location', 'confirmed', 'preparing', 'ready']) {
      const result = await submitWith(orderPayload({ status }));
      expect(result.ok).toBe(true);
    }
  });

  it('order que no es objeto es ilegible', async () => {
    await expectUnreadable({ order: 'ORD-000123', created: true });
  });

  it('body que no es objeto es ilegible', async () => {
    await expectUnreadable('ok');
  });
});

describe('submitOrder — transporte y timeout', () => {
  it('fetch que rechaza produce un fallo de red ambiguo', async () => {
    const impl = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;

    const result = await submitOrder(TOKEN, CHECKOUT, { fetchImpl: impl });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe('network_error');
      expect(result.failure.ambiguous).toBe(true);
    }
  });

  it('el timeout durante el fetch produce timeout', async () => {
    const impl = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      })) as unknown as typeof fetch;

    const result = await submitOrder(TOKEN, CHECKOUT, { fetchImpl: impl, timeoutMs: 10 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe('timeout');
      expect(result.failure.ambiguous).toBe(true);
      expect(result.failure.recovery).toBe('retry_same');
    }
  });

  it('el timeout cubre también response.json()', async () => {
    // El fetch resuelve enseguida, pero el cuerpo nunca llega.
    const impl = (async (_url: string, init: RequestInit) =>
      hangingBodyResponse(200, init.signal as AbortSignal)) as unknown as typeof fetch;

    const started = Date.now();
    const result = await submitOrder(TOKEN, CHECKOUT, { fetchImpl: impl, timeoutMs: 40 });
    const elapsed = Date.now() - started;

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe('timeout');
      expect(result.failure.ambiguous).toBe(true);
    }
    // Se esperó realmente al temporizador: no se cortó antes de leer el cuerpo.
    expect(elapsed).toBeGreaterThanOrEqual(30);
  });

  it('el timeout por defecto es de 20 segundos', () => {
    expect(CHECKOUT_TIMEOUT_MS).toBe(20_000);
  });

  it('limpia el temporizador cuando la respuesta llega a tiempo', async () => {
    const clear = vi.spyOn(globalThis, 'clearTimeout');
    const { impl } = fakeFetch(jsonResponse(201, orderPayload()));

    await submitOrder(TOKEN, CHECKOUT, { fetchImpl: impl });

    expect(clear).toHaveBeenCalled();
    clear.mockRestore();
  });

  it('limpia el temporizador también cuando la respuesta es ilegible', async () => {
    const clear = vi.spyOn(globalThis, 'clearTimeout');
    const { impl } = fakeFetch(new Response('no json', { status: 200 }));

    await submitOrder(TOKEN, CHECKOUT, { fetchImpl: impl });

    expect(clear).toHaveBeenCalled();
    clear.mockRestore();
  });

  it('una señal ya abortada corta la operación sin colgarse', async () => {
    const external = new AbortController();
    external.abort();

    const impl = (async (_url: string, init: RequestInit) => {
      if (init.signal?.aborted) {
        const error = new Error('aborted');
        error.name = 'AbortError';
        throw error;
      }
      return jsonResponse(201, orderPayload());
    }) as unknown as typeof fetch;

    const result = await submitOrder(TOKEN, CHECKOUT, {
      fetchImpl: impl,
      signal: external.signal,
    });

    expect(result.ok).toBe(false);
    // No fue nuestro temporizador: se clasifica como fallo de red, también ambiguo.
    if (!result.ok) {
      expect(result.failure.kind).toBe('network_error');
      expect(result.failure.ambiguous).toBe(true);
    }
  });

  it('una señal ya abortada no deja listeners registrados', async () => {
    const external = new AbortController();
    external.abort();
    const add = vi.spyOn(external.signal, 'addEventListener');

    const impl = (async () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    }) as unknown as typeof fetch;

    await submitOrder(TOKEN, CHECKOUT, { fetchImpl: impl, signal: external.signal });

    expect(add).not.toHaveBeenCalled();
    add.mockRestore();
  });

  it('el abort externo posterior aborta la petición', async () => {
    const external = new AbortController();

    const impl = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
        setTimeout(() => external.abort(), 5);
      })) as unknown as typeof fetch;

    const result = await submitOrder(TOKEN, CHECKOUT, {
      fetchImpl: impl,
      signal: external.signal,
      timeoutMs: 5000,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.ambiguous).toBe(true);
  });
});

describe('submitOrder — no imprime nada', () => {
  it('no escribe en consola en ninguna rama', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await submitOrder(TOKEN, CHECKOUT, { fetchImpl: fakeFetch(jsonResponse(201, orderPayload())).impl });
    await submitOrder(TOKEN, CHECKOUT, {
      fetchImpl: fakeFetch(jsonResponse(500, { error: 'internal_error' })).impl,
    });
    await submitOrder(TOKEN, CHECKOUT, { fetchImpl: fakeFetch(new Response('x', { status: 200 })).impl });
    await submitOrder(TOKEN, CHECKOUT, {
      fetchImpl: (async () => {
        throw new TypeError('Failed to fetch');
      }) as unknown as typeof fetch,
    });

    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();

    logSpy.mockRestore();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });
});
