import { describe, it, expect, vi, afterEach } from 'vitest';
import { createKapsoTransport } from './transport';
import {
  buildWebLocationRequestBodyText,
  LOCATION_REQUEST_BODY_TEXT,
  MENU_CTA_BODY_TEXT,
  MENU_CTA_BUTTON_TEXT,
  MENU_URL,
  MENU_COVER_URL,
} from './messages';

const WEB_LOCATION_REQUEST_BODY_TEXT = buildWebLocationRequestBodyText('ORD-000042');

// URL base oficial confirmada por la documentación de Kapso (client.ts la usa
// como default; aquí se inyecta explícitamente para no depender del env).
const OFFICIAL_BASE_URL = 'https://api.kapso.ai/meta/whatsapp/v24.0';

const CONFIG = {
  apiKey: 'test-api-key',
  phoneNumberId: 'pnid-1',
  baseUrl: OFFICIAL_BASE_URL,
};

interface Captured {
  url: string;
  method?: string;
  headers: Record<string, string>;
  body: unknown;
}

/** fetch falso que captura el request y devuelve la respuesta indicada. */
function fakeFetch(status: number, jsonBody: unknown, captured?: Captured[]) {
  return (async (url: RequestInfo | URL, init?: RequestInit) => {
    captured?.push({
      url: String(url),
      method: init?.method,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => jsonBody,
    } as Response;
  }) as typeof fetch;
}

describe('createKapsoTransport.sendLocationRequest', () => {
  it('envía el payload EXACTO de location_request_message y devuelve el wamid', async () => {
    const captured: Captured[] = [];
    const client = createKapsoTransport({
      ...CONFIG,
      fetchImpl: fakeFetch(200, { messages: [{ id: 'wamid.LOC_1' }] }, captured),
    });

    const res = await client.sendLocationRequest('59170000001');
    expect(res).toEqual({ ok: true, wamid: 'wamid.LOC_1' });

    expect(captured).toHaveLength(1);
    // URL final EXACTA: base oficial + phone_number_id insertado en la ruta.
    expect(captured[0].url).toBe(
      'https://api.kapso.ai/meta/whatsapp/v24.0/pnid-1/messages',
    );
    expect(captured[0].method).toBe('POST');
    expect(captured[0].headers['x-api-key']).toBe('test-api-key');
    expect(captured[0].headers['content-type']).toBe('application/json');
    // Payload exacto confirmado por Kapso Support.
    expect(captured[0].body).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '59170000001',
      type: 'interactive',
      interactive: {
        type: 'location_request_message',
        body: { text: LOCATION_REQUEST_BODY_TEXT },
        action: { name: 'send_location' },
      },
    });
  });

  it('normaliza el teléfono (+, espacios, guiones) antes de enviar', async () => {
    const captured: Captured[] = [];
    const client = createKapsoTransport({
      ...CONFIG,
      fetchImpl: fakeFetch(200, { messages: [{ id: 'wamid.LOC_2' }] }, captured),
    });
    const res = await client.sendLocationRequest('+591 7000-0001');
    expect(res.ok).toBe(true);
    expect((captured[0].body as { to: string }).to).toBe('59170000001');
  });

  it('rechaza teléfono vacío o sin dígitos sin llamar a fetch', async () => {
    const captured: Captured[] = [];
    const client = createKapsoTransport({
      ...CONFIG,
      fetchImpl: fakeFetch(200, { messages: [{ id: 'x' }] }, captured),
    });
    expect(await client.sendLocationRequest('')).toEqual({ ok: false, error: 'invalid_phone' });
    expect(await client.sendLocationRequest('+++ --')).toEqual({ ok: false, error: 'invalid_phone' });
    expect(captured).toHaveLength(0);
  });

  it('HTTP no exitoso -> http_error con status', async () => {
    const client = createKapsoTransport({
      ...CONFIG,
      fetchImpl: fakeFetch(503, { error: 'unavailable' }),
    });
    const res = await client.sendLocationRequest('59170000001');
    expect(res).toEqual({ ok: false, error: 'http_error', status: 503 });
  });

  it('respuesta sin messages[0].id -> invalid_response (no inventa wamid)', async () => {
    const client = createKapsoTransport({
      ...CONFIG,
      fetchImpl: fakeFetch(200, { messages: [] }),
    });
    const res = await client.sendLocationRequest('59170000001');
    expect(res).toEqual({ ok: false, error: 'invalid_response' });

    const client2 = createKapsoTransport({
      ...CONFIG,
      fetchImpl: fakeFetch(200, { messages: [{ id: '' }] }),
    });
    expect(await client2.sendLocationRequest('59170000001')).toEqual({
      ok: false,
      error: 'invalid_response',
    });
  });

  it('timeout -> { ok: false, error: timeout }', async () => {
    const hangingFetch = ((url: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      })) as typeof fetch;

    const client = createKapsoTransport({ ...CONFIG, timeoutMs: 10, fetchImpl: hangingFetch });
    const res = await client.sendLocationRequest('59170000001');
    expect(res).toEqual({ ok: false, error: 'timeout' });
  });

  it('error de red -> network_error', async () => {
    const failingFetch = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    const client = createKapsoTransport({ ...CONFIG, fetchImpl: failingFetch });
    const res = await client.sendLocationRequest('59170000001');
    expect(res).toEqual({ ok: false, error: 'network_error' });
  });
});

describe('createKapsoTransport.sendMenuCtaUrl (Fase 5.2A)', () => {
  it('envía el CTA URL con el botón "Ver menú" y la URL de la tienda', async () => {
    const captured: Captured[] = [];
    const client = createKapsoTransport({
      ...CONFIG,
      fetchImpl: fakeFetch(200, { messages: [{ id: 'wamid.CTA_1' }] }, captured),
    });

    const res = await client.sendMenuCtaUrl('59170000001');
    expect(res).toEqual({ ok: true, wamid: 'wamid.CTA_1' });

    expect(captured).toHaveLength(1);
    expect(captured[0].method).toBe('POST');
    expect(captured[0].headers['x-api-key']).toBe('test-api-key');
    expect(captured[0].body).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '59170000001',
      type: 'interactive',
      interactive: {
        type: 'cta_url',
        header: { type: 'image', image: { link: MENU_COVER_URL } },
        body: { text: MENU_CTA_BODY_TEXT },
        action: {
          name: 'cta_url',
          parameters: { display_text: MENU_CTA_BUTTON_TEXT, url: MENU_URL },
        },
      },
    });
  });

  it('los textos son EXACTAMENTE los pedidos', () => {
    // El de saludo lleva el horario y dice DÓNDE se termina el pedido: suele ser
    // el primer mensaje que recibe un cliente nuevo, y es la única ocasión de
    // explicárselo — un `send_menu` confirmado no redacta nada después.
    expect(MENU_CTA_BODY_TEXT).toBe(
      'Hola, soy Don Zarco 👋 Atendemos todos los días de 18:00 a 04:00. ' +
        'Toca el botón para ver el menú, elegir lo que quieras y mandar tu pedido desde ahí mismo.',
    );
    expect(MENU_CTA_BUTTON_TEXT).toBe('Ver menú');
    expect(MENU_URL).toBe('https://sarco-restaurant.vercel.app/menu');
    expect(MENU_COVER_URL).toBe('https://sarco-restaurant.vercel.app/menu/menu-cover.jpeg');
  });

  it('6D.2E: header image + el session_token viaja SOLO en la URL (no en body/header)', async () => {
    const captured: Captured[] = [];
    const client = createKapsoTransport({
      ...CONFIG,
      fetchImpl: fakeFetch(200, { messages: [{ id: 'wamid.CTA_TOK' }] }, captured),
    });

    const menuUrl = 'https://sarco-restaurant.vercel.app/menu?session=TOKEN_SECRETO_123';
    await client.sendMenuCtaUrl('59170000001', { menuUrl });

    const interactive = (captured[0].body as { interactive: Record<string, unknown> }).interactive;
    // Opción A: un solo cta_url con header de imagen.
    expect(interactive.type).toBe('cta_url');
    expect(interactive.header).toEqual({ type: 'image', image: { link: MENU_COVER_URL } });
    // El token está en la URL del botón…
    expect(JSON.stringify(interactive.action)).toContain('TOKEN_SECRETO_123');
    // …pero NUNCA en el body ni en el header.
    expect(JSON.stringify(interactive.body)).not.toContain('TOKEN_SECRETO_123');
    expect(JSON.stringify(interactive.header)).not.toContain('TOKEN_SECRETO_123');
  });

  it('usa el phone_number_id indicado en la ruta (no el del entorno)', async () => {
    const captured: Captured[] = [];
    const client = createKapsoTransport({
      ...CONFIG,
      fetchImpl: fakeFetch(200, { messages: [{ id: 'wamid.CTA_2' }] }, captured),
    });

    await client.sendMenuCtaUrl('59170000001', { phoneNumberId: 'pnid-evento' });
    expect(captured[0].url).toBe(
      'https://api.kapso.ai/meta/whatsapp/v24.0/pnid-evento/messages',
    );
  });

  it('sin phone_number_id explícito usa el del entorno', async () => {
    const captured: Captured[] = [];
    const client = createKapsoTransport({
      ...CONFIG,
      fetchImpl: fakeFetch(200, { messages: [{ id: 'wamid.CTA_3' }] }, captured),
    });

    await client.sendMenuCtaUrl('59170000001', { phoneNumberId: null });
    expect(captured[0].url).toBe('https://api.kapso.ai/meta/whatsapp/v24.0/pnid-1/messages');
  });

  it('normaliza el teléfono destinatario', async () => {
    const captured: Captured[] = [];
    const client = createKapsoTransport({
      ...CONFIG,
      fetchImpl: fakeFetch(200, { messages: [{ id: 'wamid.CTA_4' }] }, captured),
    });

    await client.sendMenuCtaUrl('+591 7000-0001');
    expect((captured[0].body as { to: string }).to).toBe('59170000001');
  });

  it('propaga los errores tipados igual que el envío de ubicación', async () => {
    const captured: Captured[] = [];
    const noPhone = createKapsoTransport({
      ...CONFIG,
      fetchImpl: fakeFetch(200, { messages: [{ id: 'x' }] }, captured),
    });
    expect(await noPhone.sendMenuCtaUrl('')).toEqual({ ok: false, error: 'invalid_phone' });
    expect(captured).toHaveLength(0);

    const httpError = createKapsoTransport({ ...CONFIG, fetchImpl: fakeFetch(500, {}) });
    expect(await httpError.sendMenuCtaUrl('59170000001')).toEqual({
      ok: false,
      error: 'http_error',
      status: 500,
    });

    const badShape = createKapsoTransport({ ...CONFIG, fetchImpl: fakeFetch(200, { messages: [] }) });
    expect(await badShape.sendMenuCtaUrl('59170000001')).toEqual({
      ok: false,
      error: 'invalid_response',
    });
  });
});

describe('createKapsoTransport.sendText (Fase 5.2D)', () => {
  it('envía el payload de texto correcto y devuelve el wamid', async () => {
    const captured: Captured[] = [];
    const client = createKapsoTransport({
      ...CONFIG,
      fetchImpl: fakeFetch(200, { messages: [{ id: 'wamid.TXT_1' }] }, captured),
    });

    const res = await client.sendText('59170000001', 'Hola 👋');
    expect(res).toEqual({ ok: true, wamid: 'wamid.TXT_1' });

    expect(captured).toHaveLength(1);
    expect(captured[0].method).toBe('POST');
    expect(captured[0].headers['x-api-key']).toBe('test-api-key');
    expect(captured[0].body).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '59170000001',
      type: 'text',
      text: { body: 'Hola 👋' },
    });
  });

  it('usa el phone_number_id recibido en la ruta (no el del entorno)', async () => {
    const captured: Captured[] = [];
    const client = createKapsoTransport({
      ...CONFIG,
      fetchImpl: fakeFetch(200, { messages: [{ id: 'wamid.TXT_2' }] }, captured),
    });

    await client.sendText('59170000001', 'Con pnid del evento', { phoneNumberId: 'pnid-evento' });
    expect(captured[0].url).toBe(
      'https://api.kapso.ai/meta/whatsapp/v24.0/pnid-evento/messages',
    );
  });

  it('sin phone_number_id explícito usa el del entorno', async () => {
    const captured: Captured[] = [];
    const client = createKapsoTransport({
      ...CONFIG,
      fetchImpl: fakeFetch(200, { messages: [{ id: 'wamid.TXT_3' }] }, captured),
    });

    await client.sendText('59170000001', 'Sin pnid');
    expect(captured[0].url).toBe('https://api.kapso.ai/meta/whatsapp/v24.0/pnid-1/messages');
  });

  it('normaliza el teléfono y rechaza el vacío sin llamar a fetch', async () => {
    const captured: Captured[] = [];
    const client = createKapsoTransport({
      ...CONFIG,
      fetchImpl: fakeFetch(200, { messages: [{ id: 'wamid.TXT_4' }] }, captured),
    });

    await client.sendText('+591 7000-0001', 'Normaliza');
    expect((captured[0].body as { to: string }).to).toBe('59170000001');

    expect(await client.sendText('', 'x')).toEqual({ ok: false, error: 'invalid_phone' });
    expect(captured).toHaveLength(1); // el segundo no llamó a fetch
  });

  it('texto vacío o de solo espacios -> invalid_text sin llamar a fetch', async () => {
    const captured: Captured[] = [];
    const client = createKapsoTransport({
      ...CONFIG,
      fetchImpl: fakeFetch(200, { messages: [{ id: 'x' }] }, captured),
    });

    expect(await client.sendText('59170000001', '')).toEqual({ ok: false, error: 'invalid_text' });
    expect(await client.sendText('59170000001', '   \n\t ')).toEqual({
      ok: false,
      error: 'invalid_text',
    });
    expect(captured).toHaveLength(0);
  });

  it('propaga los errores tipados: http_error, invalid_response, timeout', async () => {
    const httpError = createKapsoTransport({ ...CONFIG, fetchImpl: fakeFetch(500, {}) });
    expect(await httpError.sendText('59170000001', 'x')).toEqual({
      ok: false,
      error: 'http_error',
      status: 500,
    });

    const badShape = createKapsoTransport({ ...CONFIG, fetchImpl: fakeFetch(200, { messages: [] }) });
    expect(await badShape.sendText('59170000001', 'x')).toEqual({
      ok: false,
      error: 'invalid_response',
    });

    const hangingFetch = ((url: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      })) as typeof fetch;
    const timeoutClient = createKapsoTransport({ ...CONFIG, timeoutMs: 10, fetchImpl: hangingFetch });
    expect(await timeoutClient.sendText('59170000001', 'x')).toEqual({ ok: false, error: 'timeout' });
  });
});

describe('createKapsoTransport.sendLocationRequest — opciones (Fase 5.2D)', () => {
  it('sin opciones conserva el flujo anterior: copy por defecto y pnid del entorno', async () => {
    const captured: Captured[] = [];
    const client = createKapsoTransport({
      ...CONFIG,
      fetchImpl: fakeFetch(200, { messages: [{ id: 'wamid.LOC_D1' }] }, captured),
    });

    const res = await client.sendLocationRequest('59170000001');
    expect(res).toEqual({ ok: true, wamid: 'wamid.LOC_D1' });
    expect(captured[0].url).toBe('https://api.kapso.ai/meta/whatsapp/v24.0/pnid-1/messages');
    expect(captured[0].body).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '59170000001',
      type: 'interactive',
      interactive: {
        type: 'location_request_message',
        body: { text: LOCATION_REQUEST_BODY_TEXT },
        action: { name: 'send_location' },
      },
    });
  });

  it('propaga phoneNumberId a la ruta', async () => {
    const captured: Captured[] = [];
    const client = createKapsoTransport({
      ...CONFIG,
      fetchImpl: fakeFetch(200, { messages: [{ id: 'wamid.LOC_D2' }] }, captured),
    });

    await client.sendLocationRequest('59170000001', { phoneNumberId: 'pnid-evento' });
    expect(captured[0].url).toBe(
      'https://api.kapso.ai/meta/whatsapp/v24.0/pnid-evento/messages',
    );
  });

  it('propaga bodyText personalizado sin alterar type ni action.name', async () => {
    const captured: Captured[] = [];
    const client = createKapsoTransport({
      ...CONFIG,
      fetchImpl: fakeFetch(200, { messages: [{ id: 'wamid.LOC_D3' }] }, captured),
    });

    await client.sendLocationRequest('59170000001', { bodyText: WEB_LOCATION_REQUEST_BODY_TEXT });
    expect(captured[0].body).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '59170000001',
      type: 'interactive',
      interactive: {
        type: 'location_request_message',
        body: { text: WEB_LOCATION_REQUEST_BODY_TEXT },
        action: { name: 'send_location' },
      },
    });
  });

  it('bodyText vacío o de solo espacios -> invalid_body_text sin llamar a fetch', async () => {
    const captured: Captured[] = [];
    const client = createKapsoTransport({
      ...CONFIG,
      fetchImpl: fakeFetch(200, { messages: [{ id: 'x' }] }, captured),
    });

    expect(await client.sendLocationRequest('59170000001', { bodyText: '' })).toEqual({
      ok: false,
      error: 'invalid_body_text',
    });
    expect(await client.sendLocationRequest('59170000001', { bodyText: '   \n\t ' })).toEqual({
      ok: false,
      error: 'invalid_body_text',
    });
    expect(captured).toHaveLength(0);
  });
});

/**
 * Presupuesto de tiempo por envío (Fase 5.2D.5A).
 *
 * Se usan temporizadores falsos para medir el instante EXACTO de aborto sin
 * esperar segundos reales.
 */
describe('createKapsoTransport — timeout por envío', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** fetch que nunca resuelve y rechaza al abortarse. */
  const hangingFetch = ((_url: RequestInfo | URL, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      });
    })) as typeof fetch;

  /** Comprueba que NO aborta antes de `ms` y que SÍ aborta justo en `ms`. */
  async function expectTimeoutAt(ms: number, call: () => Promise<unknown>) {
    vi.useFakeTimers();
    const pending = call();
    let settled = false;
    void pending.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(ms - 1);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ ok: false, error: 'timeout' });
  }

  it('el default del cliente sigue siendo 10 s', async () => {
    const client = createKapsoTransport({ ...CONFIG, fetchImpl: hangingFetch });
    await expectTimeoutAt(10_000, () => client.sendText('59170000001', 'hola'));
  });

  it('el CTA del menú conserva 10 s', async () => {
    const client = createKapsoTransport({ ...CONFIG, fetchImpl: hangingFetch });
    await expectTimeoutAt(10_000, () => client.sendMenuCtaUrl('59170000001'));
  });

  it('la solicitud de ubicación del WhatsApp Flow conserva 10 s', async () => {
    const client = createKapsoTransport({ ...CONFIG, fetchImpl: hangingFetch });
    await expectTimeoutAt(10_000, () => client.sendLocationRequest('59170000001'));
  });

  it('sendText acepta 20 s por envío', async () => {
    const client = createKapsoTransport({ ...CONFIG, fetchImpl: hangingFetch });
    await expectTimeoutAt(20_000, () =>
      client.sendText('59170000001', 'hola', { timeoutMs: 20_000 }),
    );
  });

  it('sendLocationRequest acepta 20 s por envío', async () => {
    const client = createKapsoTransport({ ...CONFIG, fetchImpl: hangingFetch });
    await expectTimeoutAt(20_000, () =>
      client.sendLocationRequest('59170000001', {
        timeoutMs: 20_000,
        bodyText: WEB_LOCATION_REQUEST_BODY_TEXT,
      }),
    );
  });

  it('el timeout por envío no altera al siguiente envío del mismo cliente', async () => {
    const client = createKapsoTransport({ ...CONFIG, fetchImpl: hangingFetch });
    await expectTimeoutAt(20_000, () =>
      client.sendText('59170000001', 'hola', { timeoutMs: 20_000 }),
    );
    // El mismo cliente vuelve a 10 s cuando no se indica nada.
    await expectTimeoutAt(10_000, () => client.sendText('59170000001', 'hola'));
  });

  it('un timeout no filtra URL, teléfono ni API key en el resultado', async () => {
    vi.useFakeTimers();
    const client = createKapsoTransport({ ...CONFIG, fetchImpl: hangingFetch });
    const pending = client.sendText('59170000001', 'hola', { timeoutMs: 20_000 });
    await vi.advanceTimersByTimeAsync(20_000);
    const res = await pending;

    const serialized = JSON.stringify(res);
    expect(serialized).not.toContain('59170000001');
    expect(serialized).not.toContain('test-api-key');
    expect(serialized).not.toContain('api.kapso.ai');
    expect(res).toEqual({ ok: false, error: 'timeout' });
  });
});

describe('createKapsoTransport.sendLocationRequest — validación de bodyText', () => {
  it('bodyText vacío sigue devolviendo invalid_body_text', async () => {
    const captured: Captured[] = [];
    const client = createKapsoTransport({
      ...CONFIG,
      fetchImpl: fakeFetch(200, { messages: [{ id: 'x' }] }, captured),
    });

    expect(await client.sendLocationRequest('59170000001', { bodyText: '' })).toEqual({
      ok: false,
      error: 'invalid_body_text',
    });
    expect(await client.sendLocationRequest('59170000001', { bodyText: '   \n\t ' })).toEqual({
      ok: false,
      error: 'invalid_body_text',
    });
    expect(captured).toHaveLength(0);
  });
});

describe('createKapsoTransport.sendImage (6D.1)', () => {
  it('envía un payload de imagen por enlace con caption y devuelve el wamid', async () => {
    const captured: Captured[] = [];
    const client = createKapsoTransport({
      ...CONFIG,
      fetchImpl: fakeFetch(200, { messages: [{ id: 'wamid.IMG_1' }] }, captured),
    });

    const res = await client.sendImage(
      '59170000001',
      'https://sarco-restaurant.vercel.app/payment/qr-2026.jpeg',
      'Pedido ORD-000042: paga con QR',
    );
    expect(res).toEqual({ ok: true, wamid: 'wamid.IMG_1' });
    expect(captured).toHaveLength(1);
    expect(captured[0].method).toBe('POST');
    expect(captured[0].body).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '59170000001',
      type: 'image',
      image: {
        link: 'https://sarco-restaurant.vercel.app/payment/qr-2026.jpeg',
        caption: 'Pedido ORD-000042: paga con QR',
      },
    });
  });

  it('teléfono inválido → invalid_phone, sin fetch', async () => {
    const captured: Captured[] = [];
    const client = createKapsoTransport({
      ...CONFIG,
      fetchImpl: fakeFetch(200, { messages: [{ id: 'x' }] }, captured),
    });
    expect(await client.sendImage('abc', 'https://x/qr.png', 'cap')).toEqual({
      ok: false,
      error: 'invalid_phone',
    });
    expect(captured).toHaveLength(0);
  });

  it('caption vacío → invalid_image, sin fetch', async () => {
    const captured: Captured[] = [];
    const client = createKapsoTransport({
      ...CONFIG,
      fetchImpl: fakeFetch(200, { messages: [{ id: 'x' }] }, captured),
    });
    expect(await client.sendImage('59170000001', 'https://x/qr.png', '   ')).toEqual({
      ok: false,
      error: 'invalid_image',
    });
    expect(captured).toHaveLength(0);
  });
});
