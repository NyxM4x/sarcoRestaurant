import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import type { OrderStatus } from '@/types';
import { KITCHEN_BOARD_STATUSES } from './kds-status';
import type { RawKitchenItemRow, RawKitchenOrderRow } from './ticket-view';
import type { KitchenBoardRows, KitchenDataSource, KitchenUpdateResult } from './tickets-repository';

/**
 * Adaptador Supabase (`service_role`) del tablero de cocina — server-only.
 *
 * La lista de columnas es la garantia dura de privacidad: telefono, direccion,
 * coordenadas, importes y metodo de pago NO se piden, asi que no pueden
 * filtrarse a la pantalla de la cocina aunque alguien intentara pintarlos.
 *
 * `draft` queda excluido por construccion: solo se leen los estados del tablero.
 * La unica escritura posible es `orders.status`, con guarda optimista. Nunca se
 * toca `order_notifications`.
 */
const KITCHEN_ORDER_COLUMNS =
  'id,order_number,status,delivery_type,notes,created_at,confirmed_at,updated_at';

/** Techo de seguridad: el tablero nunca descarga la tabla entera. */
const MAX_BOARD_ROWS = 200;

export function createSupabaseKitchenDataSource(
  client: SupabaseClient = getSupabaseAdmin(),
): KitchenDataSource {
  return {
    async listBoard(since, until): Promise<KitchenBoardRows> {
      let q = client
        .from('orders')
        .select(KITCHEN_ORDER_COLUMNS)
        .in('status', [...KITCHEN_BOARD_STATUSES])
        .order('created_at', { ascending: false })
        .limit(MAX_BOARD_ROWS);
      if (since) q = q.gte('created_at', since);
      if (until) q = q.lt('created_at', until);

      const { data, error } = await q;
      if (error) throw new Error('kitchen_list_failed');
      const rows = (data ?? []) as unknown as RawKitchenOrderRow[];

      const ids = rows.map((r) => r.id);
      if (ids.length === 0) return { rows, items: [] };

      // Una SOLA consulta para los items de todos los pedidos del tablero.
      const { data: itemRows, error: itemsError } = await client
        .from('order_items')
        .select('order_id,product_name_snapshot,quantity')
        .in('order_id', ids);
      if (itemsError) throw new Error('kitchen_items_failed');

      return { rows, items: (itemRows ?? []) as unknown as RawKitchenItemRow[] };
    },

    async getStatus(orderNumber): Promise<OrderStatus | null> {
      const { data, error } = await client
        .from('orders')
        .select('status')
        .eq('order_number', orderNumber)
        .limit(1);
      if (error) throw new Error('kitchen_status_failed');
      const row = (data ?? [])[0] as { status: OrderStatus } | undefined;
      return row?.status ?? null;
    },

    async updateStatus(orderNumber, from, to): Promise<KitchenUpdateResult> {
      // Guarda optimista: solo cambia si el estado sigue siendo `from`.
      const { data, error } = await client
        .from('orders')
        .update({ status: to })
        .eq('order_number', orderNumber)
        .eq('status', from)
        .select('order_number');
      if (error) throw new Error('kitchen_update_failed');
      return (data ?? []).length === 1 ? 'updated' : 'conflict';
    },
  };
}
