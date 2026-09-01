import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { DeliveryType, Order, OrderStatus } from '@/types';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import { createMenuRepository } from '@/lib/menu/repository';
import { calculateOrder, normalizeQuantity } from './calculate';
import type { CalculatedOrder, UpsertOrderDraftInput } from './types';
import {
  confirmOrderDraft,
  type ConfirmIfDraftResult,
  type ConfirmOrderInput,
  type ConfirmOrderResult,
  type DraftOrderRow,
  type OrderConfirmationStore,
} from './confirm';
import {
  ensureLocationRequest,
  type EnsureLocationResult,
  type LocationOrderRow,
  type LocationRequestStore,
} from './location';
import {
  attachLocation,
  attachLooseLocation,
  type AttachLocationInput,
  type AttachLocationResult,
  type AttachLocationStore,
  type AttachLooseLocationInput,
  type LocationOrderRow as LocationAttachRow,
} from './attach-location';
import { getKapsoClient } from '@/lib/kapso/client';
import { normalizePhone } from '@/lib/phone';

export interface UpsertOrderDraftResult {
  order: Order;
  calc: CalculatedOrder;
}

/** Código Postgres de violación de unicidad (source_message_id). */
const UNIQUE_VIOLATION = '23505';

const DRAFT_ROW_COLUMNS =
  'id, order_number, flow_token, customer_phone, delivery_type, status, source_message_id';

function toDraftRow(row: Record<string, unknown>): DraftOrderRow {
  return {
    id: row.id as string,
    order_number: row.order_number as string,
    flow_token: (row.flow_token as string | null) ?? null,
    customer_phone: row.customer_phone as string,
    delivery_type: row.delivery_type as DeliveryType,
    status: row.status as OrderStatus,
    source_message_id: (row.source_message_id as string | null) ?? null,
  };
}

/** Store de confirmación respaldado por Supabase (service_role). */
export function createSupabaseOrderConfirmationStore(
  supabase: SupabaseClient,
): OrderConfirmationStore {
  return {
    async findById(orderId: string): Promise<DraftOrderRow | null> {
      const { data, error } = await supabase
        .from('orders')
        .select(DRAFT_ROW_COLUMNS)
        .eq('id', orderId)
        .maybeSingle();
      if (error) throw new Error(`orders.findById: ${error.message}`);
      return data ? toDraftRow(data) : null;
    },

    async countItems(orderId: string): Promise<number> {
      const { count, error } = await supabase
        .from('order_items')
        .select('id', { count: 'exact', head: true })
        .eq('order_id', orderId);
      if (error) throw new Error(`orderItems.count: ${error.message}`);
      return count ?? 0;
    },

    async confirmIfDraft(input): Promise<ConfirmIfDraftResult> {
      const { data, error } = await supabase
        .from('orders')
        .update({
          status: input.newStatus,
          source_message_id: input.sourceMessageId,
          confirmed_at: input.confirmedAt,
        })
        .eq('id', input.orderId)
        .eq('status', 'draft')
        .is('source_message_id', null)
        .select(DRAFT_ROW_COLUMNS);

      if (error) {
        if (error.code === UNIQUE_VIOLATION) return { uniqueViolation: true };
        throw new Error(`orders.confirmIfDraft: ${error.message}`);
      }
      const rows = (data ?? []) as Record<string, unknown>[];
      return rows.length > 0 ? toDraftRow(rows[0]) : null;
    },
  };
}

/**
 * Confirma un borrador (server-only): construye el store Supabase y delega en la
 * lógica pura `confirmOrderDraft`.
 */
export function confirmDraftOrder(input: ConfirmOrderInput): Promise<ConfirmOrderResult> {
  const store = createSupabaseOrderConfirmationStore(getSupabaseAdmin());
  return confirmOrderDraft(store, input);
}

// ── Solicitud de ubicación (Fase 3.3A) ───────────────────────────────────

const LOCATION_ROW_COLUMNS = 'id, status, customer_phone, location_request_message_id';

function toLocationRow(row: Record<string, unknown>): LocationOrderRow {
  return {
    id: row.id as string,
    status: row.status as OrderStatus,
    customer_phone: row.customer_phone as string,
    location_request_message_id:
      (row.location_request_message_id as string | null) ?? null,
  };
}

/** Store de solicitud de ubicación respaldado por Supabase (service_role). */
export function createSupabaseLocationRequestStore(
  supabase: SupabaseClient,
): LocationRequestStore {
  return {
    async findForLocationRequest(orderId: string): Promise<LocationOrderRow | null> {
      const { data, error } = await supabase
        .from('orders')
        .select(LOCATION_ROW_COLUMNS)
        .eq('id', orderId)
        .maybeSingle();
      if (error) throw new Error(`orders.findForLocationRequest: ${error.message}`);
      return data ? toLocationRow(data) : null;
    },

    async saveLocationRequestMessageId(
      orderId: string,
      wamid: string,
    ): Promise<'saved' | 'no_rows'> {
      // Condicional (exactamente-una-vez): solo escribe si sigue awaiting_location
      // y sin solicitud previa. La ejecución perdedora no sobrescribe.
      const { data, error } = await supabase
        .from('orders')
        .update({ location_request_message_id: wamid })
        .eq('id', orderId)
        .eq('status', 'awaiting_location')
        .is('location_request_message_id', null)
        .select('id');
      if (error) {
        if (error.code === UNIQUE_VIOLATION) return 'no_rows';
        throw new Error(`orders.saveLocationRequestMessageId: ${error.message}`);
      }
      return (data?.length ?? 0) > 0 ? 'saved' : 'no_rows';
    },
  };
}

/**
 * Garantiza el envío idempotente de la solicitud de ubicación (server-only):
 * store Supabase + cliente real de Kapso, delegando en la lógica pura.
 */
export function ensureLocationRequestForOrder(orderId: string): Promise<EnsureLocationResult> {
  const store = createSupabaseLocationRequestStore(getSupabaseAdmin());
  const kapso = getKapsoClient();
  return ensureLocationRequest(store, (phone) => kapso.sendLocationRequest(phone), orderId);
}

// ── Asociación de ubicación entrante (Fase 3.3B) ─────────────────────────

const LOCATION_ATTACH_COLUMNS =
  'id, order_number, status, customer_phone, location_request_message_id, delivery_latitude, delivery_longitude, confirmed_at, delivery_pricing';

function toLocationAttachRow(row: Record<string, unknown>): LocationAttachRow {
  return {
    id: row.id as string,
    order_number: row.order_number as string,
    status: row.status as OrderStatus,
    customer_phone: row.customer_phone as string,
    location_request_message_id:
      (row.location_request_message_id as string | null) ?? null,
    delivery_latitude: (row.delivery_latitude as number | null) ?? null,
    delivery_longitude: (row.delivery_longitude as number | null) ?? null,
    confirmed_at: (row.confirmed_at as string | null) ?? null,
    delivery_pricing: (row.delivery_pricing as LocationAttachRow['delivery_pricing']) ?? null,
  };
}

/**
 * Cuánto tiempo sigue siendo "la ubicación de mi pedido" un pin que no responde
 * al botón (0028).
 *
 * No es un timeout técnico: es cuánto dura la intención. Dentro de la sesión en
 * la que alguien acaba de armar su pedido, un pin es la respuesta a lo que le
 * acabamos de pedir. Un día después ya no: sería alguien preguntando de nuevo
 * cuánto sale el envío, y adjuntarlo a un pedido olvidado le cambiaría el
 * destino a algo que ya no está mirando.
 */
const LOOSE_PIN_WINDOW_HOURS = 6;

/**
 * Cuántos pedidos recientes se miran para encontrar el de este teléfono.
 *
 * El filtro fino se hace EN MEMORIA porque los dos lados no están escritos
 * igual: `orders.customer_phone` guarda lo que llegó del checkout —con `+`,
 * espacios o guiones— y el webhook trae dígitos pelados. Un `.eq()` entre esos
 * dos no encontraría nunca nada, y el fallo sería mudo: el pedido seguiría
 * esperando y nadie vería un error.
 */
const LOOSE_PIN_CANDIDATES = 50;

/** Store de asociación de ubicación respaldado por Supabase (service_role). */
export function createSupabaseLocationAttachStore(
  supabase: SupabaseClient,
): AttachLocationStore {
  return {
    async findByLocationRequestMessageId(contextId: string): Promise<LocationAttachRow | null> {
      const { data, error } = await supabase
        .from('orders')
        .select(LOCATION_ATTACH_COLUMNS)
        .eq('location_request_message_id', contextId)
        .maybeSingle();
      if (error) throw new Error(`orders.findByLocationRequestMessageId: ${error.message}`);
      return data ? toLocationAttachRow(data) : null;
    },

    /**
     * 0028 — el pedido de este teléfono que sigue esperando ubicación.
     *
     * Se traen las candidatas de la ventana (pocas: `awaiting_location` sin GPS
     * es un estado de minutos) y se compara el teléfono normalizado en memoria,
     * igual que hace el reuso de distancias del ledger.
     *
     * El MÁS RECIENTE: si alguien armó dos pedidos seguidos, el pin contesta al
     * último, que es el que tiene delante.
     */
    async findAwaitingLocationByPhone(
      customerPhoneDigits: string,
    ): Promise<LocationAttachRow | null> {
      const desde = new Date(
        Date.now() - LOOSE_PIN_WINDOW_HOURS * 60 * 60 * 1000,
      ).toISOString();

      const { data, error } = await supabase
        .from('orders')
        .select(LOCATION_ATTACH_COLUMNS)
        .eq('status', 'awaiting_location')
        .is('delivery_latitude', null)
        .is('delivery_longitude', null)
        .gte('created_at', desde)
        .order('created_at', { ascending: false })
        .limit(LOOSE_PIN_CANDIDATES);
      if (error) throw new Error(`orders.findAwaitingLocationByPhone: ${error.message}`);

      const fila = ((data ?? []) as Record<string, unknown>[]).find(
        (f) => normalizePhone(String(f.customer_phone ?? '')) === customerPhoneDigits,
      );
      return fila ? toLocationAttachRow(fila) : null;
    },

    async attachIfPending(input): Promise<LocationAttachRow | null> {
      // Atómico: solo escribe si sigue awaiting_location y sin ubicación previa.
      // `confirmed_at` llega ya resuelto (coalesce en la capa pura): conserva el
      // valor previo si existía o sella el instante de esta confirmación.
      let q = supabase
        .from('orders')
        .update({
          delivery_latitude: input.latitude,
          delivery_longitude: input.longitude,
          delivery_address: input.address,
          delivery_location_name: input.name,
          status: 'confirmed',
          confirmed_at: input.confirmedAt,
        })
        .eq('id', input.orderId);

      // Con contexto, el wamid es un guard más. Sin él (pin suelto, 0028) el
      // claim son el estado y las coordenadas NULL — los mismos que ya impedían
      // la doble escritura cuando sí había contexto.
      if (input.contextId !== null) {
        q = q.eq('location_request_message_id', input.contextId);
      }

      const { data, error } = await q
        .eq('status', 'awaiting_location')
        .is('delivery_latitude', null)
        .is('delivery_longitude', null)
        .select(LOCATION_ATTACH_COLUMNS);

      if (error) throw new Error(`orders.attachIfPending: ${error.message}`);
      const rows = (data ?? []) as Record<string, unknown>[];
      return rows.length > 0 ? toLocationAttachRow(rows[0]) : null;
    },

    async attachIfPendingDynamic(input): Promise<LocationAttachRow | null> {
      // 6D.2C: guarda el GPS SIN tocar `status` ni `confirmed_at`. La condición
      // `delivery_latitude IS NULL` sigue siendo el claim implícito de una sola
      // escritura; el pedido permanece `awaiting_location` para que la cotización
      // lo confirme después.
      let q = supabase
        .from('orders')
        .update({
          delivery_latitude: input.latitude,
          delivery_longitude: input.longitude,
          delivery_address: input.address,
          delivery_location_name: input.name,
        })
        .eq('id', input.orderId);

      if (input.contextId !== null) {
        q = q.eq('location_request_message_id', input.contextId);
      }

      const { data, error } = await q
        .eq('status', 'awaiting_location')
        .is('delivery_latitude', null)
        .is('delivery_longitude', null)
        .select(LOCATION_ATTACH_COLUMNS);

      if (error) throw new Error(`orders.attachIfPendingDynamic: ${error.message}`);
      const rows = (data ?? []) as Record<string, unknown>[];
      return rows.length > 0 ? toLocationAttachRow(rows[0]) : null;
    },
  };
}

/**
 * Asocia la ubicación entrante a un pedido (server-only): store Supabase,
 * delegando en la lógica pura `attachLocation`.
 */
export function attachLocationForOrder(input: AttachLocationInput): Promise<AttachLocationResult> {
  const store = createSupabaseLocationAttachStore(getSupabaseAdmin());
  return attachLocation(store, input);
}

/**
 * Adjunta al pedido que estaba esperando el pin que llegó sin contexto (0028):
 * mismo store, misma escritura atómica, otra forma de encontrar el pedido.
 */
export function attachLooseLocationForOrder(
  input: AttachLooseLocationInput,
): Promise<AttachLocationResult> {
  const store = createSupabaseLocationAttachStore(getSupabaseAdmin());
  return attachLooseLocation(store, input);
}

/**
 * Crea o actualiza el borrador de un pedido a partir de las cantidades del Flow.
 *
 * - Los precios provienen de Supabase (nunca del cliente).
 * - Correlación por `flow_token` **único** (índice parcial `orders_flow_token_unique`):
 *   como mucho existe una fila por token, así que si ya existe se actualiza
 *   (reemplazando sus líneas) en vez de crear otra. El `status` NO se toca en la
 *   actualización para no revertir un pedido ya confirmado.
 * - No confirma el pedido (eso ocurre en el webhook, Fase 3).
 */
export async function upsertOrderDraft(
  input: UpsertOrderDraftInput,
): Promise<UpsertOrderDraftResult> {
  const supabase = getSupabaseAdmin();
  const menu = createMenuRepository(supabase);

  const menuItems = await menu.listActive();

  // Normaliza cantidades usando los códigos reales del menú activo.
  const quantitiesByCode: Record<string, number> = {};
  for (const item of menuItems) {
    quantitiesByCode[item.code] = normalizeQuantity(
      input.quantitiesByCode[item.code],
      item.code,
    );
  }

  const calc = calculateOrder(menuItems, quantitiesByCode, input.delivery_type);

  // Campos del borrador. `status` se establece SOLO en el insert (draft nuevo);
  // en el update se omite para no revertir un pedido ya confirmado.
  const draftFields = {
    customer_phone: input.customer_phone,
    customer_name: input.customer_name ?? null,
    delivery_type: input.delivery_type,
    notes: input.notes ?? null,
    subtotal_amount: calc.subtotal_amount,
    delivery_amount: calc.delivery_amount,
    total_amount: calc.total_amount,
    flow_token: input.flow_token,
    raw_flow_response: (input.rawFlowResponse ?? null) as never,
  };

  // Correlación por flow_token único: a lo sumo una fila.
  const { data: existing, error: findError } = await supabase
    .from('orders')
    .select('id')
    .eq('flow_token', input.flow_token)
    .maybeSingle();
  if (findError) throw new Error(`orders.findByFlowToken: ${findError.message}`);

  let orderId: string;

  if (existing) {
    orderId = existing.id as string;

    const { error: updateError } = await supabase
      .from('orders')
      .update(draftFields)
      .eq('id', orderId);
    if (updateError) throw new Error(`orders.updateDraft: ${updateError.message}`);

    const { error: deleteError } = await supabase
      .from('order_items')
      .delete()
      .eq('order_id', orderId);
    if (deleteError) throw new Error(`orderItems.clear: ${deleteError.message}`);
  } else {
    const { data: inserted, error: insertError } = await supabase
      .from('orders')
      .insert({ ...draftFields, status: 'draft' as const })
      .select('id')
      .single();
    if (insertError) throw new Error(`orders.insertDraft: ${insertError.message}`);
    orderId = inserted.id as string;
  }

  const itemRows = calc.lines.map((line) => ({ order_id: orderId, ...line }));
  const { error: itemsError } = await supabase.from('order_items').insert(itemRows);
  if (itemsError) throw new Error(`orderItems.insert: ${itemsError.message}`);

  const { data: order, error: fetchError } = await supabase
    .from('orders')
    .select('*')
    .eq('id', orderId)
    .single();
  if (fetchError) throw new Error(`orders.fetch: ${fetchError.message}`);

  return { order: order as Order, calc };
}
