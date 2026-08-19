import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  createKapsoMessageHistory,
  extractNextCursor,
  extractOrderNumber,
  normalizeOutboundMessage,
  OUTBOUND_FIELDS,
  parseKapsoTimestamp,
} from './message-history';

const OFFICIAL_BASE_URL = 'https://api.kapso.ai/meta/whatsapp/v24.0';
const CONFIG = { apiKey: 'test-api-key', phoneNumberId: 'pnid-1', baseUrl: OFFICIAL_BASE_URL };
const SINCE = '2026-07-21T14:00:00.000Z';
const UNTIL = '2026-07-21T14:05:00.000Z';

interface Captured {
  url: string;
  method?: string;
  headers: Record<string, string>;
  body: unknown;
}

function fakeFetch(status: number, jsonBody: unknown, captured?: Captured[]) {
  return (async (url: RequestInfo | URL, init?: RequestInit) => {
    captured?.push({
      url: String(url),
      method: init?.method,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ?? null,
    });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => jsonBody,
    } as Response;
  }) as typeof fetch;
}

/** Forma representativa de un texto saliente, según lo confirmado por Kapso. */
function textMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: 'wamid.TEXT_1',
    timestamp: '2026-07-21T14:01:00.000Z',
    type: 'text',
    to: '59170000001',
    text: { body: '📦 ¡Recibí tu pedido ORD-000006!\nTotal: Bs. 90' },
    kapso: {
      direction: 'outbound',
      status: 'sent',
      processing_status: 'processed',
      content: '📦 ¡Recibí tu pedido ORD-000006!',
      whatsapp_conversation_id: 'conv-1',
    },
    ...overrides,
  };
}

/**
 * Forma representativa de una confirmación-QR saliente (6D.1): mensaje de imagen
 * cuyo caption lleva el texto de confirmación (con el número de pedido).
 */
function imageConfirmationMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: 'wamid.IMG_1',
    timestamp: '2026-07-21T14:01:00.000Z',
    type: 'image',
    to: '59170000001',
    image: {
      link: 'https://la-fija-orders.vercel.app/payment/qr.png',
      caption: '📦 ¡Recibí tu pedido ORD-000006!\nTotal: Bs. 90\n\n💳 Escanea este QR para pagar tu pedido.',
    },
    kapso: {
      direction: 'outbound',
      status: 'sent',
      processing_status: 'processed',
      whatsapp_conversation_id: 'conv-1',
    },
    ...overrides,
  };
}

/** Forma representativa de un location_request_message saliente. */
function locationMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: 'wamid.LOC_1',
    timestamp: '2026-07-21T14:02:00.000Z',
    type: 'interactive',
    to: '59170000001',
    interactive: {
      type: 'location_request_message',
      body: { text: '📍 Pedido ORD-000006: envíame tu ubicación GPS, por favor…' },
    },
    kapso: {
      direction: 'outbound',
      status: 'delivered',
      processing_status: 'processed',
      content: '📍 Pedido ORD-000006: envíame tu ubicación GPS, por favor…',
      message_type_data: { interactive_type: 'location_request_message' },
      whatsapp_conversation_id: 'conv-1',
    },
    ...overrides,
  };
}

describe('createKapsoMessageHistory — construcción de la consulta', () => {
  it('usa GET y la ruta oficial de mensajes', async () => {
    const captured: Captured[] = [];
    const history = createKapsoMessageHistory({
      ...CONFIG,
      fetchImpl: fakeFetch(200, { data: [] }, captured),
    });

    await history.listOutbound({ since: SINCE });

    expect(captured[0].method).toBe('GET');
    expect(captured[0].body).toBeNull();
    expect(captured[0].url.startsWith(`${OFFICIAL_BASE_URL}/pnid-1/messages?`)).toBe(true);
    expect(captured[0].headers['x-api-key']).toBe('test-api-key');
  });

  it('fija direction=outbound y pide los fields exactos', () => {
    const history = createKapsoMessageHistory(CONFIG);
    const url = new URL(history.buildUrl({ since: SINCE }));

    expect(url.searchParams.get('direction')).toBe('outbound');
    expect(url.searchParams.get('since')).toBe(SINCE);
    expect(url.searchParams.get('fields')).toBe(OUTBOUND_FIELDS);
    expect(OUTBOUND_FIELDS).toBe(
      'kapso(direction,status,processing_status,content,message_type_data,whatsapp_conversation_id)',
    );
  });

  it('incluye los filtros opcionales solo cuando se pasan', () => {
    const history = createKapsoMessageHistory(CONFIG);

    const minimal = new URL(history.buildUrl({ since: SINCE }));
    expect(minimal.searchParams.get('until')).toBeNull();
    expect(minimal.searchParams.get('status')).toBeNull();
    expect(minimal.searchParams.get('conversation_id')).toBeNull();
    expect(minimal.searchParams.get('after')).toBeNull();
    expect(minimal.searchParams.get('limit')).toBe('25');

    const full = new URL(
      history.buildUrl({
        since: SINCE,
        until: UNTIL,
        status: 'sent',
        conversationId: 'conv-1',
        limit: 10,
        after: 'cursor-abc',
      }),
    );
    expect(full.searchParams.get('until')).toBe(UNTIL);
    expect(full.searchParams.get('status')).toBe('sent');
    expect(full.searchParams.get('conversation_id')).toBe('conv-1');
    expect(full.searchParams.get('limit')).toBe('10');
    expect(full.searchParams.get('after')).toBe('cursor-abc');
  });

  it('permite un phone_number_id concreto en la ruta', () => {
    const history = createKapsoMessageHistory(CONFIG);
    const url = history.buildUrl({ since: SINCE, phoneNumberId: 'pnid-otro' });
    expect(url.startsWith(`${OFFICIAL_BASE_URL}/pnid-otro/messages?`)).toBe(true);
  });
});

describe('createKapsoMessageHistory — validación de la consulta', () => {
  it('rechaza since ausente o no ISO sin tocar la red', async () => {
    const captured: Captured[] = [];
    const history = createKapsoMessageHistory({
      ...CONFIG,
      fetchImpl: fakeFetch(200, { data: [] }, captured),
    });

    for (const since of ['', 'ayer', 'no-es-fecha']) {
      expect(await history.listOutbound({ since })).toEqual({ ok: false, error: 'invalid_query' });
    }
    expect(captured).toHaveLength(0);
  });

  it('rechaza until inválido o anterior a since', async () => {
    const history = createKapsoMessageHistory(CONFIG);

    expect(await history.listOutbound({ since: SINCE, until: 'nope' })).toEqual({
      ok: false,
      error: 'invalid_query',
    });
    expect(
      await history.listOutbound({ since: UNTIL, until: SINCE }),
    ).toEqual({ ok: false, error: 'invalid_query' });
  });

  it('rechaza limit fuera de rango o no entero', async () => {
    const history = createKapsoMessageHistory(CONFIG);
    for (const limit of [0, -1, 101, 1.5, Number.NaN]) {
      expect(await history.listOutbound({ since: SINCE, limit })).toEqual({
        ok: false,
        error: 'invalid_query',
      });
    }
  });

  it('rechaza phone_number_id vacío', async () => {
    const history = createKapsoMessageHistory({ ...CONFIG, phoneNumberId: '' });
    expect(await history.listOutbound({ since: SINCE })).toEqual({
      ok: false,
      error: 'invalid_query',
    });
  });
});

describe('createKapsoMessageHistory — respuestas', () => {
  it('acepta el envoltorio { data: [...] }', async () => {
    const history = createKapsoMessageHistory({
      ...CONFIG,
      fetchImpl: fakeFetch(200, { data: [textMessage()] }),
    });
    const res = await history.listOutbound({ since: SINCE });

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.messages).toHaveLength(1);
  });

  it('acepta { messages: [...] } y el array desnudo', async () => {
    const wrapped = createKapsoMessageHistory({
      ...CONFIG,
      fetchImpl: fakeFetch(200, { messages: [textMessage()] }),
    });
    const bare = createKapsoMessageHistory({
      ...CONFIG,
      fetchImpl: fakeFetch(200, [textMessage()]),
    });

    for (const client of [wrapped, bare]) {
      const res = await client.listOutbound({ since: SINCE });
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.messages[0].id).toBe('wamid.TEXT_1');
    }
  });

  it('conserva los campos anidados para el parser', async () => {
    const history = createKapsoMessageHistory({
      ...CONFIG,
      fetchImpl: fakeFetch(200, { data: [locationMessage()] }),
    });
    const res = await history.listOutbound({ since: SINCE });

    expect(res.ok).toBe(true);
    if (res.ok) {
      const raw = res.messages[0] as Record<string, unknown>;
      expect(raw.interactive).toBeDefined();
      expect(raw.kapso).toBeDefined();
    }
  });

  it('HTTP no exitoso -> http_error con status', async () => {
    const history = createKapsoMessageHistory({ ...CONFIG, fetchImpl: fakeFetch(503, {}) });
    expect(await history.listOutbound({ since: SINCE })).toEqual({
      ok: false,
      error: 'http_error',
      status: 503,
    });
  });

  it('forma inesperada -> invalid_response', async () => {
    for (const body of [null, 'texto', { unexpected: true }, { data: [{ sin_id: 1 }] }]) {
      const history = createKapsoMessageHistory({ ...CONFIG, fetchImpl: fakeFetch(200, body) });
      expect(await history.listOutbound({ since: SINCE })).toEqual({
        ok: false,
        error: 'invalid_response',
      });
    }
  });

  it('error de red -> network_error', async () => {
    const failing = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    const history = createKapsoMessageHistory({ ...CONFIG, fetchImpl: failing });

    expect(await history.listOutbound({ since: SINCE })).toEqual({
      ok: false,
      error: 'network_error',
    });
  });

  it('timeout propio -> timeout', async () => {
    vi.useFakeTimers();
    const hanging = ((_url: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      })) as typeof fetch;

    const history = createKapsoMessageHistory({ ...CONFIG, timeoutMs: 5_000, fetchImpl: hanging });
    const pending = history.listOutbound({ since: SINCE });
    await vi.advanceTimersByTimeAsync(5_000);

    expect(await pending).toEqual({ ok: false, error: 'timeout' });
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('ningún resultado de error filtra API key, teléfono ni URL', async () => {
    const history = createKapsoMessageHistory({ ...CONFIG, fetchImpl: fakeFetch(500, {}) });
    const res = await history.listOutbound({ since: SINCE });
    const serialized = JSON.stringify(res);

    expect(serialized).not.toContain('test-api-key');
    expect(serialized).not.toContain('59170000001');
    expect(serialized).not.toContain('api.kapso.ai');
  });
});

describe('extractNextCursor', () => {
  it('reconoce las formas habituales de paginación', () => {
    expect(extractNextCursor({ next_cursor: 'a' })).toBe('a');
    expect(extractNextCursor({ meta: { next_cursor: 'b' } })).toBe('b');
    expect(extractNextCursor({ meta: { after: 'c' } })).toBe('c');
    expect(extractNextCursor({ paging: { cursors: { after: 'd' } } })).toBe('d');
  });

  it('devuelve null cuando no hay cursor', () => {
    expect(extractNextCursor({ data: [] })).toBeNull();
    expect(extractNextCursor([])).toBeNull();
    expect(extractNextCursor(null)).toBeNull();
    expect(extractNextCursor({ meta: { next_cursor: '' } })).toBeNull();
  });
});

describe('extractOrderNumber', () => {
  it('extrae el número como token exacto', () => {
    expect(extractOrderNumber('Pedido ORD-000006 confirmado')).toBe('ORD-000006');
    expect(extractOrderNumber('📍 Pedido ORD-000123: envíame…')).toBe('ORD-000123');
  });

  it('no confunde coincidencias parciales', () => {
    expect(extractOrderNumber('XORD-000006')).toBeNull();
    expect(extractOrderNumber('ORD-123')).toBeNull();
    expect(extractOrderNumber('sin número')).toBeNull();
    expect(extractOrderNumber(null)).toBeNull();
  });
});

describe('parseKapsoTimestamp', () => {
  // 1730092860 = 2024-10-28T05:21:00.000Z
  const UNIX_SECONDS = 1730092860;
  const EXPECTED_MS = 1730092860000;

  it('acepta Unix en segundos, como número y como string', () => {
    expect(parseKapsoTimestamp(UNIX_SECONDS)).toBe(EXPECTED_MS);
    expect(parseKapsoTimestamp('1730092860')).toBe(EXPECTED_MS);
  });

  it('acepta Unix en milisegundos, como número y como string', () => {
    expect(parseKapsoTimestamp(EXPECTED_MS)).toBe(EXPECTED_MS);
    expect(parseKapsoTimestamp('1730092860000')).toBe(EXPECTED_MS);
  });

  it('acepta ISO 8601', () => {
    expect(parseKapsoTimestamp('2024-10-28T05:21:00.000Z')).toBe(EXPECTED_MS);
    expect(parseKapsoTimestamp('2024-10-28T05:21:00Z')).toBe(EXPECTED_MS);
  });

  it('rechaza strings numéricos con longitud no soportada', () => {
    expect(parseKapsoTimestamp('12345')).toBeNull();
    expect(parseKapsoTimestamp('173009286')).toBeNull(); // 9 dígitos
    expect(parseKapsoTimestamp('17300928600')).toBeNull(); // 11 dígitos
  });

  it('rechaza vacío, negativo, NaN y valores fuera de rango', () => {
    expect(parseKapsoTimestamp('')).toBeNull();
    expect(parseKapsoTimestamp('   ')).toBeNull();
    expect(parseKapsoTimestamp(-1730092860)).toBeNull();
    expect(parseKapsoTimestamp('-1730092860')).toBeNull();
    expect(parseKapsoTimestamp(Number.NaN)).toBeNull();
    expect(parseKapsoTimestamp(Infinity)).toBeNull();
    expect(parseKapsoTimestamp(99999999999999999)).toBeNull();
    expect(parseKapsoTimestamp(0)).toBeNull();
    expect(parseKapsoTimestamp(1.5)).toBeNull();
  });

  it('rechaza fechas inválidas y tipos no soportados', () => {
    expect(parseKapsoTimestamp('ayer')).toBeNull();
    expect(parseKapsoTimestamp('2024-13-45T99:99:99Z')).toBeNull();
    expect(parseKapsoTimestamp(null)).toBeNull();
    expect(parseKapsoTimestamp(undefined)).toBeNull();
    expect(parseKapsoTimestamp({})).toBeNull();
    expect(parseKapsoTimestamp([])).toBeNull();
  });

  it('nunca convierte un valor inválido en la fecha actual', () => {
    const now = Date.now();
    for (const bad of ['', 'ayer', -1, Number.NaN, null]) {
      const parsed = parseKapsoTimestamp(bad);
      expect(parsed).toBeNull();
      expect(parsed).not.toBe(now);
    }
  });
});

describe('normalizeOutboundMessage', () => {
  it('interpreta un timestamp Unix en segundos de Kapso', () => {
    const normalized = normalizeOutboundMessage(textMessage({ timestamp: 1730092860 }));
    expect(normalized?.timestampMs).toBe(1730092860000);
    expect(normalized?.timestamp).toBe('2024-10-28T05:21:00.000Z');
  });

  it('interpreta un timestamp Unix en segundos como string', () => {
    const normalized = normalizeOutboundMessage(textMessage({ timestamp: '1730092860' }));
    expect(normalized?.timestampMs).toBe(1730092860000);
  });

  it('un timestamp ilegible deja timestampMs en null, no la hora actual', () => {
    const normalized = normalizeOutboundMessage(textMessage({ timestamp: 'ayer' }));
    expect(normalized?.timestampMs).toBeNull();
    expect(normalized?.timestamp).toBeNull();
  });

  it('normaliza un texto de confirmación', () => {
    expect(normalizeOutboundMessage(textMessage())).toEqual({
      externalMessageId: 'wamid.TEXT_1',
      timestamp: '2026-07-21T14:01:00.000Z',
      timestampMs: Date.parse('2026-07-21T14:01:00.000Z'),
      recipient: '59170000001',
      direction: 'outbound',
      type: 'confirmation',
      orderNumber: 'ORD-000006',
      status: 'sent',
      conversationId: 'conv-1',
    });
  });

  it('normaliza una solicitud de ubicación', () => {
    const normalized = normalizeOutboundMessage(locationMessage());
    expect(normalized?.type).toBe('location_request');
    expect(normalized?.orderNumber).toBe('ORD-000006');
    expect(normalized?.status).toBe('delivered');
  });

  it('detecta location_request por message_type_data cuando falta interactive', () => {
    const raw = locationMessage({ interactive: undefined });
    expect(normalizeOutboundMessage(raw)?.type).toBe('location_request');
  });

  it('no confía en campos opcionales ausentes', () => {
    const normalized = normalizeOutboundMessage({ id: 'wamid.MIN' });
    expect(normalized).toEqual({
      externalMessageId: 'wamid.MIN',
      timestamp: null,
      timestampMs: null,
      recipient: null,
      direction: null,
      type: 'unknown',
      orderNumber: null,
      status: null,
      conversationId: null,
    });
  });

  it('degrada a unknown ante tipos no soportados', () => {
    const image = normalizeOutboundMessage({ id: 'wamid.IMG', type: 'image' });
    expect(image?.type).toBe('unknown');

    const otherInteractive = normalizeOutboundMessage({
      id: 'wamid.CTA',
      type: 'interactive',
      interactive: { type: 'cta_url' },
    });
    expect(otherInteractive?.type).toBe('unknown');
  });

  describe('6D.1 — confirmación como imagen del QR (reconciliación robusta)', () => {
    it('imagen con caption que lleva el número de pedido → confirmation + orderNumber', () => {
      const n = normalizeOutboundMessage(imageConfirmationMessage());
      expect(n?.type).toBe('confirmation');
      expect(n?.orderNumber).toBe('ORD-000006');
      expect(n?.recipient).toBe('59170000001');
    });

    it('imagen SIN número de pedido en el caption → NO es confirmación (unknown)', () => {
      const n = normalizeOutboundMessage(
        imageConfirmationMessage({ image: { link: 'x', caption: 'Escanea este QR para pagar.' } }),
      );
      expect(n?.type).toBe('unknown');
      expect(n?.orderNumber).toBeNull();
    });

    it('imagen SIN caption alguno → unknown (no es un "image = confirmation" ciego)', () => {
      const n = normalizeOutboundMessage(
        imageConfirmationMessage({ image: { link: 'x' } }),
      );
      expect(n?.type).toBe('unknown');
      expect(n?.orderNumber).toBeNull();
    });

    it('el matcher extrae el order_number del caption para emparejar el saliente', () => {
      // Un caption con OTRO pedido produce OTRO orderNumber (no matchearía el actual).
      const n = normalizeOutboundMessage(
        imageConfirmationMessage({ image: { link: 'x', caption: '📦 ¡Recibí tu pedido ORD-999999!' } }),
      );
      expect(n?.type).toBe('confirmation');
      expect(n?.orderNumber).toBe('ORD-999999');
    });
  });

  it('rechaza formas sin id', () => {
    for (const raw of [null, 'texto', 42, [], {}, { id: '' }]) {
      expect(normalizeOutboundMessage(raw)).toBeNull();
    }
  });

  it('normaliza el teléfono del destinatario', () => {
    const raw = textMessage({ to: '+591 7000-0001' });
    expect(normalizeOutboundMessage(raw)?.recipient).toBe('59170000001');
  });
});
