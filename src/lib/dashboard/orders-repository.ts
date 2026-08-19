/**
 * Repositorio del dashboard — modulo PURO con fuente de datos INYECTADA.
 *
 * Toda la sanitizacion y la validacion de transiciones viven aqui; la fuente
 * (`OrdersDataSource`) es un adaptador fino sobre Supabase que se inyecta desde
 * la capa server-only. Asi la logica se testea sin base de datos y el navegador
 * nunca ve el cliente `service_role`.
 */
import type { OrderStatus, DeliveryType } from '@/types';
import {
  type RawOrderRow,
  type RawOrderItemRow,
  type OrderNotificationFlags,
  type OrderListItem,
  type OrderDetail,
  type OrderSummary,
  type StatusCounts,
  toOrderListItem,
  toOrderDetail,
  summarize,
} from './order-view';
import { isValidTransition, isTerminalStatus } from './status';
import { dateBounds, type OrderFilters } from './filters';

export interface ListSpec {
  /** Conjunto de estados internos a incluir (`null` = todos). Se aplica con `.in`. */
  statuses: OrderStatus[] | null;
  deliveryType: DeliveryType | null;
  since: string | null;
  until: string | null;
  search: string | null;
  limit: number;
  offset: number;
}

export interface ListRows {
  rows: RawOrderRow[];
  /** Conteo de items por order id. */
  itemCounts: Record<string, number>;
  /** Banderas de notificacion por order id (sanitizadas). */
  flags: Record<string, OrderNotificationFlags>;
}

export interface DetailRows {
  row: RawOrderRow;
  items: RawOrderItemRow[];
  flags: OrderNotificationFlags;
}

export type UpdateResult = 'updated' | 'conflict' | 'not_found';

/** Adaptador de datos. La implementacion real (Supabase) es server-only. */
export interface OrdersDataSource {
  listOrders(spec: ListSpec): Promise<ListRows>;
  countsByStatus(since: string | null, until: string | null): Promise<StatusCounts>;
  getDetail(orderNumber: string): Promise<DetailRows | null>;
  getMeta(orderNumber: string): Promise<{ status: OrderStatus; deliveryType: DeliveryType } | null>;
  updateStatus(orderNumber: string, from: OrderStatus, to: OrderStatus): Promise<UpdateResult>;
}

export interface OrdersListResult {
  summary: OrderSummary;
  orders: OrderListItem[];
  hasMore: boolean;
  limit: number;
  offset: number;
}

export type UpdateStatusOutcome =
  | { ok: true; status: OrderStatus }
  | { ok: false; reason: 'not_found' | 'terminal' | 'invalid_transition' | 'conflict' };

const NO_FLAGS: OrderNotificationFlags = { manualReview: false, notificationIssue: false };

function sumCounts(counts: StatusCounts): number {
  return Object.values(counts).reduce((a, b) => a + (b ?? 0), 0);
}

export interface OrdersRepository {
  getList(filters: OrderFilters, now: number): Promise<OrdersListResult>;
  getDetail(orderNumber: string): Promise<OrderDetail | null>;
  updateStatus(orderNumber: string, to: OrderStatus): Promise<UpdateStatusOutcome>;
}

export function createOrdersRepository(source: OrdersDataSource): OrdersRepository {
  return {
    async getList(filters, now) {
      const listBounds = dateBounds(filters.dateRange, now);
      // El resumen es SIEMPRE el snapshot de HOY, independiente del filtro de fecha.
      const today = dateBounds('today', now);

      // Se pide limit+1 para saber si hay mas sin descargar toda la tabla.
      const spec: ListSpec = {
        statuses: filters.statuses,
        deliveryType: filters.deliveryType,
        since: listBounds.since,
        until: listBounds.until,
        search: filters.search,
        limit: filters.limit + 1,
        offset: filters.offset,
      };

      const [list, counts] = await Promise.all([
        source.listOrders(spec),
        source.countsByStatus(today.since, today.until),
      ]);

      const hasMore = list.rows.length > filters.limit;
      const pageRows = hasMore ? list.rows.slice(0, filters.limit) : list.rows;
      const orders = pageRows.map((row) =>
        toOrderListItem(row, list.itemCounts[row.id] ?? 0, list.flags[row.id] ?? NO_FLAGS),
      );

      return {
        summary: summarize(counts, sumCounts(counts)),
        orders,
        hasMore,
        limit: filters.limit,
        offset: filters.offset,
      };
    },

    async getDetail(orderNumber) {
      const d = await source.getDetail(orderNumber);
      if (!d) return null;
      return toOrderDetail(d.row, d.items, d.flags);
    },

    async updateStatus(orderNumber, to) {
      const meta = await source.getMeta(orderNumber);
      if (!meta) return { ok: false, reason: 'not_found' };
      if (isTerminalStatus(meta.status)) return { ok: false, reason: 'terminal' };
      if (!isValidTransition(meta.status, to, meta.deliveryType)) {
        return { ok: false, reason: 'invalid_transition' };
      }
      // Concurrencia optimista: la fuente actualiza SOLO si el estado sigue siendo
      // `from` (evita doble clic / actualizacion sobre un estado ya cambiado).
      const res = await source.updateStatus(orderNumber, meta.status, to);
      if (res === 'updated') return { ok: true, status: to };
      if (res === 'not_found') return { ok: false, reason: 'not_found' };
      return { ok: false, reason: 'conflict' };
    },
  };
}
