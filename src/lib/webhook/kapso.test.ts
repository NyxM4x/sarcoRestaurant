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
