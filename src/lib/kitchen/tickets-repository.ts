/**
 * Repositorio de cocina — modulo PURO con la fuente de datos INYECTADA.
 *
 * Misma forma que el repositorio del dashboard: la logica y la sanitizacion
 * viven aqui (testeables sin base), y el adaptador Supabase (server-only) solo
 * traduce consultas. La cocina LEE pedidos y escribe `orders.status`; nunca
 * toca `order_notifications`, Telegram, Kapso ni WhatsApp.
 */
import type { OrderStatus } from '@/types';
import { dateBounds } from '@/lib/dashboard/filters';
import {
  DISPATCHED_STATUSES,
  isKdsAction,
  nextStage,
  orderStatusForStage,
  stageFromOrderStatus,
  type KdsStage,
} from './kds-status';
import {
  toKitchenTickets,
  type KitchenTicket,
  type RawKitchenItemRow,
  type RawKitchenOrderRow,
} from './ticket-view';
import type { KitchenFailure } from './errors';

export type KitchenUpdateResult = 'updated' | 'conflict' | 'not_found';

export interface KitchenBoardRows {
  rows: RawKitchenOrderRow[];
  /** Items de TODOS los pedidos de la pagina, traidos en una sola consulta. */
  items: RawKitchenItemRow[];
}

/** Adaptador de datos. La implementacion real (Supabase) es server-only. */
export interface KitchenDataSource {
  listBoard(since: string | null, until: string | null): Promise<KitchenBoardRows>;
  getStatus(orderNumber: string): Promise<OrderStatus | null>;
  updateStatus(orderNumber: string, from: OrderStatus, to: OrderStatus): Promise<KitchenUpdateResult>;
}

/**
 * Respuesta del tablero. Solo viajan los tickets y el reloj del servidor: los
 * contadores y el resumen se DERIVAN de los tickets con funciones puras, para
 * que no exista una segunda fuente de verdad que sincronizar a mano.
 */
export interface KitchenBoard {
  tickets: KitchenTicket[];
  serverNow: number;
}

export type KitchenActionOutcome =
  | { ok: true; stage: KdsStage }
  | { ok: false; reason: KitchenFailure };

export interface KitchenRepository {
  getBoard(nowMs: number): Promise<KitchenBoard>;
  applyAction(orderNumber: string, action: string): Promise<KitchenActionOutcome>;
}

/** Formato del numero de pedido aceptado (misma whitelist que el dashboard). */
const ORDER_NUMBER_RE = /^[A-Za-z0-9-]{1,40}$/;

export function createKitchenRepository(source: KitchenDataSource): KitchenRepository {
  return {
    async getBoard(nowMs) {
      const { since, until } = dateBounds('today', nowMs);
      const { rows, items } = await source.listBoard(since, until);
      return { tickets: toKitchenTickets(rows, items), serverNow: nowMs };
    },

    async applyAction(orderNumber, action) {
      if (!ORDER_NUMBER_RE.test(orderNumber)) return { ok: false, reason: 'not_found' };
      if (!isKdsAction(action)) return { ok: false, reason: 'invalid_action' };

      const status = await source.getStatus(orderNumber);
      if (status === null) return { ok: false, reason: 'not_found' };
      // El encargado ya lo despacho: la cocina no lo recupera, y el cocinero
      // merece leerlo asi y no un error tecnico.
      if (DISPATCHED_STATUSES.includes(status)) return { ok: false, reason: 'dispatched' };

      const stage = stageFromOrderStatus(status);
      // `draft` / `awaiting_location`: aun no es cocinable, no esta en el tablero.
      if (stage === null) return { ok: false, reason: 'not_found' };
      if (stage === 'cancelled') return { ok: false, reason: 'cancelled' };

      const target = nextStage(stage, action);
      if (target === null) return { ok: false, reason: 'invalid_transition' };

      // Guarda optimista: solo escribe si el estado sigue siendo el que leimos,
      // para que dos cocineros tocando a la vez no se pisen.
      const res = await source.updateStatus(orderNumber, status, orderStatusForStage(target));
      if (res === 'updated') return { ok: true, stage: target };
      if (res === 'not_found') return { ok: false, reason: 'not_found' };
      return { ok: false, reason: 'conflict' };
    },
  };
}
