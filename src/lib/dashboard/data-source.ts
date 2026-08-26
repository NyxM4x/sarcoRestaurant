import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import type { OrderStatus, DeliveryType } from '@/types';
import type { StatusCounts, RawOrderRow, OrderNotificationFlags } from './order-view';
import type {
  OrdersDataSource,
  ListSpec,
  ListRows,
  DetailRows,
  UpdateResult,
} from './orders-repository';

/**
 * Adaptador Supabase (`service_role`) de `OrdersDataSource` — server-only.
 *
 * Fino a proposito: solo traduce specs a consultas PostgREST. Toda la logica y
 * la sanitizacion viven en el repositorio puro. NUNCA escribe en
 * order_notifications; solo actualiza `orders.status` con guarda optimista.
 */

const ORDER_COLUMNS =
  'id,order_number,customer_name,customer_phone,delivery_type,status,' +
  'subtotal_amount,delivery_amount,total_amount,currency,notes,payment_method,' +
  'delivery_address,delivery_location_name,delivery_latitude,delivery_longitude,' +
  // 6D.2D: estado de cotización dinámica (solo lectura) para el dashboard.
  'delivery_pricing,delivery_quote_status,delivery_distance_meters,' +
  'created_at,updated_at,confirmed_at';

/**
 * Estados que NUNCA se muestran en el dashboard operativo. `draft` es un
 * borrador del WhatsApp Flow que el cliente aún no confirmó: no debe llegarle al
 * encargado por ninguna vía (lista, búsqueda, filtros ni contadores). Se excluye
 * en el nivel de lectura para que sea una garantía central, no solo visual. El
 * estado sigue existiendo en la base y en el pipeline del Flow, intactos.
 */
export const DASHBOARD_HIDDEN_STATUSES = ['draft'] as const;

/** Deriva banderas sanitizadas desde las filas de notificacion de un pedido. */
function flagsFrom(
  notifs: Array<{ manual_review_required: boolean | null; terminal_at: string | null; status: string | null }>,
): OrderNotificationFlags {
  let manualReview = false;
  let notificationIssue = false;
  for (const n of notifs) {
    if (n.manual_review_required) manualReview = true;
    if (n.terminal_at !== null || n.status === 'failed') notificationIssue = true;
  }
  return { manualReview, notificationIssue };
}

export function createSupabaseOrdersDataSource(
  client: SupabaseClient = getSupabaseAdmin(),
): OrdersDataSource {
  return {
    async listOrders(spec: ListSpec): Promise<ListRows> {
      let q = client
        .from('orders')
        .select(ORDER_COLUMNS)
        .order('created_at', { ascending: false })
        .range(spec.offset, spec.offset + spec.limit - 1);

      // Garantía central: los borradores del Flow nunca entran al dashboard.
      for (const hidden of DASHBOARD_HIDDEN_STATUSES) q = q.neq('status', hidden);
      // Filtro operativo: conjunto de estados internos (uno o varios) vía `.in`.
      // Mantiene intactos order/range (paginación) y el `.or` de búsqueda.
      if (spec.statuses && spec.statuses.length > 0) q = q.in('status', spec.statuses);
      if (spec.deliveryType) q = q.eq('delivery_type', spec.deliveryType);
      if (spec.since) q = q.gte('created_at', spec.since);
      if (spec.until) q = q.lt('created_at', spec.until);
      if (spec.search) {
        const term = `%${spec.search}%`;
        q = q.or(`order_number.ilike.${term},customer_name.ilike.${term}`);
      }

      const { data, error } = await q;
      if (error) throw new Error('list_failed');
      const rows = (data ?? []) as unknown as RawOrderRow[];
      const ids = rows.map((r) => r.id);

      const itemCounts: Record<string, number> = {};
      const flags: Record<string, OrderNotificationFlags> = {};
      const pendingPayment = new Set<string>();
      if (ids.length > 0) {
        // Una sola consulta más para los pagos pendientes de TODA la página
        // (nada de una consulta por tarjeta).
        const [{ data: itemRows }, { data: notifRows }, { data: pendingRows }] = await Promise.all([
          client.from('order_items').select('order_id').in('order_id', ids),
          client
            .from('order_notifications')
            .select('order_id,manual_review_required,terminal_at,status')
            .in('order_id', ids),
          client
            .from('payment_attempts')
            .select('order_id')
            .in('order_id', ids)
            .eq('review_status', 'pending_review'),
        ]);
        for (const p of (pendingRows ?? []) as Array<{ order_id: string }>) {
          pendingPayment.add(p.order_id);
        }
        for (const it of (itemRows ?? []) as Array<{ order_id: string }>) {
          itemCounts[it.order_id] = (itemCounts[it.order_id] ?? 0) + 1;
        }
        const grouped: Record<string, Array<{ manual_review_required: boolean | null; terminal_at: string | null; status: string | null }>> = {};
        for (const nr of (notifRows ?? []) as Array<{ order_id: string; manual_review_required: boolean | null; terminal_at: string | null; status: string | null }>) {
          (grouped[nr.order_id] ??= []).push(nr);
        }
        for (const id of ids) flags[id] = flagsFrom(grouped[id] ?? []);
      }

      return { rows, itemCounts, flags, pendingPayment };
    },

    async countsByStatus(since, until): Promise<StatusCounts> {
      let q = client.from('orders').select('status').limit(2000);
      // Los borradores no cuentan en NINGÚN resumen (ni "Pedidos de hoy").
      for (const hidden of DASHBOARD_HIDDEN_STATUSES) q = q.neq('status', hidden);
      if (since) q = q.gte('created_at', since);
      if (until) q = q.lt('created_at', until);
      const { data, error } = await q;
      if (error) throw new Error('counts_failed');
      const counts: StatusCounts = {};
      for (const r of (data ?? []) as Array<{ status: OrderStatus }>) {
        counts[r.status] = (counts[r.status] ?? 0) + 1;
      }
      return counts;
    },

    async getDetail(orderNumber): Promise<DetailRows | null> {
      const { data: orderRows, error } = await client
        .from('orders')
        .select(ORDER_COLUMNS)
        .eq('order_number', orderNumber)
        .limit(1);
      if (error) throw new Error('detail_failed');
      const row = (orderRows ?? [])[0] as unknown as RawOrderRow | undefined;
      if (!row) return null;

      const [{ data: items }, { data: notifs }] = await Promise.all([
        client
          .from('order_items')
          .select('product_name_snapshot,unit_price_snapshot,quantity,subtotal')
          .eq('order_id', row.id)
          .order('created_at', { ascending: true }),
        client
          .from('order_notifications')
          .select('manual_review_required,terminal_at,status')
          .eq('order_id', row.id),
      ]);

      return {
        row,
        items: (items ?? []) as DetailRows['items'],
        flags: flagsFrom(
          (notifs ?? []) as Array<{ manual_review_required: boolean | null; terminal_at: string | null; status: string | null }>,
        ),
      };
    },

    async getMeta(orderNumber): Promise<{ status: OrderStatus; deliveryType: DeliveryType } | null> {
      const { data, error } = await client
        .from('orders')
        .select('status,delivery_type')
        .eq('order_number', orderNumber)
        .limit(1);
      if (error) throw new Error('meta_failed');
      const row = (data ?? [])[0] as { status: OrderStatus; delivery_type: DeliveryType } | undefined;
      if (!row) return null;
      return { status: row.status, deliveryType: row.delivery_type };
    },

    async updateStatus(orderNumber, from, to): Promise<UpdateResult> {
      // Guarda optimista: solo cambia si el estado sigue siendo `from`.
      const { data, error } = await client
        .from('orders')
        .update({ status: to })
        .eq('order_number', orderNumber)
        .eq('status', from)
        .select('order_number');
      if (error) throw new Error('update_failed');
      return (data ?? []).length === 1 ? 'updated' : 'conflict';
    },
  };
}
