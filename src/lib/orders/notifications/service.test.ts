import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  createKapsoNotificationSender,
  createSupabaseNotificationStore,
  NotificationPersistenceError,
  ORDER_SELECT,
} from './service';
import { buildWebLocationRequestBodyText } from '@/lib/kapso/messages';
import { NOTIFICATION_SEND_TIMEOUT_MS } from './retry-policy';
import type { KapsoClient, KapsoSendResult } from '@/lib/kapso/transport';

const ORDER_ID = '22222222-2222-4222-8222-222222222222';
const NOTIF_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const TOKEN = 'bbbbbbbb-0000-4000-8000-000000000001';
const PHONE = '59170000000';
const PNID = 'pnid-sesion';

interface RpcCall {
  name: string;
  params: Record<string, unknown>;
}

/** Fake mínimo de Supabase: registra las RPC y devuelve lo configurado. */
function fakeSupabase(config: {
  order?: { data: unknown; error: unknown };
  rpc?: (name: string, params: Record<string, unknown>) => { data: unknown; error: unknown };
}) {
  const rpcCalls: RpcCall[] = [];
  const selects: string[] = [];
  const eqs: Array<[string, unknown]> = [];

  const client = {
    from() {
      const chain = {
        select(columns: string) {
          selects.push(columns);
          return chain;
        },
        eq(column: string, value: unknown) {
          eqs.push([column, value]);
          return chain;
        },
        async maybeSingle() {
          return config.order ?? { data: null, error: null };
        },
      };
      return chain;
    },
    async rpc(name: string, params: Record<string, unknown>) {
      rpcCalls.push({ name, params });
      return config.rpc ? config.rpc(name, params) : { data: null, error: null };
    },
  };

  return { client: client as unknown as SupabaseClient, rpcCalls, selects, eqs };
}

function orderRow(overrides: Record<string, unknown> = {}) {
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
    menu_session_id: '11111111-1111-4111-8111-111111111111',
    location_request_message_id: null,
    // Alias explícitos del select (menu_session / items).
    menu_session: { phone_number_id: PNID },
    items: [
      { product_name_snapshot: 'La Fija', quantity: 2, subtotal: 80 },
      { product_name_snapshot: 'Coca Cola', quantity: 1, subtotal: 10 },
    ],
    ...overrides,
  };
}

describe('createSupabaseNotificationStore.loadOrder', () => {
  it('obtiene phone_number_id desde menu_sessions y mapea el pedido', async () => {
    const sb = fakeSupabase({ order: { data: orderRow(), error: null } });
    const loaded = await createSupabaseNotificationStore(sb.client).loadOrder(ORDER_ID);

    expect(loaded).not.toBeNull();
    expect(loaded?.phone_number_id).toBe(PNID);
    expect(loaded?.customer_phone).toBe(PHONE);
    expect(loaded?.delivery_type).toBe('delivery');
    expect(loaded?.items).toHaveLength(2);
    expect(sb.eqs).toEqual([['id', ORDER_ID]]);
  });

  it('el select declara la relación por la FK exacta de 0003 y los alias', () => {
    // La FK explícita evita depender de la inferencia de PostgREST.
    expect(ORDER_SELECT).toContain('menu_sessions!orders_menu_session_id_fk');
    expect(ORDER_SELECT).toContain('menu_session:menu_sessions!orders_menu_session_id_fk');
    expect(ORDER_SELECT).toContain('order_items');
    expect(ORDER_SELECT).toContain('items:order_items');
  });

  it('el select incluye los campos mínimos requeridos', () => {
    const required = [
      'id',
      'order_number',
      'customer_phone',
      'customer_name',
      'delivery_type',
      'status',
      'subtotal_amount',
      'delivery_amount',
      'total_amount',
      'menu_session_id',
      'location_request_message_id',
      'phone_number_id',
      'product_name_snapshot',
      'quantity',
      'subtotal',
    ];
    for (const field of required) {
      expect(ORDER_SELECT).toContain(field);
    }
  });

  it('la consulta usa exactamente el select declarado', async () => {
    const sb = fakeSupabase({ order: { data: orderRow(), error: null } });
    await createSupabaseNotificationStore(sb.client).loadOrder(ORDER_ID);
    expect(sb.selects).toEqual([ORDER_SELECT]);
  });

  it('acepta el embed de sesión como array (variante de PostgREST)', async () => {
    const sb = fakeSupabase({
      order: { data: orderRow({ menu_session: [{ phone_number_id: PNID }] }), error: null },
    });
    const loaded = await createSupabaseNotificationStore(sb.client).loadOrder(ORDER_ID);
    expect(loaded?.phone_number_id).toBe(PNID);
  });

  it('no recibe el teléfono del caller: solo acepta orderId', async () => {
    const sb = fakeSupabase({ order: { data: orderRow(), error: null } });
    const store = createSupabaseNotificationStore(sb.client);
    // La firma admite exactamente un argumento.
    expect(store.loadOrder.length).toBe(1);
    const loaded = await store.loadOrder(ORDER_ID);
    // El teléfono proviene de la fila, no de un parámetro.
    expect(loaded?.customer_phone).toBe(PHONE);
  });

  it('pedido inexistente -> null', async () => {
    const sb = fakeSupabase({ order: { data: null, error: null } });
    expect(await createSupabaseNotificationStore(sb.client).loadOrder(ORDER_ID)).toBeNull();
  });

  it('pedido sin menu_session_id (WhatsApp Flow) -> null', async () => {
    const sb = fakeSupabase({
      order: { data: orderRow({ menu_session_id: null, menu_session: null }), error: null },
    });
    expect(await createSupabaseNotificationStore(sb.client).loadOrder(ORDER_ID)).toBeNull();
  });

  it('phone_number_id ausente o vacío -> null', async () => {
    const missing = fakeSupabase({
      order: { data: orderRow({ menu_session: null }), error: null },
    });
    expect(await createSupabaseNotificationStore(missing.client).loadOrder(ORDER_ID)).toBeNull();

    const empty = fakeSupabase({
      order: { data: orderRow({ menu_session: { phone_number_id: '   ' } }), error: null },
    });
    expect(await createSupabaseNotificationStore(empty.client).loadOrder(ORDER_ID)).toBeNull();
  });

  it('error de Supabase -> persistence_error sanitizado', async () => {
    const sb = fakeSupabase({
      order: { data: null, error: { message: 'relation "orders" does not exist', code: '42P01' } },
    });
    const store = createSupabaseNotificationStore(sb.client);

    await expect(store.loadOrder(ORDER_ID)).rejects.toBeInstanceOf(NotificationPersistenceError);
    await expect(store.loadOrder(ORDER_ID)).rejects.toThrow('persistence_error');
    // El detalle técnico de Supabase no se propaga.
    await expect(store.loadOrder(ORDER_ID)).rejects.not.toThrow('relation');
  });
});

describe('createSupabaseNotificationStore — mapeo de RPC', () => {
  it('initialize invoca initialize_order_notifications con el order_id', async () => {
    const sb = fakeSupabase({ rpc: () => ({ data: { initialized: true }, error: null }) });
    await createSupabaseNotificationStore(sb.client).initialize(ORDER_ID);

    expect(sb.rpcCalls).toEqual([
      { name: 'initialize_order_notifications', params: { p_order_id: ORDER_ID } },
    ]);
  });

  it('claim mapea un claim otorgado', async () => {
    const sb = fakeSupabase({
      rpc: () => ({
        data: { claimed: true, notification_id: NOTIF_ID, claim_token: TOKEN, attempt_count: 1 },
        error: null,
      }),
    });
    const res = await createSupabaseNotificationStore(sb.client).claim(ORDER_ID, 'confirmation');

    expect(res).toEqual({ claimed: true, notificationId: NOTIF_ID, claimToken: TOKEN });
    expect(sb.rpcCalls[0]).toEqual({
      name: 'claim_order_notification',
      params: { p_order_id: ORDER_ID, p_notification_type: 'confirmation' },
    });
  });

  it('claim mapea un claim denegado con status y con reason', async () => {
    const sent = fakeSupabase({ rpc: () => ({ data: { claimed: false, status: 'sent' }, error: null }) });
    expect(await createSupabaseNotificationStore(sent.client).claim(ORDER_ID, 'confirmation')).toEqual(
      { claimed: false, status: 'sent', reason: undefined },
    );

    const notInit = fakeSupabase({
      rpc: () => ({ data: { claimed: false, reason: 'not_initialized' }, error: null }),
    });
    expect(
      await createSupabaseNotificationStore(notInit.client).claim(ORDER_ID, 'location_request'),
    ).toEqual({ claimed: false, status: undefined, reason: 'not_initialized' });
  });

  it('markConfirmationSent y markLocationSent usan sus RPC y parámetros', async () => {
    const sb = fakeSupabase({ rpc: () => ({ data: true, error: null }) });
    const store = createSupabaseNotificationStore(sb.client);

    expect(await store.markConfirmationSent(NOTIF_ID, TOKEN, 'wamid.CONF')).toBe(true);
    expect(await store.markLocationSent(NOTIF_ID, TOKEN, 'wamid.LOC')).toBe(true);

    expect(sb.rpcCalls[0]).toEqual({
      name: 'mark_order_notification_sent',
      params: {
        p_notification_id: NOTIF_ID,
        p_claim_token: TOKEN,
        p_external_message_id: 'wamid.CONF',
      },
    });
    expect(sb.rpcCalls[1]).toEqual({
      name: 'mark_location_request_sent',
      params: { p_notification_id: NOTIF_ID, p_claim_token: TOKEN, p_wamid: 'wamid.LOC' },
    });
  });

  it('markFailed envía solo el código corto', async () => {
    const sb = fakeSupabase({ rpc: () => ({ data: false, error: null }) });
    expect(
      await createSupabaseNotificationStore(sb.client).markFailed(NOTIF_ID, TOKEN, 'timeout'),
    ).toBe(false);

    expect(sb.rpcCalls[0]).toEqual({
      name: 'mark_order_notification_failed',
      params: { p_notification_id: NOTIF_ID, p_claim_token: TOKEN, p_error_code: 'timeout' },
    });
  });

  it('error de Supabase en cualquier RPC -> persistence_error', async () => {
    const sb = fakeSupabase({
      rpc: () => ({ data: null, error: { message: 'permission denied for function', code: '42501' } }),
    });
    const store = createSupabaseNotificationStore(sb.client);

    await expect(store.initialize(ORDER_ID)).rejects.toThrow('persistence_error');
    await expect(store.claim(ORDER_ID, 'confirmation')).rejects.toThrow('persistence_error');
    await expect(store.markConfirmationSent(NOTIF_ID, TOKEN, 'w')).rejects.toThrow('persistence_error');
    await expect(store.markLocationSent(NOTIF_ID, TOKEN, 'w')).rejects.toThrow('persistence_error');
    await expect(store.markFailed(NOTIF_ID, TOKEN, 'timeout')).rejects.toThrow('persistence_error');
    // Nunca se filtra el mensaje original.
    await expect(store.claim(ORDER_ID, 'confirmation')).rejects.not.toThrow('permission denied');
  });
});

describe('createSupabaseNotificationStore — respuestas malformadas', () => {
  it('claim con forma inesperada se rechaza de forma segura', async () => {
    for (const data of [null, 'ok', 42, {}, { claimed: 'yes' }]) {
      const sb = fakeSupabase({ rpc: () => ({ data, error: null }) });
      await expect(
        createSupabaseNotificationStore(sb.client).claim(ORDER_ID, 'confirmation'),
      ).rejects.toBeInstanceOf(NotificationPersistenceError);
    }
  });

  it('claim otorgado sin notification_id o claim_token se rechaza', async () => {
    const sb = fakeSupabase({
      rpc: () => ({ data: { claimed: true, notification_id: NOTIF_ID }, error: null }),
    });
    await expect(
      createSupabaseNotificationStore(sb.client).claim(ORDER_ID, 'confirmation'),
    ).rejects.toBeInstanceOf(NotificationPersistenceError);
  });

  it('mark_* que no devuelve boolean se rechaza', async () => {
    const sb = fakeSupabase({ rpc: () => ({ data: 'true', error: null }) });
    const store = createSupabaseNotificationStore(sb.client);

    await expect(store.markConfirmationSent(NOTIF_ID, TOKEN, 'w')).rejects.toBeInstanceOf(
      NotificationPersistenceError,
    );
    await expect(store.markLocationSent(NOTIF_ID, TOKEN, 'w')).rejects.toBeInstanceOf(
      NotificationPersistenceError,
    );
    await expect(store.markFailed(NOTIF_ID, TOKEN, 'timeout')).rejects.toBeInstanceOf(
      NotificationPersistenceError,
    );
  });
});

describe('createKapsoNotificationSender', () => {
  interface SendTextCall {
    phone: string;
    text: string;
    options?: { phoneNumberId?: string | null; timeoutMs?: number };
  }
  interface SendLocationCall {
    phone: string;
    options?: { phoneNumberId?: string | null; bodyText?: string; timeoutMs?: number };
  }

  function fakeKapso(result: KapsoSendResult) {
    const textCalls: SendTextCall[] = [];
    const locationCalls: SendLocationCall[] = [];
    const client = {
      async sendText(phone: string, text: string, options?: SendTextCall['options']) {
        textCalls.push({ phone, text, options });
        return result;
      },
      async sendLocationRequest(phone: string, options?: SendLocationCall['options']) {
        locationCalls.push({ phone, options });
        return result;
      },
      async sendMenuCtaUrl() {
        throw new Error('no usado');
      },
    };
    return { client: client as unknown as KapsoClient, textCalls, locationCalls };
  }

  it('sendText pasa el phone_number_id de la sesión, 20 s y devuelve el wamid', async () => {
    const k = fakeKapso({ ok: true, wamid: 'wamid.CONF' });
    const res = await createKapsoNotificationSender(k.client).sendText(PHONE, 'Hola', PNID);

    expect(res).toEqual({ ok: true, wamid: 'wamid.CONF' });
    expect(k.textCalls).toEqual([
      {
        phone: PHONE,
        text: 'Hola',
        options: { phoneNumberId: PNID, timeoutMs: NOTIFICATION_SEND_TIMEOUT_MS },
      },
    ]);
    expect(NOTIFICATION_SEND_TIMEOUT_MS).toBe(20_000);
  });

  it('sendLocationRequest usa el copy con order_number, el phone_number_id y 20 s', async () => {
    const k = fakeKapso({ ok: true, wamid: 'wamid.LOC' });
    const res = await createKapsoNotificationSender(k.client).sendLocationRequest(
      PHONE,
      PNID,
      'ORD-000006',
    );

    expect(res).toEqual({ ok: true, wamid: 'wamid.LOC' });
    expect(k.locationCalls).toEqual([
      {
        phone: PHONE,
        options: {
          phoneNumberId: PNID,
          bodyText: buildWebLocationRequestBodyText('ORD-000006'),
          timeoutMs: NOTIFICATION_SEND_TIMEOUT_MS,
        },
      },
    ]);
    expect(k.locationCalls[0].options?.bodyText).toContain('ORD-000006');
  });

  it('propaga el código de error de Kapso sin detalles adicionales', async () => {
    const k = fakeKapso({ ok: false, error: 'timeout' });
    const sender = createKapsoNotificationSender(k.client);

    expect(await sender.sendText(PHONE, 'Hola', PNID)).toEqual({ ok: false, error: 'timeout' });
    expect(await sender.sendLocationRequest(PHONE, PNID, 'ORD-000006')).toEqual({
      ok: false,
      error: 'timeout',
    });
  });

  it('el error http no arrastra el status ni cuerpos', async () => {
    const k = fakeKapso({ ok: false, error: 'http_error', status: 503 });
    const res = await createKapsoNotificationSender(k.client).sendText(PHONE, 'Hola', PNID);

    expect(res).toEqual({ ok: false, error: 'http_error' });
    expect(JSON.stringify(res)).not.toContain('503');
  });
});
