import { describe, it, expect } from 'vitest';
import {
  dispatchExisting,
  dispatchSingleNotification,
  initializeAndDispatch,
  type ClaimResult,
  type LoadedOrder,
  type NotificationSender,
  type NotificationStore,
  type NotificationType,
  type SendResult,
} from './web-notify';

const ORDER_ID = '22222222-2222-4222-8222-222222222222';
const PHONE = '59170000000';
const PNID = 'pnid-sesion';
const CONFIRM_NOTIF = 'aaaaaaaa-0000-4000-8000-000000000001';
const LOCATION_NOTIF = 'aaaaaaaa-0000-4000-8000-000000000002';
const CONFIRM_TOKEN = 'bbbbbbbb-0000-4000-8000-000000000001';
const LOCATION_TOKEN = 'bbbbbbbb-0000-4000-8000-000000000002';
/** Mensaje "técnico" que jamás debe aparecer en el resultado. */
const SECRET_MESSAGE = 'ECONNRESET api.kapso.ai x-api-key=SECRETO';

function order(overrides: Partial<LoadedOrder> = {}): LoadedOrder {
  return {
    id: ORDER_ID,
    order_number: 'ORD-000042',
    customer_phone: PHONE,
    customer_name: 'Juan García',
    delivery_type: 'delivery',
    status: 'awaiting_location',
    subtotal_amount: 90,
    delivery_amount: 0,
    total_amount: 90,
    payment_method: 'cash',
    delivery_pricing: null,
    delivery_quote_status: null,
    phone_number_id: PNID,
    location_request_message_id: null,
    items: [{ product_name_snapshot: 'La Fija', quantity: 2, subtotal: 80 }],
    ...overrides,
  };
}

const ORDER_RECEIVED_NOTIF = 'aaaaaaaa-0000-4000-8000-000000000003';
const ORDER_RECEIVED_TOKEN = 'bbbbbbbb-0000-4000-8000-000000000003';

const CLAIM_OK: Record<NotificationType, ClaimResult> = {
  order_received: { claimed: true, notificationId: ORDER_RECEIVED_NOTIF, claimToken: ORDER_RECEIVED_TOKEN },
  confirmation: { claimed: true, notificationId: CONFIRM_NOTIF, claimToken: CONFIRM_TOKEN },
  location_request: { claimed: true, notificationId: LOCATION_NOTIF, claimToken: LOCATION_TOKEN },
};

interface MarkCall {
  notificationId: string;
  claimToken: string;
  value: string;
}

/** Store + sender falsos con bitácora ordenada de acciones. */
function harness(options: {
  loaded?: LoadedOrder | null;
  claims?: Partial<Record<NotificationType, ClaimResult>>;
  sendText?: SendResult;
  sendImage?: SendResult;
  sendLocation?: SendResult;
  markConfirmationSent?: boolean;
  markLocationSent?: boolean;
  loadThrows?: boolean;
  initializeThrows?: boolean;
  claimThrows?: boolean;
  sendTextThrows?: boolean;
  sendImageThrows?: boolean;
  sendLocationThrows?: boolean;
  markFailedThrows?: boolean;
  markConfirmationSentThrows?: boolean;
  markLocationSentThrows?: boolean;
}) {
  const log: string[] = [];
  const claimed: NotificationType[] = [];
  const sentTexts: string[] = [];
  const sentImages: Array<{ imageUrl: string; caption: string }> = [];
  const locationOrderNumbers: string[] = [];
  const markConfirmationCalls: MarkCall[] = [];
  const markLocationCalls: MarkCall[] = [];
  const markFailedCalls: MarkCall[] = [];
  let initializeCalls = 0;

  const store: NotificationStore = {
    async initialize() {
      initializeCalls += 1;
      log.push('initialize');
      if (options.initializeThrows) throw new Error('boom');
    },
    async loadOrder() {
      log.push('loadOrder');
      if (options.loadThrows) throw new Error('boom');
      return options.loaded === undefined ? order() : options.loaded;
    },
    async claim(_orderId, type) {
      log.push(`claim:${type}`);
      claimed.push(type);
      if (options.claimThrows) throw new Error('boom');
      return options.claims?.[type] ?? CLAIM_OK[type];
    },
    async markOrderReceivedSent(notificationId, claimToken, wamid) {
      log.push('markOrderReceivedSent');
      markConfirmationCalls.push({ notificationId, claimToken, value: wamid });
      if (options.markConfirmationSentThrows) throw new Error('boom-markSent');
      return options.markConfirmationSent ?? true;
    },
    async markConfirmationSent(notificationId, claimToken, wamid) {
      log.push('markConfirmationSent');
      markConfirmationCalls.push({ notificationId, claimToken, value: wamid });
      if (options.markConfirmationSentThrows) throw new Error('boom-markSent');
      return options.markConfirmationSent ?? true;
    },
    async markLocationSent(notificationId, claimToken, wamid) {
      log.push('markLocationSent');
      markLocationCalls.push({ notificationId, claimToken, value: wamid });
      if (options.markLocationSentThrows) throw new Error('boom-markSent');
      return options.markLocationSent ?? true;
    },
    async markFailed(notificationId, claimToken, errorCode) {
      log.push('markFailed');
      markFailedCalls.push({ notificationId, claimToken, value: errorCode });
      if (options.markFailedThrows) throw new Error('boom-markFailed');
      return true;
    },
  };

  const sender: NotificationSender = {
    async sendText(_phone, text) {
      log.push('sendText');
      sentTexts.push(text);
      if (options.sendTextThrows) throw new Error(SECRET_MESSAGE);
      return options.sendText ?? { ok: true, wamid: 'wamid.CONF' };
    },
    async sendImage(_phone, imageUrl, caption) {
      log.push('sendImage');
      sentImages.push({ imageUrl, caption });
      if (options.sendImageThrows) throw new Error(SECRET_MESSAGE);
      return options.sendImage ?? { ok: true, wamid: 'wamid.CONF' };
    },
    async sendLocationRequest(_phone, _phoneNumberId, orderNumber) {
      log.push('sendLocationRequest');
      locationOrderNumbers.push(orderNumber);
      if (options.sendLocationThrows) throw new Error(SECRET_MESSAGE);
      return options.sendLocation ?? { ok: true, wamid: 'wamid.LOC' };
    },
  };

  return {
    store,
    sender,
    log,
    claimed,
    sentTexts,
    sentImages,
    locationOrderNumbers,
    markConfirmationCalls,
    markLocationCalls,
    markFailedCalls,
    get initializeCalls() {
      return initializeCalls;
    },
  };
}

describe('dispatchSingleNotification — un único POST por llamada (worker)', () => {
  it('15. confirmation NO envía además la ubicación en la misma llamada', async () => {
    const h = harness({ loaded: order({ delivery_type: 'delivery', status: 'awaiting_location' }) });
    const r = await dispatchSingleNotification(h.store, h.sender, ORDER_ID, 'confirmation');

    expect(r).toEqual({ notificationType: 'confirmation', outcome: 'sent', sendAttempted: true });
    // Exactamente un POST: el texto. NUNCA la solicitud de ubicación.
    expect(h.log.filter((l) => l === 'sendText')).toHaveLength(1);
    expect(h.log).not.toContain('sendLocationRequest');
    expect(h.claimed).toEqual(['confirmation']);
  });

  it('location_request solo envía la ubicación, y un único POST', async () => {
    const h = harness({ loaded: order({ delivery_type: 'delivery', status: 'awaiting_location' }) });
    const r = await dispatchSingleNotification(h.store, h.sender, ORDER_ID, 'location_request');

    expect(r).toEqual({ notificationType: 'location_request', outcome: 'sent', sendAttempted: true });
    expect(h.log.filter((l) => l === 'sendLocationRequest')).toHaveLength(1);
    expect(h.log).not.toContain('sendText');
  });

  it('R1-5. claim rechazado (confirmation_not_sent) → sender NO invocado, sin intento', async () => {
    const h = harness({
      loaded: order({ delivery_type: 'delivery', status: 'awaiting_location' }),
      claims: { location_request: { claimed: false, reason: 'confirmation_not_sent' } },
    });
    const r = await dispatchSingleNotification(h.store, h.sender, ORDER_ID, 'location_request');

    expect(r.sendAttempted).toBe(false);
    expect(h.log).not.toContain('sendLocationRequest');
  });

  it('R1-6. error local antes del sender (pedido inválido) → sin intento ni init', async () => {
    const h = harness({ loaded: null });
    const r = await dispatchSingleNotification(h.store, h.sender, ORDER_ID, 'confirmation');

    expect(r.sendAttempted).toBe(false);
    expect(h.initializeCalls).toBe(0);
    expect(h.log).not.toContain('sendText');
  });

  it('R1-1/2/3. timeout/network_error/invalid_response tras invocar el sender → sendAttempted=true', async () => {
    for (const error of ['timeout', 'network_error', 'invalid_response'] as const) {
      const h = harness({
        loaded: order({ delivery_type: 'pickup', status: 'confirmed' }),
        sendText: { ok: false, error },
      });
      const r = await dispatchSingleNotification(h.store, h.sender, ORDER_ID, 'confirmation');
      expect(r.sendAttempted).toBe(true); // el POST se inició
      expect(h.log).toContain('sendText'); // sender invocado
    }
  });

  it('R1-4. POST exitoso pero la persistencia lanza → sendAttempted=true (nunca segundo POST)', async () => {
    const h = harness({
      loaded: order({ delivery_type: 'pickup', status: 'confirmed' }),
      sendText: { ok: true, wamid: 'wamid.OK' },
      markConfirmationSentThrows: true,
    });
    const r = await dispatchSingleNotification(h.store, h.sender, ORDER_ID, 'confirmation');

    // La persistencia falló DESPUÉS del POST: el intento cuenta, outcome unknown.
    expect(r.sendAttempted).toBe(true);
    expect(r.outcome).toBe('unknown');
    expect(h.log.filter((l) => l === 'sendText')).toHaveLength(1); // un solo POST
  });
});

describe('dispatch — pickup', () => {
  it('envía solo la confirmación y nunca reclama location_request', async () => {
    const h = harness({ loaded: order({ delivery_type: 'pickup', status: 'confirmed' }) });
    const res = await dispatchExisting(h.store, h.sender, ORDER_ID);

    expect(res).toEqual({
      ok: true,
      orderId: ORDER_ID,
      confirmation: 'sent',
      locationRequest: 'not_applicable',
    });
    expect(h.claimed).toEqual(['confirmation']);
    expect(h.log).not.toContain('sendLocationRequest');
    expect(h.log).not.toContain('claim:location_request');
  });
});

describe('6D.1 — confirmación según método de pago', () => {
  it('cash: confirmación por TEXTO (comportamiento actual, sin imagen)', async () => {
    const h = harness({ loaded: order({ delivery_type: 'pickup', status: 'confirmed', payment_method: 'cash' }) });
    const res = await dispatchExisting(h.store, h.sender, ORDER_ID);

    expect(res.confirmation).toBe('sent');
    expect(h.log).toContain('sendText');
    expect(h.log).not.toContain('sendImage');
    expect(h.sentImages).toHaveLength(0);
  });

  it('NULL (histórico / WhatsApp Flow): confirmación por TEXTO, NUNCA imagen', async () => {
    const h = harness({ loaded: order({ delivery_type: 'pickup', status: 'confirmed', payment_method: null }) });
    const res = await dispatchExisting(h.store, h.sender, ORDER_ID);

    expect(res.confirmation).toBe('sent');
    expect(h.log).toContain('sendText');
    expect(h.log).not.toContain('sendImage');
  });

  it('qr: confirmación como IMAGEN del QR con caption que incluye el pedido', async () => {
    const h = harness({ loaded: order({ delivery_type: 'pickup', status: 'confirmed', payment_method: 'qr' }) });
    const res = await dispatchExisting(h.store, h.sender, ORDER_ID);

    expect(res.confirmation).toBe('sent');
    expect(h.log).toContain('sendImage');
    expect(h.log).not.toContain('sendText'); // un solo mensaje, no texto aparte
    expect(h.sentImages).toHaveLength(1);
    const img = h.sentImages[0];
    expect(img.imageUrl).toBe('https://la-fija-orders.vercel.app/payment/qr.png');
    // El caption lleva el número de pedido (clave de reconciliación) y la indicación de pago.
    expect(img.caption).toContain('ORD-000042');
    expect(img.caption).toContain('QR');
  });

  it('delivery + qr: imagen QR marcada sent → location_request continúa igual', async () => {
    const h = harness({ loaded: order({ delivery_type: 'delivery', status: 'awaiting_location', payment_method: 'qr' }) });
    const res = await dispatchExisting(h.store, h.sender, ORDER_ID);

    expect(res).toEqual({
      ok: true,
      orderId: ORDER_ID,
      confirmation: 'sent',
      locationRequest: 'sent',
    });
    // La confirmación es imagen, pero el flujo de ubicación es idéntico.
    expect(h.log).toEqual([
      'loadOrder',
      'claim:confirmation',
      'sendImage',
      'markConfirmationSent',
      'claim:location_request',
      'sendLocationRequest',
      'markLocationSent',
    ]);
    expect(h.sentImages).toHaveLength(1);
  });

  it('qr: un fallo de envío de la imagen NO se marca enviada y no se duplica', async () => {
    const h = harness({
      loaded: order({ delivery_type: 'pickup', status: 'confirmed', payment_method: 'qr' }),
      // network_error es AMBIGUO → pending_reconciliation (nunca se reenvía a ciegas).
      sendImage: { ok: false, error: 'network_error' },
    });
    const res = await dispatchExisting(h.store, h.sender, ORDER_ID);

    expect(res.confirmation).not.toBe('sent');
    expect(res.confirmation).not.toBe('already_sent');
    expect(h.log).toContain('sendImage');
    expect(h.log).toContain('markFailed'); // el intento se registra (misma infra de reintento)
    expect(h.log).not.toContain('markConfirmationSent'); // no se marca enviada si falló
    expect(h.sentImages).toHaveLength(1); // un solo intento, sin duplicado
  });

  it('qr: si la confirmación ya estaba enviada, NO se reenvía la imagen (idempotencia)', async () => {
    const h = harness({
      loaded: order({ delivery_type: 'pickup', status: 'confirmed', payment_method: 'qr' }),
      claims: { confirmation: { claimed: false, status: 'sent' } },
    });
    const res = await dispatchExisting(h.store, h.sender, ORDER_ID);

    expect(res.confirmation).toBe('already_sent');
    expect(h.log).not.toContain('sendImage');
    expect(h.sentImages).toHaveLength(0);
  });
});

describe('dispatch — delivery', () => {
  it('envía confirmación y luego ubicación, en ese orden exacto', async () => {
    const h = harness({});
    const res = await dispatchExisting(h.store, h.sender, ORDER_ID);

    expect(res).toEqual({
      ok: true,
      orderId: ORDER_ID,
      confirmation: 'sent',
      locationRequest: 'sent',
    });
    expect(h.log).toEqual([
      'loadOrder',
      'claim:confirmation',
      'sendText',
      'markConfirmationSent',
      'claim:location_request',
      'sendLocationRequest',
      'markLocationSent',
    ]);
  });

  it('pasa el order_number al sender de ubicación (token de reconciliación)', async () => {
    const h = harness({});
    await dispatchExisting(h.store, h.sender, ORDER_ID);

    expect(h.locationOrderNumbers).toEqual(['ORD-000042']);
  });

  it('order_number vacío -> invalid_order sin enviar nada', async () => {
    const h = harness({ loaded: order({ order_number: '   ' }) });
    const res = await dispatchExisting(h.store, h.sender, ORDER_ID);

    expect(res.reason).toBe('invalid_order');
    expect(h.claimed).toEqual([]);
    expect(h.log).not.toContain('sendText');
  });

  it('marca cada envío con su claim_token correspondiente', async () => {
    const h = harness({});
    await dispatchExisting(h.store, h.sender, ORDER_ID);

    expect(h.markConfirmationCalls).toEqual([
      { notificationId: CONFIRM_NOTIF, claimToken: CONFIRM_TOKEN, value: 'wamid.CONF' },
    ]);
    expect(h.markLocationCalls).toEqual([
      { notificationId: LOCATION_NOTIF, claimToken: LOCATION_TOKEN, value: 'wamid.LOC' },
    ]);
  });

  it('confirmación already_sent permite continuar a la ubicación', async () => {
    const h = harness({ claims: { confirmation: { claimed: false, status: 'sent' } } });
    const res = await dispatchExisting(h.store, h.sender, ORDER_ID);

    expect(res.confirmation).toBe('already_sent');
    expect(res.locationRequest).toBe('sent');
    expect(res.ok).toBe(true);
    expect(h.log).not.toContain('sendText');
    expect(h.log).toContain('sendLocationRequest');
  });

  it('confirmación in_flight bloquea la ubicación', async () => {
    const h = harness({ claims: { confirmation: { claimed: false, status: 'sending' } } });
    const res = await dispatchExisting(h.store, h.sender, ORDER_ID);

    expect(res.confirmation).toBe('in_flight');
    expect(res.locationRequest).toBe('blocked_by_confirmation');
    expect(res.ok).toBe(false);
    expect(h.claimed).toEqual(['confirmation']);
    expect(h.log).not.toContain('sendLocationRequest');
  });

  it('timeout de la confirmación -> pending_reconciliation y bloquea la ubicación', async () => {
    const h = harness({ sendText: { ok: false, error: 'timeout' } });
    const res = await dispatchExisting(h.store, h.sender, ORDER_ID);

    expect(res.confirmation).toBe('pending_reconciliation');
    expect(res.locationRequest).toBe('blocked_by_confirmation');
    expect(h.markFailedCalls).toEqual([
      { notificationId: CONFIRM_NOTIF, claimToken: CONFIRM_TOKEN, value: 'timeout' },
    ]);
    expect(h.log).not.toContain('sendLocationRequest');
  });

  it('timeout de la ubicación -> pending_reconciliation sin tocar el pedido', async () => {
    const h = harness({ sendLocation: { ok: false, error: 'network_error' } });
    const res = await dispatchExisting(h.store, h.sender, ORDER_ID);

    expect(res.confirmation).toBe('sent');
    expect(res.locationRequest).toBe('pending_reconciliation');
    expect(res.ok).toBe(false);
    expect(h.markFailedCalls).toEqual([
      { notificationId: LOCATION_NOTIF, claimToken: LOCATION_TOKEN, value: 'network_error' },
    ]);
  });

  it('NINGÚN motivo de rechazo del claim produce un envío (5.2D.5B.2)', async () => {
    const denials = [
      { reason: 'requires_reconciliation', expected: 'requires_reconciliation' },
      { reason: 'in_flight', expected: 'in_flight' },
      { reason: 'terminal', expected: 'terminal' },
      { reason: 'manual_review_required', expected: 'manual_review_required' },
      { reason: 'max_attempts_reached', expected: 'max_attempts_reached' },
      { reason: 'not_scheduled', expected: 'not_scheduled' },
      { reason: 'motivo_que_no_conocemos', expected: 'unknown' },
    ] as const;

    for (const { reason, expected } of denials) {
      const h = harness({ claims: { confirmation: { claimed: false, reason } } });
      const res = await dispatchExisting(h.store, h.sender, ORDER_ID);

      expect(res.confirmation).toBe(expected);
      expect(res.ok).toBe(false);
      // Lo decisivo: cero llamadas de red en todos los casos.
      expect(h.log).not.toContain('sendText');
      expect(h.log).not.toContain('sendLocationRequest');
    }
  });

  it('los estados de reconciliación se distinguen del envío en vuelo', async () => {
    const pendingRec = harness({
      claims: { confirmation: { claimed: false, status: 'pending_reconciliation' } },
    });
    expect((await dispatchExisting(pendingRec.store, pendingRec.sender, ORDER_ID)).confirmation).toBe(
      'requires_reconciliation',
    );
    expect(pendingRec.log).not.toContain('sendText');

    const reconciling = harness({
      claims: { confirmation: { claimed: false, status: 'reconciling' } },
    });
    expect(
      (await dispatchExisting(reconciling.store, reconciling.sender, ORDER_ID)).confirmation,
    ).toBe('reconciliation_in_progress');
    expect(reconciling.log).not.toContain('sendText');
  });

  it('location_request bloqueada DB-side no se adelanta a la confirmación', async () => {
    const h = harness({
      claims: { location_request: { claimed: false, reason: 'confirmation_not_sent' } },
    });
    const res = await dispatchExisting(h.store, h.sender, ORDER_ID);

    expect(res.locationRequest).toBe('blocked_by_confirmation');
    // La confirmación sí salió; la ubicación no.
    expect(h.log.filter((l) => l === 'sendLocationRequest')).toEqual([]);
  });

  it('cada intento produce como máximo un envío por tipo', async () => {
    const h = harness({});
    await dispatchExisting(h.store, h.sender, ORDER_ID);

    expect(h.log.filter((l) => l === 'sendText')).toHaveLength(1);
    expect(h.log.filter((l) => l === 'sendLocationRequest')).toHaveLength(1);
  });

  it('claim no otorgado no envía nada', async () => {
    const h = harness({
      claims: {
        confirmation: { claimed: false, status: 'sending' },
        location_request: { claimed: false, status: 'sending' },
      },
    });
    await dispatchExisting(h.store, h.sender, ORDER_ID);

    expect(h.log).not.toContain('sendText');
    expect(h.log).not.toContain('sendLocationRequest');
  });

  it('reejecución con todo sent produce cero envíos', async () => {
    const h = harness({
      claims: {
        confirmation: { claimed: false, status: 'sent' },
        location_request: { claimed: false, status: 'sent' },
      },
    });
    const res = await dispatchExisting(h.store, h.sender, ORDER_ID);

    expect(res).toEqual({
      ok: true,
      orderId: ORDER_ID,
      confirmation: 'already_sent',
      locationRequest: 'already_sent',
    });
    expect(h.sentTexts).toEqual([]);
    expect(h.log).not.toContain('sendText');
    expect(h.log).not.toContain('sendLocationRequest');
  });

  it('cierre que no aplica (token perdido) no afirma sent', async () => {
    const h = harness({ markConfirmationSent: false });
    const res = await dispatchExisting(h.store, h.sender, ORDER_ID);

    expect(res.confirmation).toBe('unknown');
    expect(res.locationRequest).toBe('blocked_by_confirmation');
  });

  it('notificación no inicializada se reporta sin enviar', async () => {
    const h = harness({
      claims: { confirmation: { claimed: false, reason: 'not_initialized' } },
    });
    const res = await dispatchExisting(h.store, h.sender, ORDER_ID);

    expect(res.confirmation).toBe('not_initialized');
    expect(res.locationRequest).toBe('blocked_by_confirmation');
    expect(h.log).not.toContain('sendText');
  });

  it('delivery confirmado CON solicitud previa: no reclama ni reenvía ubicación', async () => {
    const h = harness({
      loaded: order({ status: 'confirmed', location_request_message_id: 'wamid.PREVIO' }),
      claims: { confirmation: { claimed: false, status: 'sent' } },
    });
    const res = await dispatchExisting(h.store, h.sender, ORDER_ID);

    expect(res).toEqual({
      ok: true,
      orderId: ORDER_ID,
      confirmation: 'already_sent',
      locationRequest: 'already_sent',
    });
    // Estado terminal: ni siquiera se reclama la notificación de ubicación.
    expect(h.claimed).toEqual(['confirmation']);
    expect(h.log).not.toContain('claim:location_request');
    expect(h.log).not.toContain('sendLocationRequest');
  });

  it('delivery confirmado SIN solicitud previa: estado inconsistente, no envía nada', async () => {
    for (const wamid of [null, '   ']) {
      const h = harness({
        loaded: order({ status: 'confirmed', location_request_message_id: wamid }),
      });
      const res = await dispatchExisting(h.store, h.sender, ORDER_ID);

      expect(res).toEqual({
        ok: false,
        orderId: ORDER_ID,
        confirmation: 'not_initialized',
        locationRequest: 'not_applicable',
        reason: 'invalid_order',
      });
      expect(h.claimed).toEqual([]);
      expect(h.log).not.toContain('sendText');
      expect(h.log).not.toContain('sendLocationRequest');
    }
  });

  it('confirmación con claim ya sent no reenvía el texto', async () => {
    const h = harness({ claims: { confirmation: { claimed: false, status: 'sent' } } });
    await dispatchExisting(h.store, h.sender, ORDER_ID);

    expect(h.sentTexts).toEqual([]);
    expect(h.log).not.toContain('sendText');
  });
});

describe('dispatch — validación de carga', () => {
  it('pedido inexistente -> invalid_order sin reclamar', async () => {
    const h = harness({ loaded: null });
    const res = await dispatchExisting(h.store, h.sender, ORDER_ID);

    expect(res).toEqual({
      ok: false,
      orderId: ORDER_ID,
      confirmation: 'not_initialized',
      locationRequest: 'not_applicable',
      reason: 'invalid_order',
    });
    expect(h.claimed).toEqual([]);
  });

  it('teléfono o phone_number_id vacío -> invalid_order', async () => {
    const noPhone = harness({ loaded: order({ customer_phone: '  ' }) });
    expect((await dispatchExisting(noPhone.store, noPhone.sender, ORDER_ID)).reason).toBe(
      'invalid_order',
    );

    const noPnid = harness({ loaded: order({ phone_number_id: '' }) });
    expect((await dispatchExisting(noPnid.store, noPnid.sender, ORDER_ID)).reason).toBe(
      'invalid_order',
    );
  });

  it('estado no permitido -> invalid_order sin enviar', async () => {
    const pickupPending = harness({
      loaded: order({ delivery_type: 'pickup', status: 'awaiting_location' }),
    });
    const res = await dispatchExisting(pickupPending.store, pickupPending.sender, ORDER_ID);
    expect(res.reason).toBe('invalid_order');
    expect(pickupPending.log).not.toContain('sendText');

    const draft = harness({ loaded: order({ status: 'draft' }) });
    expect((await dispatchExisting(draft.store, draft.sender, ORDER_ID)).reason).toBe(
      'invalid_order',
    );
  });

  it('pedido sin ítems -> missing_items sin enviar', async () => {
    const h = harness({ loaded: order({ items: [] }) });
    const res = await dispatchExisting(h.store, h.sender, ORDER_ID);

    expect(res.reason).toBe('missing_items');
    expect(res.ok).toBe(false);
    expect(h.claimed).toEqual([]);
  });
});

describe('dispatch — errores no se propagan', () => {
  it('error del store al cargar no lanza', async () => {
    const h = harness({ loadThrows: true });
    const res = await dispatchExisting(h.store, h.sender, ORDER_ID);

    expect(res).toEqual({
      ok: false,
      orderId: ORDER_ID,
      confirmation: 'failed',
      locationRequest: 'not_applicable',
      reason: 'persistence_error',
    });
  });

  it('error del store al reclamar no lanza', async () => {
    const h = harness({ claimThrows: true });
    const res = await dispatchExisting(h.store, h.sender, ORDER_ID);
    expect(res.reason).toBe('persistence_error');
    expect(res.ok).toBe(false);
  });

  it('sendText que lanza -> markFailed(network_error) y ubicación bloqueada', async () => {
    const h = harness({ sendTextThrows: true });
    const res = await dispatchExisting(h.store, h.sender, ORDER_ID);

    expect(res).toEqual({
      ok: false,
      orderId: ORDER_ID,
      confirmation: 'pending_reconciliation',
      locationRequest: 'blocked_by_confirmation',
    });
    // Excepción del sender: network_error, NO persistence_error.
    expect(res.reason).toBeUndefined();
    expect(h.markFailedCalls).toEqual([
      { notificationId: CONFIRM_NOTIF, claimToken: CONFIRM_TOKEN, value: 'network_error' },
    ]);
    expect(h.log).not.toContain('sendLocationRequest');
  });

  it('sendLocationRequest que lanza -> markFailed(network_error)', async () => {
    const h = harness({ sendLocationThrows: true });
    const res = await dispatchExisting(h.store, h.sender, ORDER_ID);

    expect(res.confirmation).toBe('sent');
    expect(res.locationRequest).toBe('pending_reconciliation');
    expect(res.reason).toBeUndefined();
    expect(h.markFailedCalls).toEqual([
      { notificationId: LOCATION_NOTIF, claimToken: LOCATION_TOKEN, value: 'network_error' },
    ]);
  });

  it('markFailed que también falla devuelve resultado seguro sin lanzar', async () => {
    const h = harness({ sendTextThrows: true, markFailedThrows: true });
    const res = await dispatchExisting(h.store, h.sender, ORDER_ID);

    expect(res.confirmation).toBe('pending_reconciliation');
    expect(res.locationRequest).toBe('blocked_by_confirmation');
    expect(res.ok).toBe(false);
  });

  it('no filtra el mensaje original de ninguna excepción', async () => {
    const senderHarness = harness({ sendTextThrows: true });
    const fromSender = await dispatchExisting(senderHarness.store, senderHarness.sender, ORDER_ID);

    const storeHarness = harness({ claimThrows: true });
    const fromStore = await dispatchExisting(storeHarness.store, storeHarness.sender, ORDER_ID);

    for (const res of [fromSender, fromStore]) {
      const serialized = JSON.stringify(res);
      expect(serialized).not.toContain(SECRET_MESSAGE);
      expect(serialized).not.toContain('ECONNRESET');
      expect(serialized).not.toContain('SECRETO');
      expect(serialized).not.toContain('boom');
    }
  });
});

describe('modos explícitos de inicialización', () => {
  it('initializeAndDispatch llama initialize antes de cargar', async () => {
    const h = harness({});
    await initializeAndDispatch(h.store, h.sender, ORDER_ID);

    expect(h.initializeCalls).toBe(1);
    expect(h.log[0]).toBe('initialize');
    expect(h.log[1]).toBe('loadOrder');
  });

  it('dispatchExisting NO llama initialize', async () => {
    const h = harness({});
    await dispatchExisting(h.store, h.sender, ORDER_ID);

    expect(h.initializeCalls).toBe(0);
    expect(h.log).not.toContain('initialize');
  });

  it('fallo de initialize no lanza y detiene el dispatch', async () => {
    const h = harness({ initializeThrows: true });
    const res = await initializeAndDispatch(h.store, h.sender, ORDER_ID);

    expect(res.reason).toBe('persistence_error');
    expect(h.log).toEqual(['initialize']);
  });
});

describe('resultado seguro', () => {
  it('nunca expone teléfono, phone_number_id, claim_token, wamid ni texto', async () => {
    const h = harness({});
    const res = await dispatchExisting(h.store, h.sender, ORDER_ID);
    const serialized = JSON.stringify(res);

    for (const secret of [PHONE, PNID, CONFIRM_TOKEN, LOCATION_TOKEN, 'wamid.', 'Recibí']) {
      expect(serialized).not.toContain(secret);
    }
    expect(Object.keys(res).sort()).toEqual(['confirmation', 'locationRequest', 'ok', 'orderId']);
  });
});

// ── 6D.2C: delivery dinámico — orden invertido y confirmación diferida ───────

/** Pedido dinámico esperando cotización (pending o failed). */
function dynamicPending(over: Partial<LoadedOrder> = {}): LoadedOrder {
  return order({
    delivery_type: 'delivery',
    status: 'awaiting_location',
    delivery_pricing: 'dynamic',
    delivery_quote_status: 'pending',
    subtotal_amount: 90,
    delivery_amount: 0,
    total_amount: 90,
    ...over,
  });
}

/** Pedido dinámico ya cotizado (confirmado, con solicitud de ubicación ya enviada). */
function dynamicQuoted(over: Partial<LoadedOrder> = {}): LoadedOrder {
  return order({
    delivery_type: 'delivery',
    status: 'confirmed',
    delivery_pricing: 'dynamic',
    delivery_quote_status: 'quoted',
    subtotal_amount: 90,
    delivery_amount: 16,
    total_amount: 106,
    location_request_message_id: 'wamid.LOC1',
    ...over,
  });
}

describe('dispatch dinámico — pending/failed: order_received → location, confirmation NO', () => {
  it('pending: envía order_received y LUEGO location_request; confirmation blocked_by_quote', async () => {
    const h = harness({ loaded: dynamicPending() });
    const res = await dispatchExisting(h.store, h.sender, ORDER_ID);

    expect(res.orderReceived).toBe('sent');
    expect(res.locationRequest).toBe('sent');
    expect(res.confirmation).toBe('blocked_by_quote');
    // Orden estricto: recepción (texto) antes que la solicitud de ubicación.
    expect(h.claimed).toEqual(['order_received', 'location_request']);
    expect(h.log.indexOf('sendText')).toBeLessThan(h.log.indexOf('sendLocationRequest'));
    expect(h.log).not.toContain('sendImage');
    // El texto de recepción, no una confirmación.
    expect(h.sentTexts[0]).toContain('Recibimos tu pedido');
  });

  it('failed: mismo comportamiento (order_received → location, confirmation diferida)', async () => {
    const h = harness({ loaded: dynamicPending({ delivery_quote_status: 'failed' }) });
    const res = await dispatchExisting(h.store, h.sender, ORDER_ID);

    expect(res.orderReceived).toBe('sent');
    expect(res.locationRequest).toBe('sent');
    expect(res.confirmation).toBe('blocked_by_quote');
    expect(h.claimed).toEqual(['order_received', 'location_request']);
  });

  it('order_received bloqueada (no sent) → location NO se adelanta', async () => {
    const h = harness({
      loaded: dynamicPending(),
      claims: { order_received: { claimed: false, reason: 'in_flight', status: 'sending' } },
    });
    const res = await dispatchExisting(h.store, h.sender, ORDER_ID);

    expect(res.locationRequest).toBe('blocked_by_order_received');
    expect(res.confirmation).toBe('blocked_by_quote');
    expect(h.claimed).toEqual(['order_received']); // no reclama location
    expect(h.log).not.toContain('sendLocationRequest');
  });
});

describe('dispatch dinámico — quoted: confirmation sí, sin reenviar ubicación', () => {
  it('cash: envía la confirmación con Comida/Delivery/Total y NO reenvía ubicación', async () => {
    const h = harness({ loaded: dynamicQuoted({ payment_method: 'cash' }) });
    const res = await dispatchExisting(h.store, h.sender, ORDER_ID);

    expect(res.confirmation).toBe('sent');
    expect(res.locationRequest).toBe('already_sent');
    expect(h.claimed).toEqual(['confirmation']);
    expect(h.log).not.toContain('sendLocationRequest');

    const text = h.sentTexts[0];
    expect(text).toContain('Comida: Bs. 90');
    expect(text).toContain('Delivery: Bs. 16');
    expect(text).toContain('Total: Bs. 106');
    // Nada de kilómetros ni fórmula.
    expect(text).not.toMatch(/km|kil[oó]metro|Mapbox|tarifa/i);
  });

  it('qr: envía imagen del QR con caption Comida/Delivery/Total + indicación de pago', async () => {
    const h = harness({ loaded: dynamicQuoted({ payment_method: 'qr' }) });
    const res = await dispatchExisting(h.store, h.sender, ORDER_ID);

    expect(res.confirmation).toBe('sent');
    expect(h.log).toContain('sendImage');
    const { caption } = h.sentImages[0];
    expect(caption).toContain('Comida: Bs. 90');
    expect(caption).toContain('Delivery: Bs. 16');
    expect(caption).toContain('Total: Bs. 106');
    expect(caption).toContain('Escanea este QR');
  });
});

describe('dispatch dinámico — out_of_coverage: nada que enviar', () => {
  it('confirmation bloqueada y ubicación no aplica', async () => {
    const h = harness({
      loaded: dynamicPending({ delivery_quote_status: 'out_of_coverage' }),
    });
    const res = await dispatchExisting(h.store, h.sender, ORDER_ID);

    expect(res.confirmation).toBe('blocked_by_quote');
    expect(res.locationRequest).toBe('not_applicable');
    expect(h.claimed).toEqual([]); // no reclama nada
    expect(h.log).not.toContain('sendText');
    expect(h.log).not.toContain('sendImage');
    expect(h.log).not.toContain('sendLocationRequest');
  });
});

describe('dispatchSingleNotification dinámico (worker tras la cotización)', () => {
  it('confirmation de un dinámico quoted se envía con el copy dinámico', async () => {
    const h = harness({ loaded: dynamicQuoted({ payment_method: 'cash' }) });
    const r = await dispatchSingleNotification(h.store, h.sender, ORDER_ID, 'confirmation');

    expect(r).toEqual({ notificationType: 'confirmation', outcome: 'sent', sendAttempted: true });
    expect(h.sentTexts[0]).toContain('Total: Bs. 106');
  });

  it('confirmation bloqueada por la RPC (quote_not_applied) → sin envío ni intento', async () => {
    const h = harness({
      loaded: dynamicPending(),
      claims: { confirmation: { claimed: false, reason: 'quote_not_applied' } },
    });
    const r = await dispatchSingleNotification(h.store, h.sender, ORDER_ID, 'confirmation');

    expect(r).toEqual({
      notificationType: 'confirmation',
      outcome: 'blocked_by_quote',
      sendAttempted: false,
    });
    expect(h.log).not.toContain('sendText');
    expect(h.log).not.toContain('sendImage');
  });
});
