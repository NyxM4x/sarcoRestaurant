import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  handleKapsoWebhook,
  KAPSO_PAYLOAD_VERSION,
  KAPSO_SUPPORTED_EVENT,
  type AttachOrderLocation,
  type ConfirmOrder,
  type EnsureLocationRequest,
  type QuoteDynamicDelivery,
  type QuoteStandaloneLocation,
  type AttachLooseLocation,
  type ExpandMapsLink,
  type AskLocationForQuote,
  type SendMenuCta,
  type SendMenuCtaInput,
  type WebhookEventStore,
} from './kapso';
import { FakeWebhookEventStore } from './fake-store';
import { MENU_TRIGGER_TEXT } from './menu-trigger';
import type { ConfirmOrderInput, ConfirmOrderResult } from '@/lib/orders/confirm';
import type { EnsureLocationResult } from '@/lib/orders/location';
import type { AttachLocationInput, AttachLocationResult } from '@/lib/orders/attach-location';
import type * as OutboundStore from '@/lib/orders/notifications/outbound-webhook';

const SECRET = 'test-webhook-secret';
const DRAFT_ID = '9f1c8f2e-1a2b-4c3d-8e4f-5a6b7c8d9e0f';
const FLOW_TOKEN = `order_${DRAFT_ID}`;

function sign(rawBody: string): string {
  return createHmac('sha256', SECRET).update(rawBody, 'utf8').digest('hex');
}

const FakeStore = FakeWebhookEventStore;
type FakeStore = FakeWebhookEventStore;

/** Confirmador configurable; captura el último input recibido. */
function fakeConfirmer(result: ConfirmOrderResult | (() => never)) {
  let lastInput: ConfirmOrderInput | undefined;
  const fn: ConfirmOrder = async (inp) => {
    lastInput = inp;
    if (typeof result === 'function') return result();
    return result;
  };
  return { fn, get lastInput() { return lastInput; } };
}

const CONFIRMED_PICKUP: ConfirmOrderResult = {
  result: 'confirmed',
  order: { id: 'ord-uuid', order_number: 'ORD-000001', status: 'confirmed' },
};

// ── Construcción de payloads/headers ──────────────────────────────────────

function messageBody(
  message: unknown,
  conversationPhone = '59170000000',
  phoneNumberId?: string,
) {
  return JSON.stringify({
    message,
    conversation: { phone_number: conversationPhone },
    ...(phoneNumberId === undefined ? {} : { phone_number_id: phoneNumberId }),
  });
}

function nfmKapsoMessage() {
  return {
    id: 'wamid.AAA',
    type: 'interactive',
    from: '59170000000',
    interactive: { type: 'nfm_reply', nfm_reply: { response_json: '{}' } },
    kapso: { flow_response: { order_draft_id: DRAFT_ID, flow_token: FLOW_TOKEN } },
  };
}

function headers(rawBody: string, overrides: Partial<Record<string, string | null>> = {}) {
  return {
    signature: sign(rawBody),
    version: KAPSO_PAYLOAD_VERSION,
    event: KAPSO_SUPPORTED_EVENT,
    idempotencyKey: 'idem-1',
    ...overrides,
  };
}

const NOOP_ENSURE: EnsureLocationRequest = async () => ({ result: 'not_applicable' });
const NOOP_ATTACH: AttachOrderLocation = async () => ({ result: 'not_found' });

/** Envío de CTA que falla el test si se invoca sin querer. */
const NEVER_SEND_CTA: SendMenuCta = async () => {
  throw new Error('sendMenuCta no debía llamarse');
};

function call(
  store: WebhookEventStore,
  confirmOrder: ConfirmOrder,
  rawBody: string,
  hdrs = headers(rawBody),
  ensureLocationRequest: EnsureLocationRequest = NOOP_ENSURE,
  attachOrderLocation: AttachOrderLocation = NOOP_ATTACH,
  sendMenuCta: SendMenuCta = NEVER_SEND_CTA,
) {
  return handleKapsoWebhook({
    rawBody,
    headers: hdrs,
    secret: SECRET,
    store,
    confirmOrder,
    ensureLocationRequest,
    attachOrderLocation,
    sendMenuCta,
  });
}

const NOOP_CONFIRM: ConfirmOrder = async () => CONFIRMED_PICKUP;

const CONFIRMED_DELIVERY: ConfirmOrderResult = {
  result: 'confirmed',
  order: { id: 'ord-uuid', order_number: 'ORD-000002', status: 'awaiting_location' },
};

/** ensureLocationRequest falso que registra las llamadas. */
function fakeEnsure(result: EnsureLocationResult) {
  const calls: string[] = [];
  const fn: EnsureLocationRequest = async (orderId) => {
    calls.push(orderId);
    return result;
  };
  return { fn, calls };
}

const LOCATION_REQUEST_ID = 'wamid.LOCATION_REQUEST_1';

function locationMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: 'wamid.LOC_MSG_1',
    type: 'location',
    from: '59170000001',
    context: { id: LOCATION_REQUEST_ID },
    location: { latitude: -17.7833, longitude: -63.1821, address: 'Av. X 123', name: 'Casa' },
    ...overrides,
  };
}

const ATTACHED_RESULT: AttachLocationResult = {
  result: 'attached',
  order: { id: 'ord-uuid', order_number: 'ORD-000002', status: 'confirmed' },
};

/** attachOrderLocation falso; captura el último input recibido. */
function fakeAttach(result: AttachLocationResult | (() => never)) {
  let lastInput: AttachLocationInput | undefined;
  const fn: AttachOrderLocation = async (inp) => {
    lastInput = inp;
    if (typeof result === 'function') return result();
    return result;
  };
  return { fn, get lastInput() { return lastInput; } };
}

describe('handleKapsoWebhook — seguridad e idempotencia', () => {
  it('rechaza firma inválida (401) sin tocar el store', async () => {
    const raw = messageBody(nfmKapsoMessage());
    const store = new FakeStore();
    const res = await call(store, NOOP_CONFIRM, raw, headers(raw, { signature: 'deadbeef' }));
    expect(res.status).toBe(401);
    expect(store.rows.size).toBe(0);
  });

  it('rechaza firma con prefijo sha256= (V2 es hex directo)', async () => {
    const raw = messageBody(nfmKapsoMessage());
    const store = new FakeStore();
    const res = await call(store, NOOP_CONFIRM, raw, headers(raw, { signature: `sha256=${sign(raw)}` }));
    expect(res.status).toBe(401);
  });

  it('rechaza versión incorrecta (400)', async () => {
    const raw = messageBody(nfmKapsoMessage());
    const store = new FakeStore();
    const res = await call(store, NOOP_CONFIRM, raw, headers(raw, { version: 'v1' }));
    expect(res.status).toBe(400);
  });

  it('exige idempotency key (400)', async () => {
    const raw = messageBody(nfmKapsoMessage());
    const store = new FakeStore();
    const res = await call(store, NOOP_CONFIRM, raw, headers(raw, { idempotencyKey: null }));
    expect(res.status).toBe(400);
    expect(res.outcome).toBe('missing_idempotency_key');
  });

  it('processed -> duplicate (no reprocesa)', async () => {
    const raw = messageBody(nfmKapsoMessage());
    const store = new FakeStore();
    store.seed('idem-1', 'processed');
    const res = await call(store, NOOP_CONFIRM, raw);
    expect(res.body).toEqual({ ok: true, duplicate: true });
    expect(store.markProcessedCalls).toBe(0);
  });

  it('processing -> in_progress', async () => {
    const raw = messageBody(nfmKapsoMessage());
    const store = new FakeStore();
    store.seed('idem-1', 'processing');
    const res = await call(store, NOOP_CONFIRM, raw);
    expect(res.body).toEqual({ ok: true, in_progress: true });
  });

  it('guarda message.id en webhook_events al insertar', async () => {
    const raw = messageBody(nfmKapsoMessage());
    const store = new FakeStore();
    await call(store, NOOP_CONFIRM, raw);
    expect(store.lastInsert?.message_id).toBe('wamid.AAA');
  });
});

describe('handleKapsoWebhook — nfm_reply', () => {
  it('pickup válido: usa kapso.flow_response y responde confirmed/processed', async () => {
    const raw = messageBody(nfmKapsoMessage());
    const store = new FakeStore();
    const confirmer = fakeConfirmer(CONFIRMED_PICKUP);
    const res = await call(store, confirmer.fn, raw);
    expect(res.status).toBe(200);
    expect(res.outcome).toBe('processed');
    expect(res.body).toMatchObject({
      ok: true,
      handled: 'nfm_reply',
      order_number: 'ORD-000001',
      status: 'confirmed',
      result: 'confirmed',
    });
    // Confirmó con los datos de kapso.flow_response.
    expect(confirmer.lastInput).toMatchObject({
      orderDraftId: DRAFT_ID,
      flowToken: FLOW_TOKEN,
      customerPhoneDigits: '59170000000',
      sourceMessageId: 'wamid.AAA',
    });
  });

  it('delivery válido: status awaiting_location', async () => {
    const raw = messageBody(nfmKapsoMessage());
    const store = new FakeStore();
    const confirmer = fakeConfirmer({
      result: 'confirmed',
      order: { id: 'ord', order_number: 'ORD-000002', status: 'awaiting_location' },
    });
    const res = await call(store, confirmer.fn, raw);
    expect(res.body).toMatchObject({ status: 'awaiting_location', result: 'confirmed' });
  });

  it('fallback: usa response_json cuando no hay kapso.flow_response', async () => {
    const message = {
      id: 'wamid.BBB',
      type: 'interactive',
      from: '59170000000',
      interactive: {
        type: 'nfm_reply',
        nfm_reply: { response_json: JSON.stringify({ order_draft_id: DRAFT_ID, flow_token: FLOW_TOKEN }) },
      },
    };
    const raw = messageBody(message);
    const store = new FakeStore();
    const confirmer = fakeConfirmer(CONFIRMED_PICKUP);
    const res = await call(store, confirmer.fn, raw);
    expect(res.outcome).toBe('processed');
    expect(confirmer.lastInput?.orderDraftId).toBe(DRAFT_ID);
  });

  it('response_json inválido: result invalid, processed, sin confirmar', async () => {
    const message = {
      id: 'wamid.CCC',
      type: 'interactive',
      from: '59170000000',
      interactive: { type: 'nfm_reply', nfm_reply: { response_json: '{no-json' } },
    };
    const raw = messageBody(message);
    const store = new FakeStore();
    let confirmCalled = false;
    const res = await call(store, async () => { confirmCalled = true; return CONFIRMED_PICKUP; }, raw);
    expect(res.outcome).toBe('processed');
    expect(res.body).toMatchObject({ ok: false, result: 'invalid' });
    expect(confirmCalled).toBe(false);
  });

  it('mensaje no interactivo: ignorado y processed', async () => {
    const raw = messageBody({ id: 'wamid.T', type: 'text', text: { body: 'hola' } });
    const store = new FakeStore();
    const res = await call(store, NOOP_CONFIRM, raw);
    expect(res.outcome).toBe('processed');
    expect(res.body).toMatchObject({ result: 'ignored' });
  });

  it('interactivo no nfm_reply: ignorado y processed', async () => {
    const raw = messageBody({
      id: 'wamid.T',
      type: 'interactive',
      interactive: { type: 'button_reply' },
    });
    const store = new FakeStore();
    const res = await call(store, NOOP_CONFIRM, raw);
    expect(res.outcome).toBe('processed');
    expect(res.body).toMatchObject({ result: 'ignored' });
  });

  it('confirmación rechazada (not_found): ok:false rejected, processed', async () => {
    const raw = messageBody(nfmKapsoMessage());
    const store = new FakeStore();
    const res = await call(store, async () => ({ result: 'not_found' }), raw);
    expect(res.outcome).toBe('processed');
    expect(res.body).toMatchObject({ ok: false, result: 'rejected', reason: 'not_found' });
  });

  it('respuesta idempotente (already_confirmed): processed', async () => {
    const raw = messageBody(nfmKapsoMessage());
    const store = new FakeStore();
    const res = await call(store, async () => ({
      result: 'already_confirmed',
      order: { id: 'ord', order_number: 'ORD-000001', status: 'confirmed' },
    }), raw);
    expect(res.outcome).toBe('processed');
    expect(res.body).toMatchObject({ result: 'already_confirmed' });
  });

  it('conflicto: processed con result conflict', async () => {
    const raw = messageBody(nfmKapsoMessage());
    const store = new FakeStore();
    const res = await call(store, async () => ({ result: 'conflict', reason: 'source_message_id_conflict' }), raw);
    expect(res.outcome).toBe('processed');
    expect(res.body).toMatchObject({ result: 'conflict' });
  });

  it('error real del confirmador: failed y 500', async () => {
    const raw = messageBody(nfmKapsoMessage());
    const store = new FakeStore();
    const res = await call(store, async () => { throw new Error('db down'); }, raw);
    expect(res.status).toBe(500);
    expect(res.outcome).toBe('failed');
    expect([...store.rows.values()][0].status).toBe('received');
  });

  it('reintenta un evento failed y termina processed', async () => {
    const raw = messageBody(nfmKapsoMessage());
    const store = new FakeStore();
    const id = store.seed('idem-1', 'failed', {
      payload: JSON.parse(raw),
      eventName: KAPSO_SUPPORTED_EVENT,
    });
    const res = await call(store, NOOP_CONFIRM, raw);
    expect(res.outcome).toBe('processed');
    expect(store.rows.get(id)!.status).toBe('processed');
  });

  it('normaliza el teléfono con + y espacios antes de confirmar', async () => {
    const raw = messageBody(nfmKapsoMessage(), '+591 7000-0000');
    const store = new FakeStore();
    const confirmer = fakeConfirmer(CONFIRMED_PICKUP);
    await call(store, confirmer.fn, raw);
    expect(confirmer.lastInput?.customerPhoneDigits).toBe('59170000000');
  });

  it('usa message.from cuando no hay conversation.phone_number', async () => {
    const message = { ...nfmKapsoMessage(), from: '+591 7111 2222' };
    const raw = JSON.stringify({ message }); // sin conversation
    const store = new FakeStore();
    const confirmer = fakeConfirmer(CONFIRMED_PICKUP);
    await call(store, confirmer.fn, raw);
    expect(confirmer.lastInput?.customerPhoneDigits).toBe('59171112222');
  });
});

describe('handleKapsoWebhook — payloads batched (buffering)', () => {
  it('un batch SIN batch_info se rechaza con 422 y sin tocar el store', async () => {
    // Desde 5C.2 los lotes se procesan, pero solo los bien formados: sin
    // `batch_info` no hay diagnóstico posible de qué llegó, y un lote que no
    // entendemos no se degrada a individual — se rechaza para que Kapso lo vea.
    const raw = JSON.stringify({ batch: true, data: [{ message: nfmKapsoMessage() }] });
    const store = new FakeStore();
    let confirmCalled = false;
    const res = await call(store, async () => { confirmCalled = true; return CONFIRMED_PICKUP; }, raw);
    expect(res.status).toBe(422);
    expect(res.outcome).toBe('unsupported_batch');
    expect(res.body).toEqual({
      ok: false,
      error: 'unsupported_batch',
      reason: 'batch_missing_batch_info',
    });
    expect(store.rows.size).toBe(0);
    expect(confirmCalled).toBe(false);
  });

  it('un batch BIEN FORMADO sí se procesa: el nfm_reply conserva su ruta', async () => {
    const raw = JSON.stringify({
      type: 'whatsapp.message.received',
      batch: true,
      data: [
        {
          message: nfmKapsoMessage(),
          conversation: { phone_number: '59170000000' },
          phone_number_id: 'pn-1',
        },
      ],
      batch_info: {
        size: 1,
        window_ms: 5000,
        first_sequence: 1,
        last_sequence: 1,
        conversation_id: 'conv-1',
      },
    });
    const store = new FakeStore();
    const confirmer = fakeConfirmer(CONFIRMED_PICKUP);

    const res = await call(store, confirmer.fn, raw);

    expect(res.status).toBe(200);
    expect(res.outcome).toBe('processed');
    // Un elemento determinístico dentro de un lote sigue yendo por su ruta.
    expect(confirmer.lastInput?.orderDraftId).toBe(DRAFT_ID);
    expect(res.body).toMatchObject({ handled: 'batch', batch_size: 1, anchor_index: null });
  });

  it('un array en payload.data (sin batch:true) no se interpreta como evento individual', async () => {
    // Forma antigua/buffered: el message solo estaría bajo data[]. No se lee.
    const raw = JSON.stringify({ data: [{ message: nfmKapsoMessage() }] });
    const store = new FakeStore();
    let confirmCalled = false;
    const res = await call(store, async () => { confirmCalled = true; return CONFIRMED_PICKUP; }, raw);
    // No es batch (falta batch:true) ni evento individual válido: se ignora, no confirma.
    expect(res.outcome).toBe('processed');
    expect(res.body).toMatchObject({ result: 'ignored' });
    expect(confirmCalled).toBe(false);
  });
});

describe('handleKapsoWebhook — solicitud de ubicación (3.3A)', () => {
  it('pickup confirmado NO llama a ensureLocationRequest', async () => {
    const raw = messageBody(nfmKapsoMessage());
    const store = new FakeStore();
    const ensure = fakeEnsure({ result: 'requested' });
    const res = await call(store, async () => CONFIRMED_PICKUP, raw, headers(raw), ensure.fn);
    expect(res.body).toMatchObject({ status: 'confirmed', result: 'confirmed' });
    expect(ensure.calls).toHaveLength(0);
  });

  it('delivery confirmado llama una vez y responde location_requested', async () => {
    const raw = messageBody(nfmKapsoMessage());
    const store = new FakeStore();
    const ensure = fakeEnsure({ result: 'requested' });
    const res = await call(store, async () => CONFIRMED_DELIVERY, raw, headers(raw), ensure.fn);
    expect(res.status).toBe(200);
    expect(res.outcome).toBe('processed');
    expect(res.body).toMatchObject({
      ok: true,
      handled: 'nfm_reply',
      order_id: 'ord-uuid',
      order_number: 'ORD-000002',
      status: 'awaiting_location',
      result: 'location_requested',
    });
    expect(ensure.calls).toEqual(['ord-uuid']);
  });

  it('already_confirmed con wamid ya guardado: no reenvía y responde already_confirmed', async () => {
    const raw = messageBody(nfmKapsoMessage());
    const store = new FakeStore();
    const ensure = fakeEnsure({ result: 'already_requested' });
    const res = await call(
      store,
      async () => ({
        result: 'already_confirmed',
        order: { id: 'ord-uuid', order_number: 'ORD-000002', status: 'awaiting_location' },
      }),
      raw,
      headers(raw),
      ensure.fn,
    );
    expect(res.outcome).toBe('processed');
    expect(res.body).toMatchObject({ status: 'awaiting_location', result: 'already_confirmed' });
    expect(ensure.calls).toEqual(['ord-uuid']); // consulta idempotente, sin envío real
  });

  it('already_confirmed SIN wamid (reintento): vuelve a intentar y responde location_requested', async () => {
    const raw = messageBody(nfmKapsoMessage());
    const store = new FakeStore();
    const ensure = fakeEnsure({ result: 'requested' });
    const res = await call(
      store,
      async () => ({
        result: 'already_confirmed',
        order: { id: 'ord-uuid', order_number: 'ORD-000002', status: 'awaiting_location' },
      }),
      raw,
      headers(raw),
      ensure.fn,
    );
    expect(res.outcome).toBe('processed');
    expect(res.body).toMatchObject({ status: 'awaiting_location', result: 'location_requested' });
    expect(ensure.calls).toEqual(['ord-uuid']);
  });

  it('fallo de envío: evento failed y 500 (pedido queda awaiting_location)', async () => {
    const raw = messageBody(nfmKapsoMessage());
    const store = new FakeStore();
    const ensure = fakeEnsure({ result: 'send_failed', error: 'timeout' });
    const res = await call(store, async () => CONFIRMED_DELIVERY, raw, headers(raw), ensure.fn);
    expect(res.status).toBe(500);
    expect(res.outcome).toBe('failed');
    const row = [...store.rows.values()][0];
    expect(row.status).toBe('received');
    expect(row.error).toContain('location_request_failed:timeout');
  });

  it('reintento de evento failed vuelve a intentar el envío', async () => {
    const raw = messageBody(nfmKapsoMessage());
    const store = new FakeStore();
    const id = store.seed('idem-1', 'failed', {
      payload: JSON.parse(raw),
      eventName: KAPSO_SUPPORTED_EVENT,
    });
    const ensure = fakeEnsure({ result: 'requested' });
    const res = await call(
      store,
      async () => ({
        result: 'already_confirmed',
        order: { id: 'ord-uuid', order_number: 'ORD-000002', status: 'awaiting_location' },
      }),
      raw,
      headers(raw),
      ensure.fn,
    );
    expect(res.outcome).toBe('processed');
    expect(store.rows.get(id)!.status).toBe('processed');
    expect(ensure.calls).toEqual(['ord-uuid']);
    expect(res.body).toMatchObject({ result: 'location_requested' });
  });
});

describe('handleKapsoWebhook — mensaje entrante location (3.3B)', () => {
  it('ubicación válida correlacionada por context.id: processed, attached', async () => {
    const raw = messageBody(locationMessage());
    const store = new FakeStore();
    const attach = fakeAttach(ATTACHED_RESULT);
    const res = await call(store, NOOP_CONFIRM, raw, headers(raw), NOOP_ENSURE, attach.fn);
    expect(res.status).toBe(200);
    expect(res.outcome).toBe('processed');
    expect(res.body).toEqual({
      ok: true,
      handled: 'location',
      order_id: 'ord-uuid',
      order_number: 'ORD-000002',
      status: 'confirmed',
      result: 'attached',
    });
    expect(attach.lastInput).toMatchObject({
      contextId: LOCATION_REQUEST_ID,
      customerPhoneDigits: '59170000000', // conversation.phone_number (default de messageBody)
      latitude: -17.7833,
      longitude: -63.1821,
      address: 'Av. X 123',
      name: 'Casa',
    });
  });

  it('teléfono desde conversation.phone_number', async () => {
    const raw = messageBody(locationMessage(), '59171234567');
    const store = new FakeStore();
    const attach = fakeAttach(ATTACHED_RESULT);
    await call(store, NOOP_CONFIRM, raw, headers(raw), NOOP_ENSURE, attach.fn);
    expect(attach.lastInput?.customerPhoneDigits).toBe('59171234567');
  });

  it('fallback a message.from cuando no hay conversation.phone_number', async () => {
    const message = locationMessage({ from: '59179998877' });
    const raw = JSON.stringify({ message }); // sin conversation
    const store = new FakeStore();
    const attach = fakeAttach(ATTACHED_RESULT);
    await call(store, NOOP_CONFIRM, raw, headers(raw), NOOP_ENSURE, attach.fn);
    expect(attach.lastInput?.customerPhoneDigits).toBe('59179998877');
  });

  it('normaliza teléfono con +, espacios y guiones', async () => {
    const raw = messageBody(locationMessage(), '+591 7000-0001');
    const store = new FakeStore();
    const attach = fakeAttach(ATTACHED_RESULT);
    await call(store, NOOP_CONFIRM, raw, headers(raw), NOOP_ENSURE, attach.fn);
    expect(attach.lastInput?.customerPhoneDigits).toBe('59170000001');
  });

  it('latitude inválida: invalid, processed, sin llamar a attachOrderLocation', async () => {
    const raw = messageBody(locationMessage({ location: { latitude: 91, longitude: 0 } }));
    const store = new FakeStore();
    const attach = fakeAttach(ATTACHED_RESULT);
    const res = await call(store, NOOP_CONFIRM, raw, headers(raw), NOOP_ENSURE, attach.fn);
    expect(res.outcome).toBe('processed');
    expect(res.body).toMatchObject({ ok: false, handled: 'location', result: 'invalid' });
    expect(attach.lastInput).toBeUndefined();
  });

  it('longitude inválida: invalid, processed, sin llamar a attachOrderLocation', async () => {
    const raw = messageBody(locationMessage({ location: { latitude: 0, longitude: 181 } }));
    const store = new FakeStore();
    const attach = fakeAttach(ATTACHED_RESULT);
    const res = await call(store, NOOP_CONFIRM, raw, headers(raw), NOOP_ENSURE, attach.fn);
    expect(res.outcome).toBe('processed');
    expect(res.body).toMatchObject({ result: 'invalid' });
    expect(attach.lastInput).toBeUndefined();
  });

  it('context.id ausente: invalid, processed, sin llamar a attachOrderLocation', async () => {
    const raw = messageBody(locationMessage({ context: {} }));
    const store = new FakeStore();
    const attach = fakeAttach(ATTACHED_RESULT);
    const res = await call(store, NOOP_CONFIRM, raw, headers(raw), NOOP_ENSURE, attach.fn);
    expect(res.outcome).toBe('processed');
    expect(res.body).toMatchObject({ result: 'invalid' });
    expect(attach.lastInput).toBeUndefined();
  });

  it('pedido no encontrado (not_found): rejected, processed', async () => {
    const raw = messageBody(locationMessage());
    const store = new FakeStore();
    const attach = fakeAttach({ result: 'not_found' });
    const res = await call(store, NOOP_CONFIRM, raw, headers(raw), NOOP_ENSURE, attach.fn);
    expect(res.outcome).toBe('processed');
    expect(res.body).toMatchObject({ ok: false, handled: 'location', result: 'rejected', reason: 'not_found' });
  });

  it('phone_mismatch: rejected, processed', async () => {
    const raw = messageBody(locationMessage());
    const store = new FakeStore();
    const attach = fakeAttach({ result: 'phone_mismatch' });
    const res = await call(store, NOOP_CONFIRM, raw, headers(raw), NOOP_ENSURE, attach.fn);
    expect(res.outcome).toBe('processed');
    expect(res.body).toMatchObject({ result: 'rejected', reason: 'phone_mismatch' });
  });

  it('status distinto de awaiting_location (invalid_status): rejected, processed', async () => {
    const raw = messageBody(locationMessage());
    const store = new FakeStore();
    const attach = fakeAttach({ result: 'invalid_status' });
    const res = await call(store, NOOP_CONFIRM, raw, headers(raw), NOOP_ENSURE, attach.fn);
    expect(res.outcome).toBe('processed');
    expect(res.body).toMatchObject({ result: 'rejected', reason: 'invalid_status' });
  });

  it('ubicación ya guardada (already_attached): processed, mismo resultado', async () => {
    const raw = messageBody(locationMessage());
    const store = new FakeStore();
    const attach = fakeAttach({
      result: 'already_attached',
      order: { id: 'ord-uuid', order_number: 'ORD-000002', status: 'confirmed' },
    });
    const res = await call(store, NOOP_CONFIRM, raw, headers(raw), NOOP_ENSURE, attach.fn);
    expect(res.outcome).toBe('processed');
    expect(res.body).toMatchObject({ status: 'confirmed', result: 'already_attached' });
  });

  it('segunda ubicación con coordenadas diferentes (location_conflict): processed, conflict', async () => {
    const raw = messageBody(locationMessage());
    const store = new FakeStore();
    const attach = fakeAttach({ result: 'location_conflict' });
    const res = await call(store, NOOP_CONFIRM, raw, headers(raw), NOOP_ENSURE, attach.fn);
    expect(res.outcome).toBe('processed');
    expect(res.body).toEqual({ ok: true, handled: 'location', result: 'conflict' });
  });

  it('concurrent_update: fallo transitorio -> marca el evento failed y responde 500', async () => {
    const raw = messageBody(locationMessage());
    const store = new FakeStore();
    const attach = fakeAttach({ result: 'concurrent_update' });
    const res = await call(store, NOOP_CONFIRM, raw, headers(raw), NOOP_ENSURE, attach.fn);
    expect(res.status).toBe(500);
    expect(res.outcome).toBe('failed');
    const row = [...store.rows.values()][0];
    expect(row.status).toBe('received');
    expect(row.error).toContain('location_attach_failed:concurrent_update');
    // El payload del evento no se modifica ni se borra.
    expect(row.payload).toEqual(JSON.parse(raw));
  });

  it('concurrent_update no filtra coordenadas ni datos sensibles en el error registrado', async () => {
    const raw = messageBody(locationMessage());
    const store = new FakeStore();
    const attach = fakeAttach({ result: 'concurrent_update' });
    await call(store, NOOP_CONFIRM, raw, headers(raw), NOOP_ENSURE, attach.fn);
    const row = [...store.rows.values()][0];
    expect(row.error).not.toMatch(/-?\d+\.\d+/); // sin latitud/longitud
    expect(row.error).not.toContain('59170000000'); // sin teléfono
  });

  it('reintento tras concurrent_update: el evento failed puede reclamarse de nuevo', async () => {
    const raw = messageBody(locationMessage());
    const store = new FakeStore();
    const id = store.seed('idem-1', 'failed', {
      payload: JSON.parse(raw),
      eventName: KAPSO_SUPPORTED_EVENT,
    });
    // El reintento vuelve a chocar con la carrera: sigue failed (reintentable de nuevo).
    const attach = fakeAttach({ result: 'concurrent_update' });
    const res = await call(store, NOOP_CONFIRM, raw, headers(raw), NOOP_ENSURE, attach.fn);
    expect(res.status).toBe(500);
    expect(res.outcome).toBe('failed');
    expect(store.rows.get(id)!.status).toBe('received');
    expect(store.rows.size).toBe(1); // no se duplicó el evento
  });

  it('reintento tras concurrent_update: si la ubicación queda guardada, termina processed', async () => {
    const raw = messageBody(locationMessage());
    const store = new FakeStore();
    const id = store.seed('idem-1', 'failed', {
      payload: JSON.parse(raw),
      eventName: KAPSO_SUPPORTED_EVENT,
    });
    const attach = fakeAttach(ATTACHED_RESULT); // esta vez logra adjuntar
    const res = await call(store, NOOP_CONFIRM, raw, headers(raw), NOOP_ENSURE, attach.fn);
    expect(res.status).toBe(200);
    expect(res.outcome).toBe('processed');
    expect(store.rows.get(id)!.status).toBe('processed');
    expect(res.body).toMatchObject({ handled: 'location', result: 'attached' });
  });

  it('misma X-Idempotency-Key repetida: duplicate, sin llamar a attachOrderLocation', async () => {
    const raw = messageBody(locationMessage());
    const store = new FakeStore();
    store.seed('idem-1', 'processed');
    const attach = fakeAttach(ATTACHED_RESULT);
    const res = await call(store, NOOP_CONFIRM, raw, headers(raw), NOOP_ENSURE, attach.fn);
    expect(res.body).toEqual({ ok: true, duplicate: true });
    expect(attach.lastInput).toBeUndefined();
  });

  it('nueva X-Idempotency-Key para una ubicación ya adjuntada: llama de nuevo y responde already_attached', async () => {
    const raw = messageBody(locationMessage());
    const store = new FakeStore();
    const attach = fakeAttach({
      result: 'already_attached',
      order: { id: 'ord-uuid', order_number: 'ORD-000002', status: 'confirmed' },
    });
    const res = await call(
      store,
      NOOP_CONFIRM,
      raw,
      headers(raw, { idempotencyKey: 'idem-nueva' }),
      NOOP_ENSURE,
      attach.fn,
    );
    expect(res.outcome).toBe('processed');
    expect(res.body).toMatchObject({ result: 'already_attached' });
    expect(attach.lastInput).toBeDefined();
  });

  it('error real de infraestructura: failed y 500', async () => {
    const raw = messageBody(locationMessage());
    const store = new FakeStore();
    const attach = fakeAttach(() => { throw new Error('db down'); });
    const res = await call(store, NOOP_CONFIRM, raw, headers(raw), NOOP_ENSURE, attach.fn);
    expect(res.status).toBe(500);
    expect(res.outcome).toBe('failed');
    expect([...store.rows.values()][0].status).toBe('received');
  });

  it('guarda message.id (de la ubicación) en webhook_events', async () => {
    const raw = messageBody(locationMessage());
    const store = new FakeStore();
    const attach = fakeAttach(ATTACHED_RESULT);
    await call(store, NOOP_CONFIRM, raw, headers(raw), NOOP_ENSURE, attach.fn);
    expect(store.lastInsert?.message_id).toBe('wamid.LOC_MSG_1');
  });
});

// ── Fase 5.2A — CTA "Ver menú" ────────────────────────────────────────────

const CUSTOMER_PHONE = '59171112222';

function textMessage(body: string, overrides: Record<string, unknown> = {}) {
  return {
    id: 'wamid.TEXT_1',
    type: 'text',
    from: CUSTOMER_PHONE,
    text: { body },
    ...overrides,
  };
}

/** sendMenuCta falso: captura las llamadas y devuelve el resultado indicado. */
function fakeSendCta(
  result: Awaited<ReturnType<SendMenuCta>> = { result: 'sent', deliveryId: 'del-cta', wamid: 'wamid.CTA' },
) {
  const calls: SendMenuCtaInput[] = [];
  const fn: SendMenuCta = async (input) => {
    calls.push(input);
    return result;
  };
  return { fn, calls };
}

/** Llamada con la palabra clave; el body incluye phone_number_id del evento. */
function callTrigger(
  store: WebhookEventStore,
  sender: { fn: SendMenuCta },
  body = MENU_TRIGGER_TEXT,
  options: { idempotencyKey?: string; phoneNumberId?: string } = {},
) {
  const raw = messageBody(textMessage(body), '59170000000', options.phoneNumberId ?? 'pnid-evento');
  const hdrs = headers(
    raw,
    options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {},
  );
  return call(store, NOOP_CONFIRM, raw, hdrs, NOOP_ENSURE, NOOP_ATTACH, sender.fn);
}

describe('handleKapsoWebhook — CTA "Ver menú" (Fase 5.2A)', () => {
  it('el texto exacto envía el CTA y responde 200', async () => {
    const store = new FakeStore();
    const sender = fakeSendCta();

    const res = await callTrigger(store, sender);

    expect(res.status).toBe(200);
    expect(res.outcome).toBe('processed');
    expect(res.body).toEqual({ ok: true, handled: 'menu_cta', result: 'sent' });
    expect(sender.calls).toHaveLength(1);
  });

  it('acepta espacios externos y distintas mayúsculas', async () => {
    for (const variant of ['  TESTMENU9842  ', 'testmenu9842', 'TestMenu9842']) {
      const store = new FakeStore();
      const sender = fakeSendCta();
      const res = await callTrigger(store, sender, variant);
      expect(res.body, variant).toMatchObject({ handled: 'menu_cta', result: 'sent' });
      expect(sender.calls, variant).toHaveLength(1);
    }
  });

  it('usa el teléfono del remitente como destinatario', async () => {
    const store = new FakeStore();
    const sender = fakeSendCta();
    await callTrigger(store, sender);
    expect(sender.calls[0].toDigits).toBe(CUSTOMER_PHONE);
  });

  it('el motivo lo decide el webhook: QA y petición real se distinguen (6D.2F.5A)', async () => {
    // El `reason` no viaja nunca desde fuera: se deduce de QUÉ detector
    // disparó. Es lo que permite que el cooldown se aplique solo donde debe.
    const qa = fakeSendCta();
    await callTrigger(new FakeStore(), qa, MENU_TRIGGER_TEXT);
    expect(qa.calls[0].reason).toBe('qa_trigger');

    const cliente = fakeSendCta();
    await callTrigger(new FakeStore(), cliente, 'menu');
    expect(cliente.calls[0].reason).toBe('explicit_request');
  });

  it('usa el phone_number_id del evento entrante', async () => {
    const store = new FakeStore();
    const sender = fakeSendCta();
    await callTrigger(store, sender, MENU_TRIGGER_TEXT, { phoneNumberId: 'pnid-del-evento' });
    expect(sender.calls[0].phoneNumberId).toBe('pnid-del-evento');
  });

  it('sin phone_number_id en el payload deja que decida el cliente (null)', async () => {
    const store = new FakeStore();
    const sender = fakeSendCta();
    const raw = messageBody(textMessage(MENU_TRIGGER_TEXT));
    await call(store, NOOP_CONFIRM, raw, headers(raw), NOOP_ENSURE, NOOP_ATTACH, sender.fn);
    expect(sender.calls[0].phoneNumberId).toBeNull();
  });

  it('un texto distinto NO envía el CTA', async () => {
    const store = new FakeStore();
    const sender = fakeSendCta();
    const res = await callTrigger(store, sender, 'hola');
    expect(sender.calls).toHaveLength(0);
    expect(res.body).toEqual({ ok: true, handled: 'ignored', result: 'ignored' });
    expect(res.outcome).toBe('processed');
  });

  it('6D.2E: una intención natural del cliente envía el CTA', async () => {
    for (const variant of ['quiero pedir', 'menú', 'ver productos', 'quiero hacer un pedido', 'qué tienen']) {
      const store = new FakeStore();
      const sender = fakeSendCta();
      const res = await callTrigger(store, sender, variant);
      expect(res.body, variant).toMatchObject({ handled: 'menu_cta', result: 'sent' });
      expect(sender.calls, variant).toHaveLength(1);
    }
  });

  it('6D.2E: una negación NO envía el CTA (sigue el flujo anterior)', async () => {
    for (const variant of ['no quiero pedir', 'ya no quiero pedir']) {
      const store = new FakeStore();
      const sender = fakeSendCta();
      const res = await callTrigger(store, sender, variant);
      expect(sender.calls, variant).toHaveLength(0);
      expect(res.body, variant).toEqual({ ok: true, handled: 'ignored', result: 'ignored' });
    }
  });

  it('la palabra junto a otro texto NO envía el CTA', async () => {
    for (const variant of ['hola TESTMENU9842', 'TESTMENU9842 hola']) {
      const store = new FakeStore();
      const sender = fakeSendCta();
      const res = await callTrigger(store, sender, variant);
      expect(sender.calls, variant).toHaveLength(0);
      expect(res.body, variant).toEqual({ ok: true, handled: 'ignored', result: 'ignored' });
    }
  });

  it('un evento duplicado no envía el CTA dos veces', async () => {
    const store = new FakeStore();
    const sender = fakeSendCta();

    const first = await callTrigger(store, sender);
    const second = await callTrigger(store, sender);

    expect(first.body).toMatchObject({ result: 'sent' });
    expect(second.body).toEqual({ ok: true, duplicate: true });
    expect(sender.calls).toHaveLength(1);
  });

  it('un evento nuevo (otra idempotency key) sí vuelve a enviarlo', async () => {
    const store = new FakeStore();
    const sender = fakeSendCta();
    await callTrigger(store, sender, MENU_TRIGGER_TEXT, { idempotencyKey: 'idem-A' });
    await callTrigger(store, sender, MENU_TRIGGER_TEXT, { idempotencyKey: 'idem-B' });
    expect(sender.calls).toHaveLength(2);
  });

  it('si Kapso falla: evento failed, 500 y reintentable', async () => {
    const store = new FakeStore();
    const sender = fakeSendCta({ result: 'send_unknown', deliveryId: 'del-cta', error: 'send.http_error' });

    const res = await callTrigger(store, sender);

    expect(res.status).toBe(500);
    expect(res.outcome).toBe('failed');
    const row = [...store.rows.values()][0];
    expect(row.status).toBe('received');
    // El motivo no filtra teléfono, API key ni URL. Desde 6D.2F.5A el código
    // viene del despacho y conserva su prefijo `send.`, igual que en
    // `agent_runs.error_code`.
    expect(row.error).toBe('menu_cta_send_failed:send.http_error');
    expect(row.error).not.toContain(CUSTOMER_PHONE);

    // Reintento con la misma key: el claim de `webhook_events` permite
    // reprocesar el evento. Si vuelve a enviarse o no ya no lo decide el
    // webhook sino el ledger del despacho — en producción encontraría el claim
    // y respondería `duplicate` (ver menu/dispatch.test.ts).
    const retrySender = fakeSendCta();
    const retry = await callTrigger(store, retrySender);
    expect(retry.status).toBe(200);
    expect(retrySender.calls).toHaveLength(1);
  });

  it('sin teléfono del remitente es rechazo determinista (200, sin reintento)', async () => {
    const store = new FakeStore();
    const sender = fakeSendCta();
    const raw = messageBody(
      { id: 'wamid.NOPHONE', type: 'text', text: { body: MENU_TRIGGER_TEXT } },
      '',
      'pnid-evento',
    );
    const res = await call(
      store,
      NOOP_CONFIRM,
      raw,
      headers(raw),
      NOOP_ENSURE,
      NOOP_ATTACH,
      sender.fn,
    );

    expect(res.status).toBe(200);
    expect(res.outcome).toBe('processed');
    expect(res.body).toMatchObject({ handled: 'menu_cta', result: 'invalid' });
    expect(sender.calls).toHaveLength(0);
  });

  it('no crea pedidos, no confirma ni pide ubicación', async () => {
    const store = new FakeStore();
    const sender = fakeSendCta();
    const confirmer = fakeConfirmer(CONFIRMED_PICKUP);
    const ensure = fakeEnsure({ result: 'requested' });

    const raw = messageBody(textMessage(MENU_TRIGGER_TEXT), '59170000000', 'pnid-evento');
    await call(store, confirmer.fn, raw, headers(raw), ensure.fn, NOOP_ATTACH, sender.fn);

    expect(confirmer.lastInput).toBeUndefined();
    expect(ensure.calls).toHaveLength(0);
  });

  it('otros tipos de mensaje con la palabra no disparan el CTA', async () => {
    const store = new FakeStore();
    const sender = fakeSendCta();
    const raw = messageBody(
      {
        id: 'wamid.IMG',
        type: 'image',
        from: CUSTOMER_PHONE,
        image: { caption: MENU_TRIGGER_TEXT },
      },
      '59170000000',
      'pnid-evento',
    );
    const res = await call(
      store,
      NOOP_CONFIRM,
      raw,
      headers(raw),
      NOOP_ENSURE,
      NOOP_ATTACH,
      sender.fn,
    );
    expect(sender.calls).toHaveLength(0);
    expect(res.body).toEqual({ ok: true, handled: 'ignored', result: 'ignored' });
  });

  it('un nfm_reply sigue confirmando el pedido (no lo intercepta el CTA)', async () => {
    const store = new FakeStore();
    const sender = fakeSendCta();
    const confirmer = fakeConfirmer(CONFIRMED_PICKUP);
    const raw = messageBody(nfmKapsoMessage());

    const res = await call(
      store,
      confirmer.fn,
      raw,
      headers(raw),
      NOOP_ENSURE,
      NOOP_ATTACH,
      sender.fn,
    );

    expect(sender.calls).toHaveLength(0);
    expect(res.body).toMatchObject({ handled: 'nfm_reply', result: 'confirmed' });
    expect(confirmer.lastInput?.orderDraftId).toBe(DRAFT_ID);
  });

  it('una ubicación entrante sigue asociándose (no la intercepta el CTA)', async () => {
    const store = new FakeStore();
    const sender = fakeSendCta();
    const attach = fakeAttach(ATTACHED_RESULT);
    const raw = messageBody(locationMessage());

    const res = await call(
      store,
      NOOP_CONFIRM,
      raw,
      headers(raw),
      NOOP_ENSURE,
      attach.fn,
      sender.fn,
    );

    expect(sender.calls).toHaveLength(0);
    expect(res.body).toMatchObject({ handled: 'location', result: 'attached' });
  });
});

// ── Eventos salientes (Fase 5.2D.5C) ───────────────────────────────────────

describe('handleKapsoWebhook — reconciliación outbound', () => {
  const OUT_ORDER = 'ord-out-1';
  const OUT_RECIPIENT = '59170000000';

  interface OutCalls {
    resolveOrder: string[];
    markSent: Array<{ orderId: string; type: string; wamid: string }>;
    loadStates: string[];
    markTerminal: number;
  }

  function fakeOutbound(opts: {
    order?: OutboundStore.ResolvedOrder | null;
    sentResult?: OutboundStore.WebhookSentResult;
  } = {}): { store: OutboundStore.OutboundReconciliationStore; calls: OutCalls } {
    const calls: OutCalls = { resolveOrder: [], markSent: [], loadStates: [], markTerminal: 0 };
    const order =
      opts.order === undefined
        ? { id: OUT_ORDER, customerPhoneDigits: OUT_RECIPIENT }
        : opts.order;
    const store: OutboundStore.OutboundReconciliationStore = {
      async resolveOrder(orderNumber) {
        calls.resolveOrder.push(orderNumber);
        return order;
      },
      async markSentByWebhook(orderId, type, wamid) {
        calls.markSent.push({ orderId, type, wamid });
        return opts.sentResult ?? 'sent';
      },
      async loadStates(orderId) {
        calls.loadStates.push(orderId);
        return { rows: [], unknownStateCount: 0 };
      },
      async markTerminalByType() {
        calls.markTerminal += 1;
        return true;
      },
    };
    return { store, calls };
  }

  function outboundBody(overrides: Record<string, unknown> = {}) {
    return JSON.stringify({
      message: {
        id: 'wamid.OUT1',
        type: 'text',
        to: OUT_RECIPIENT,
        text: { body: '📦 ¡Recibí tu pedido ORD-000009!' },
        timestamp: '2026-07-22T18:00:30.000Z',
        ...overrides,
      },
      phone_number_id: 'pnid-1',
    });
  }

  function callOutbound(
    store: WebhookEventStore,
    outbound: OutboundStore.OutboundReconciliationStore,
    rawBody: string,
    hdrs = headers(rawBody, { event: 'whatsapp.message.sent' }),
  ) {
    return handleKapsoWebhook({
      rawBody,
      headers: hdrs,
      secret: SECRET,
      store,
      confirmOrder: NOOP_CONFIRM,
      ensureLocationRequest: NOOP_ENSURE,
      attachOrderLocation: NOOP_ATTACH,
      sendMenuCta: NEVER_SEND_CTA,
      outbound,
    });
  }

  it('procesa whatsapp.message.sent y marca la notificación enviada', async () => {
    const raw = outboundBody();
    const store = new FakeStore();
    const { store: outbound, calls } = fakeOutbound({ sentResult: 'sent' });
    const res = await callOutbound(store, outbound, raw);

    expect(res.status).toBe(200);
    expect(res.outcome).toBe('processed');
    expect(res.body).toMatchObject({ handled: 'outbound', outcome: 'sent' });
    expect(calls.markSent).toEqual([
      { orderId: OUT_ORDER, type: 'confirmation', wamid: 'wamid.OUT1' },
    ]);
  });

  it('rechaza firma HMAC inválida sin tocar el store ni la reconciliación', async () => {
    const raw = outboundBody();
    const store = new FakeStore();
    const { store: outbound, calls } = fakeOutbound({});
    const res = await callOutbound(store, outbound, raw, headers(raw, {
      event: 'whatsapp.message.sent',
      signature: 'deadbeef',
    }));
    expect(res.status).toBe(401);
    expect(store.rows.size).toBe(0);
    expect(calls.markSent).toEqual([]);
  });

  it('el mismo evento sent dos veces no duplica efectos (idempotencia webhook_events)', async () => {
    const raw = outboundBody();
    const store = new FakeStore();
    const { store: outbound, calls } = fakeOutbound({ sentResult: 'sent' });
    const hdrs = headers(raw, { event: 'whatsapp.message.sent', idempotencyKey: 'out-1' });

    const first = await callOutbound(store, outbound, raw, hdrs);
    const second = await callOutbound(store, outbound, raw, hdrs);

    expect(first.outcome).toBe('processed');
    expect(second.outcome).toBe('duplicate');
    expect(calls.markSent).toHaveLength(1); // solo una vez
  });

  it('sent seguido de delivered (mismo wamid, claves distintas) no reenvía', async () => {
    const raw = outboundBody();
    const store = new FakeStore();
    const { store: outbound, calls } = fakeOutbound({ sentResult: 'already_sent' });

    await callOutbound(store, outbound, raw, headers(raw, {
      event: 'whatsapp.message.sent',
      idempotencyKey: 'out-sent',
    }));
    await callOutbound(store, outbound, raw, headers(raw, {
      event: 'whatsapp.message.delivered',
      idempotencyKey: 'out-delivered',
    }));

    // Dos llamadas a la RPC idempotente; ninguna envía.
    expect(calls.markSent).toHaveLength(2);
    for (const c of calls.markSent) expect(c.wamid).toBe('wamid.OUT1');
  });

  it('un cuerpo malformado (sin id) se procesa e ignora, sin reconciliar', async () => {
    const raw = JSON.stringify({ message: { type: 'text' }, phone_number_id: 'pnid-1' });
    const store = new FakeStore();
    const { store: outbound, calls } = fakeOutbound({});
    const res = await callOutbound(store, outbound, raw);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ handled: 'outbound', outcome: 'ignored' });
    expect(calls.markSent).toEqual([]);
  });

  it('sin store outbound inyectado, los salientes se ignoran (comportamiento previo)', async () => {
    const raw = outboundBody();
    const store = new FakeStore();
    const res = await call(store, NOOP_CONFIRM, raw, headers(raw, { event: 'whatsapp.message.sent' }));
    expect(res.outcome).toBe('ignored');
    expect(res.body).toMatchObject({ ignored: true });
  });

  it('un order_number desconocido no marca nada', async () => {
    const raw = outboundBody();
    const store = new FakeStore();
    const { store: outbound, calls } = fakeOutbound({ order: null });
    const res = await callOutbound(store, outbound, raw);
    expect(res.body).toMatchObject({ outcome: 'ignored', reason: 'order_not_found' });
    expect(calls.markSent).toEqual([]);
  });

  it('whatsapp.message.failed nunca envía', async () => {
    const raw = outboundBody();
    const store = new FakeStore();
    const { store: outbound, calls } = fakeOutbound({});
    await callOutbound(store, outbound, raw, headers(raw, { event: 'whatsapp.message.failed' }));
    expect(calls.markSent).toEqual([]);
  });
});

// ── 6D.2C: disparo de la cotización dinámica tras adjuntar la ubicación ───────

describe('handleKapsoWebhook — cotización dinámica (6D.2C)', () => {
  /** Resultado de attach que deja el pedido esperando (delivery dinámico). */
  const ATTACHED_AWAITING: AttachLocationResult = {
    result: 'attached',
    order: { id: 'ord-uuid', order_number: 'ORD-000002', status: 'awaiting_location' },
  };
  const ALREADY_AWAITING: AttachLocationResult = {
    result: 'already_attached',
    order: { id: 'ord-uuid', order_number: 'ORD-000002', status: 'awaiting_location' },
  };

  function fakeQuote() {
    const calls: string[] = [];
    const fn: QuoteDynamicDelivery = async (orderId) => {
      calls.push(orderId);
      return { result: 'quoted' };
    };
    return { fn, calls };
  }

  function callQuote(attachResult: AttachLocationResult, quote: QuoteDynamicDelivery) {
    const raw = messageBody(locationMessage());
    return handleKapsoWebhook({
      rawBody: raw,
      headers: headers(raw),
      secret: SECRET,
      store: new FakeStore(),
      confirmOrder: NOOP_CONFIRM,
      ensureLocationRequest: NOOP_ENSURE,
      attachOrderLocation: async () => attachResult,
      sendMenuCta: NEVER_SEND_CTA,
      quoteDynamicDelivery: quote,
    });
  }

  it('attached + awaiting_location → cotiza (delivery dinámico)', async () => {
    const quote = fakeQuote();
    const res = await callQuote(ATTACHED_AWAITING, quote.fn);
    expect(res.outcome).toBe('processed');
    expect(quote.calls).toEqual(['ord-uuid']);
  });

  it('already_attached + awaiting_location → re-cotiza (reenvío con quote failed)', async () => {
    const quote = fakeQuote();
    await callQuote(ALREADY_AWAITING, quote.fn);
    expect(quote.calls).toEqual(['ord-uuid']);
  });

  it('attached + confirmed (legacy) → NO cotiza', async () => {
    const quote = fakeQuote();
    // ATTACHED_RESULT deja status 'confirmed' (legacy).
    await callQuote(ATTACHED_RESULT, quote.fn);
    expect(quote.calls).toEqual([]);
  });

  it('sin dep de cotización el webhook sigue funcionando (comportamiento previo)', async () => {
    const raw = messageBody(locationMessage());
    const res = await handleKapsoWebhook({
      rawBody: raw,
      headers: headers(raw),
      secret: SECRET,
      store: new FakeStore(),
      confirmOrder: NOOP_CONFIRM,
      ensureLocationRequest: NOOP_ENSURE,
      attachOrderLocation: async () => ATTACHED_AWAITING,
      sendMenuCta: NEVER_SEND_CTA,
      // sin quoteDynamicDelivery
    });
    expect(res.outcome).toBe('processed');
  });
});

// ── El pin que no responde a nada (0027) ────────────────────────────────────

describe('handleKapsoWebhook — cotización de una ubicación suelta', () => {
  /**
   * El fallo real, del 29-08-2026: un cliente preguntó por el delivery, mandó
   * su ubicación con el botón normal de WhatsApp y NO recibió nada. El parser
   * exige `context.id` para poder correlacionar con el pedido, y sin él
   * descartaba el mensaje como `invalid_shape`; el clasificador lo daba por
   * atendido, así que el agente tampoco llegaba a verlo. Silencio absoluto,
   * justo al cliente que estaba decidiendo si pedir.
   */
  function fakeStandaloneQuote(result = 'quoted') {
    const calls: Array<{
      customerPhone: string;
      sourceMessageId: string;
      coords: { lat: number; lng: number };
      phoneNumberId: string | null;
    }> = [];
    const fn: QuoteStandaloneLocation = async (input) => {
      calls.push(input);
      return { result };
    };
    return { fn, calls };
  }

  function callStandalone(
    message: Record<string, unknown>,
    quote?: QuoteStandaloneLocation,
    attachResult: AttachLocationResult = ATTACHED_RESULT,
  ) {
    const raw = messageBody(message);
    return handleKapsoWebhook({
      rawBody: raw,
      headers: headers(raw),
      secret: SECRET,
      store: new FakeStore(),
      confirmOrder: NOOP_CONFIRM,
      ensureLocationRequest: NOOP_ENSURE,
      attachOrderLocation: async () => attachResult,
      sendMenuCta: NEVER_SEND_CTA,
      quoteStandaloneLocation: quote,
    });
  }

  it('un pin SIN contexto se cotiza en vez de descartarse', async () => {
    const quote = fakeStandaloneQuote();
    const res = await callStandalone(locationMessage({ context: undefined }), quote.fn);

    expect(res.outcome).toBe('processed');
    expect(quote.calls).toHaveLength(1);
    expect(quote.calls[0]).toMatchObject({
      // El teléfono de la CONVERSACIÓN, igual que en el camino de adjuntar: si
      // los dos no coincidieran, el ledger de cotizaciones y el pedido hablarían
      // de clientes distintos y el reuso nunca encontraría nada.
      customerPhone: '59170000000',
      sourceMessageId: 'wamid.LOC_MSG_1',
      coords: { lat: -17.7833, lng: -63.1821 },
    });
  });

  it('el pin que SÍ responde a nuestra petición sigue adjuntándose, no cotizándose', async () => {
    // La regresión que hay que evitar: si la cotización suelta se comiera este
    // caso, el GPS dejaría de llegar al pedido y el checkout se quedaría sin
    // dirección. El camino viejo manda mientras haya pedido detrás.
    const quote = fakeStandaloneQuote();
    const res = await callStandalone(locationMessage(), quote.fn);

    expect(res.outcome).toBe('processed');
    expect(quote.calls).toEqual([]);
  });

  it('un contexto que ya no tiene pedido detrás también se cotiza', async () => {
    // El cliente respondió a un botón viejo. Su ubicación sigue siendo una
    // pregunta legítima aunque el pedido ya no exista.
    const quote = fakeStandaloneQuote();
    await callStandalone(locationMessage(), quote.fn, { result: 'not_found' });

    expect(quote.calls).toHaveLength(1);
  });

  it('un pedido de otro teléfono NO se cotiza: eso no es una pregunta, es un cruce', async () => {
    const quote = fakeStandaloneQuote();
    await callStandalone(locationMessage(), quote.fn, { result: 'phone_mismatch' });

    expect(quote.calls).toEqual([]);
  });

  it('unas coordenadas imposibles no se cotizan', async () => {
    // El parser suelto relaja el contexto, NO la validación de lo que importa.
    const quote = fakeStandaloneQuote();
    await callStandalone(
      locationMessage({ context: undefined, location: { latitude: 999, longitude: -63.1 } }),
      quote.fn,
    );

    expect(quote.calls).toEqual([]);
  });

  it('sin la dependencia, el webhook se comporta como antes', async () => {
    const res = await callStandalone(locationMessage({ context: undefined }));
    expect(res.outcome).toBe('processed');
  });
});

// ── El pin que no responde al botón, con un pedido esperándolo (0028) ───────

describe('handleKapsoWebhook — el pin sin contexto de quien YA pidió', () => {
  /**
   * El flujo real, tal como lo contó el negocio: el cliente arma todo el
   * pedido, le sale el botón de "enviar ubicación"… y no lo usa. Manda su
   * ubicación con el clip de WhatsApp de siempre, como en cualquier otro chat.
   *
   * Ese pin llega SIN `context.id`, así que hasta ahora se leía como "¿cuánto
   * sale el envío?": el cliente recibía una tarifa suelta y un "armá tu pedido
   * en el menú" que acababa de hacer, mientras su pedido se quedaba en
   * `awaiting_location` para siempre — sin total, sin QR y sin nadie
   * preparándolo. Silencio con todo en verde.
   */
  const AWAITING: AttachLocationResult = {
    result: 'attached',
    order: { id: 'ord-uuid', order_number: 'ORD-000002', status: 'awaiting_location' },
  };

  function fakeLoose(result: AttachLocationResult) {
    const calls: Array<Parameters<AttachLooseLocation>[0]> = [];
    const fn: AttachLooseLocation = async (input) => {
      calls.push(input);
      return result;
    };
    return { fn, calls };
  }

  function fakeStandaloneQuote() {
    const calls: unknown[] = [];
    const fn: QuoteStandaloneLocation = async (input) => {
      calls.push(input);
      return { result: 'quoted' };
    };
    return { fn, calls };
  }

  function fakeDynamicQuote() {
    const calls: string[] = [];
    const fn: QuoteDynamicDelivery = async (orderId) => {
      calls.push(orderId);
      return { result: 'quoted' };
    };
    return { fn, calls };
  }

  function callPin(
    message: Record<string, unknown>,
    deps: {
      loose?: AttachLooseLocation;
      standalone?: QuoteStandaloneLocation;
      dynamic?: QuoteDynamicDelivery;
      attachResult?: AttachLocationResult;
    } = {},
  ) {
    const raw = messageBody(message);
    return handleKapsoWebhook({
      rawBody: raw,
      headers: headers(raw),
      secret: SECRET,
      store: new FakeStore(),
      confirmOrder: NOOP_CONFIRM,
      ensureLocationRequest: NOOP_ENSURE,
      attachOrderLocation: async () => deps.attachResult ?? ATTACHED_RESULT,
      sendMenuCta: NEVER_SEND_CTA,
      attachLooseLocation: deps.loose,
      quoteStandaloneLocation: deps.standalone,
      quoteDynamicDelivery: deps.dynamic,
    });
  }

  it('el pin va al pedido que lo esperaba, NO a una cotización suelta', async () => {
    const loose = fakeLoose(AWAITING);
    const standalone = fakeStandaloneQuote();

    const res = await callPin(locationMessage({ context: undefined }), {
      loose: loose.fn,
      standalone: standalone.fn,
    });

    expect(res.outcome).toBe('processed');
    expect(loose.calls).toHaveLength(1);
    expect(loose.calls[0]).toMatchObject({
      customerPhoneDigits: '59170000000',
      latitude: -17.7833,
      longitude: -63.1821,
    });
    // Lo que arregla el silencio: NO se le manda una tarifa suelta a quien ya
    // tiene el pedido armado.
    expect(standalone.calls).toEqual([]);
  });

  it('adjuntado y todavía esperando: se cotiza el pedido, que es lo que trae el QR', async () => {
    // Adjuntar sin cotizar sería el mismo silencio un paso más adelante: el
    // pedido tendría GPS y seguiría sin confirmarse.
    const dynamic = fakeDynamicQuote();
    await callPin(locationMessage({ context: undefined }), {
      loose: fakeLoose(AWAITING).fn,
      dynamic: dynamic.fn,
    });

    expect(dynamic.calls).toEqual(['ord-uuid']);
  });

  it('nadie esperaba el pin: se cotiza suelto, como antes', async () => {
    const loose = fakeLoose({ result: 'not_found' });
    const standalone = fakeStandaloneQuote();

    await callPin(locationMessage({ context: undefined }), {
      loose: loose.fn,
      standalone: standalone.fn,
    });

    expect(loose.calls).toHaveLength(1);
    expect(standalone.calls).toHaveLength(1);
  });

  it('el pin que SÍ responde al botón sigue por su camino de siempre', async () => {
    // La regresión que hay que evitar: si la búsqueda por teléfono se comiera
    // este caso, la correlación exacta por wamid dejaría de mandar.
    const loose = fakeLoose(AWAITING);
    await callPin(locationMessage(), { loose: loose.fn });

    expect(loose.calls).toEqual([]);
  });

  it('un botón viejo sin pedido detrás: se intenta el pedido que sí espera', async () => {
    const loose = fakeLoose(AWAITING);
    const standalone = fakeStandaloneQuote();

    await callPin(locationMessage(), {
      loose: loose.fn,
      standalone: standalone.fn,
      attachResult: { result: 'not_found' },
    });

    expect(loose.calls).toHaveLength(1);
    expect(standalone.calls).toEqual([]);
  });

  it('una carrera perdida se reintenta: no se da por atendido', async () => {
    // Mismo trato que en el camino con contexto: 500 y fila reclamable, en vez
    // de un `processed` sobre un pedido que nadie escribió.
    const loose = fakeLoose({ result: 'concurrent_update' });
    const res = await callPin(locationMessage({ context: undefined }), { loose: loose.fn });

    expect(res.status).toBe(500);
    expect(res.outcome).toBe('failed');
  });

  it('coordenadas imposibles no adjuntan nada', async () => {
    const loose = fakeLoose(AWAITING);
    await callPin(
      locationMessage({ context: undefined, location: { latitude: 999, longitude: -63.1 } }),
      { loose: loose.fn },
    );

    expect(loose.calls).toEqual([]);
  });

  it('sin la dependencia, el webhook se comporta EXACTAMENTE como antes', async () => {
    const standalone = fakeStandaloneQuote();
    const res = await callPin(locationMessage({ context: undefined }), {
      standalone: standalone.fn,
    });

    expect(res.outcome).toBe('processed');
    expect(standalone.calls).toHaveLength(1);
  });
});

// ── La ubicación que llega como link o como texto (0029) ────────────────

describe('handleKapsoWebhook — ubicación compartida por link de Google Maps', () => {
  /**
   * Mucha gente no usa el pin: abre Google Maps, busca su casa y le da a
   * compartir. Llega un texto con un link corto, así que ni el parser de
   * ubicación lo veía ni el detector de "¿cuánto sale el envío?" lo reconocía:
   * terminaba en el modelo, que contestaba pidiéndole la ubicación que acababa
   * de mandar.
   */
  const CORTO = 'https://maps.app.goo.gl/5biYBaWPiPGPPcyB9';

  /** La respuesta real de Google (medida el 01-09-2026). */
  const LARGO =
    'https://www.google.com/maps/place/17%C2%B050%2734.7%22S+63%C2%B010%2744.9%22W/' +
    '@-17.8429809,-63.1817199,17z/data=!3m1!4b1!4m4!3m3!8m2!3d-17.8429809!4d-63.179145';

  const AWAITING: AttachLocationResult = {
    result: 'attached',
    order: { id: 'ord-uuid', order_number: 'ORD-000002', status: 'awaiting_location' },
  };

  function fakeExpand(resultado: string | null = LARGO) {
    const calls: string[] = [];
    const fn: ExpandMapsLink = async (url) => {
      calls.push(url);
      return resultado;
    };
    return { fn, calls };
  }

  function fakeLoose(result: AttachLocationResult) {
    const calls: Array<Parameters<AttachLooseLocation>[0]> = [];
    const fn: AttachLooseLocation = async (input) => {
      calls.push(input);
      return result;
    };
    return { fn, calls };
  }

  function fakeStandalone() {
    const calls: Array<Parameters<QuoteStandaloneLocation>[0]> = [];
    const fn: QuoteStandaloneLocation = async (input) => {
      calls.push(input);
      return { result: 'quoted' };
    };
    return { fn, calls };
  }

  function callTexto(
    body: string,
    deps: {
      expand?: ExpandMapsLink;
      loose?: AttachLooseLocation;
      standalone?: QuoteStandaloneLocation;
      ask?: AskLocationForQuote;
      cta?: SendMenuCta;
    } = {},
  ) {
    const raw = messageBody({
      id: 'wamid.TXT_LINK_1',
      type: 'text',
      from: '59170000001',
      text: { body },
    });
    return handleKapsoWebhook({
      rawBody: raw,
      headers: headers(raw),
      secret: SECRET,
      store: new FakeStore(),
      confirmOrder: NOOP_CONFIRM,
      ensureLocationRequest: NOOP_ENSURE,
      attachOrderLocation: NOOP_ATTACH,
      sendMenuCta: deps.cta ?? NEVER_SEND_CTA,
      expandMapsLink: deps.expand,
      attachLooseLocation: deps.loose,
      quoteStandaloneLocation: deps.standalone,
      askLocationForQuote: deps.ask,
    });
  }

  it('el link corto se expande y va al pedido que esperaba', async () => {
    const expand = fakeExpand();
    const loose = fakeLoose(AWAITING);

    const res = await callTexto(CORTO, { expand: expand.fn, loose: loose.fn });

    expect(res.outcome).toBe('processed');
    expect(expand.calls).toEqual([CORTO]);
    expect(loose.calls).toHaveLength(1);
    // El par del LUGAR, no el de la cámara: -63.179145, no -63.1817199.
    expect(loose.calls[0].longitude).toBeCloseTo(-63.179145, 6);
  });

  it('sin pedido esperando, el link se cotiza como un pin suelto', async () => {
    const standalone = fakeStandalone();
    await callTexto(CORTO, {
      expand: fakeExpand().fn,
      loose: fakeLoose({ result: 'not_found' }).fn,
      standalone: standalone.fn,
    });

    expect(standalone.calls).toHaveLength(1);
    expect(standalone.calls[0].coords.lng).toBeCloseTo(-63.179145, 6);
    // El WAMID del texto es la clave de idempotencia, igual que el del pin.
    expect(standalone.calls[0].sourceMessageId).toBe('wamid.TXT_LINK_1');
  });

  it('"cotizame aqui <link>" NO le pide la ubicación que acaba de mandar', async () => {
    // El orden del pipeline, que es lo que hace útil este caso: ese texto lleva
    // palabra de coste y palabra de lugar, así que `isDeliveryQuoteIntent` lo
    // reconocería y contestaría "mandame tu ubicación" — a alguien que la
    // acaba de mandar. La ubicación se atiende ANTES.
    const ask = { calls: 0 };
    const askFn: AskLocationForQuote = async () => {
      ask.calls += 1;
      return { ok: true };
    };
    const standalone = fakeStandalone();

    await callTexto(`cotizame aqui ${CORTO}`, {
      expand: fakeExpand().fn,
      loose: fakeLoose({ result: 'not_found' }).fn,
      standalone: standalone.fn,
      ask: askFn,
    });

    expect(standalone.calls).toHaveLength(1);
    expect(ask.calls).toBe(0);
  });

  it('las coordenadas escritas no gastan ninguna petición de red', async () => {
    // El formato que copia y pega quien abre el pin en Maps. Son dos números:
    // no hay nada que expandir ni formato de nadie del que depender.
    const expand = fakeExpand();
    const standalone = fakeStandalone();

    await callTexto('Lat: -17.842973709106, Long: -63.179229736328', {
      expand: expand.fn,
      loose: fakeLoose({ result: 'not_found' }).fn,
      standalone: standalone.fn,
    });

    expect(expand.calls).toEqual([]);
    expect(standalone.calls[0].coords).toMatchObject({ lat: -17.842973709106 });
  });

  it('si el link no se puede expandir, el mensaje sigue su camino de hoy', async () => {
    // Google caído o formato cambiado. No se inventa una ubicación: el mensaje
    // queda para el agente, que es exactamente lo que pasaba antes.
    const standalone = fakeStandalone();
    const res = await callTexto(CORTO, {
      expand: fakeExpand(null).fn,
      loose: fakeLoose({ result: 'not_found' }).fn,
      standalone: standalone.fn,
    });

    expect(standalone.calls).toEqual([]);
    expect(res.body.handled).toBe('ignored');
  });

  it('sin el puerto de expansión no se sale a la red', async () => {
    const standalone = fakeStandalone();
    const res = await callTexto(CORTO, { standalone: standalone.fn });

    expect(standalone.calls).toEqual([]);
    expect(res.body.handled).toBe('ignored');
  });

  it('la intención de MENÚ sigue ganando: quien quiere pedir, pide', async () => {
    const cta = { calls: 0 };
    const sendCta: SendMenuCta = async () => {
      cta.calls += 1;
      return { result: 'sent', deliveryId: 'del-cta', wamid: 'wamid.CTA' };
    };
    const standalone = fakeStandalone();

    await callTexto(`quiero pedir, mi ubicacion es ${CORTO}`, {
      expand: fakeExpand().fn,
      standalone: standalone.fn,
      cta: sendCta,
    });

    expect(cta.calls).toBe(1);
    expect(standalone.calls).toEqual([]);
  });

  it('un mensaje normal no dispara nada de esto', async () => {
    const expand = fakeExpand();
    const standalone = fakeStandalone();

    const res = await callTexto('hola, tienen hamburguesas?', {
      expand: expand.fn,
      standalone: standalone.fn,
    });

    expect(expand.calls).toEqual([]);
    expect(standalone.calls).toEqual([]);
    // Declinado: queda para el agente, como cualquier pregunta.
    expect(res.body.handled).toBe('ignored');
  });

  it('un link que no es de Maps no se toca', async () => {
    const expand = fakeExpand();
    await callTexto('mira esto https://facebook.com/algo', { expand: expand.fn });

    expect(expand.calls).toEqual([]);
  });
});

// ── "¿Cuánto sale el envío?" (0027) ─────────────────────────────────────────

describe('handleKapsoWebhook — la pregunta por el envío no llega al modelo', () => {
  function fakeAsk(ok = true) {
    const calls: Array<{ toDigits: string; sourceMessageId: string }> = [];
    const fn: AskLocationForQuote = async (input) => {
      calls.push(input);
      return { ok };
    };
    return { fn, calls };
  }

  function callAsk(body: string, ask?: AskLocationForQuote, cta = NEVER_SEND_CTA) {
    const raw = messageBody({ id: 'wamid.TXT_1', type: 'text', from: '59170000001', text: { body } });
    return handleKapsoWebhook({
      rawBody: raw,
      headers: headers(raw),
      secret: SECRET,
      store: new FakeStore(),
      confirmOrder: NOOP_CONFIRM,
      ensureLocationRequest: NOOP_ENSURE,
      attachOrderLocation: NOOP_ATTACH,
      sendMenuCta: cta,
      askLocationForQuote: ask,
    });
  }

  it('el mensaje real que derivó una conversación ahora se atiende aquí', async () => {
    const ask = fakeAsk();
    const res = await callAsk('hola como esta zarco cuanto me saldria delivery aqui', ask.fn);

    expect(res.outcome).toBe('processed');
    expect(ask.calls).toHaveLength(1);
    expect(ask.calls[0]).toMatchObject({ toDigits: '59170000001', sourceMessageId: 'wamid.TXT_1' });
  });

  it('una pregunta por el precio de un PRODUCTO sigue yendo al agente', async () => {
    // El falso positivo que hay que evitar: si esto se activara, "cuánto cuesta
    // el trancapecho" contestaría pidiendo la ubicación en vez del precio.
    const ask = fakeAsk();
    await callAsk('cuanto cuesta el trancapecho?', ask.fn);

    expect(ask.calls).toEqual([]);
  });

  it('la intención de MENÚ sigue ganando cuando aparecen las dos', async () => {
    // "quiero pedir, cuánto sale el envío" es alguien que quiere pedir. El CTA
    // manda, y este detector solo recoge lo que hoy cae en el modelo.
    const ask = fakeAsk();
    const cta = { calls: 0 };
    const sendCta: SendMenuCta = async () => {
      cta.calls += 1;
      return { result: 'sent', deliveryId: 'del-cta', wamid: 'wamid.CTA' };
    };

    await callAsk('quiero pedir cuanto sale el envio', ask.fn, sendCta);

    expect(cta.calls).toBe(1);
    expect(ask.calls).toEqual([]);
  });

  it('sin la dependencia, la pregunta vuelve a caer en el agente', async () => {
    const res = await callAsk('cuanto sale el envio?');
    expect(res.outcome).toBe('processed');
  });
});
