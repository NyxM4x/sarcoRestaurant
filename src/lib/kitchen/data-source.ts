import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import type { OrderStatus } from '@/types';
import { KITCHEN_BOARD_STATUSES } from './kds-status';
import type { PaymentAttempt } from '@/types';
import type { ProofUiRow } from '@/lib/dashboard/proofs-data-source';
import type { RawKitchenItemRow, RawKitchenOrderRow } from './ticket-view';
import type {
  KitchenBoardRows,
  KitchenDataSource,
  KitchenPaymentRows,
  KitchenUpdateResult,
} from './tickets-repository';

/**
 * Adaptador Supabase (`service_role`) del tablero de cocina — server-only.
 *
 * La lista de columnas es la garantia dura de privacidad: telefono, direccion,
 * coordenadas y metodo de pago NO se piden, asi que no pueden filtrarse a la
 * pantalla de la cocina aunque alguien intentara pintarlos.
 *
 * Los importes SI se piden desde que cocina revisa los comprobantes: sin el
 * monto esperado, mirar un comprobante no es validarlo. Se piden `total_amount`
 * y `subtotal_amount` porque la cifra correcta depende del tipo de entrega —en
 * delivery por QR se cobra solo la comida— pero al ticket sale UNA sola,
 * calculada en `amountDueByQrOf`. Lo que no se pide sigue sin poder filtrarse.
 *
 * `draft` queda excluido por construccion: solo se leen los estados del tablero.
 * La unica escritura posible es `orders.status`, con guarda optimista. Nunca se
 * toca `order_notifications`.
 */
const KITCHEN_ORDER_COLUMNS =
  'id,order_number,status,delivery_type,notes,created_at,confirmed_at,updated_at,' +
  'total_amount,subtotal_amount,payment_method';

/** Techo de seguridad: el tablero nunca descarga la tabla entera. */
const MAX_BOARD_ROWS = 200;

/**
 * Columnas del pago para el KDS. Son EXACTAMENTE las del panel del encargado, y
 * eso es deliberado: quien decide desde cocina toma la misma decision y merece
 * los mismos datos. Una version recortada solo lograria que el mismo pago se
 * viera distinto segun la pantalla.
 *
 * Lo que sigue sin salir es lo de siempre: `storage_key` y `storage_namespace`
 * no entran, porque el navegador nunca debe ver donde vive el archivo. El unico
 * camino al fichero es el endpoint autenticado.
 */
const KITCHEN_ATTEMPT_COLUMNS =
  'id,order_id,review_status,opened_at,reviewed_at,created_at,updated_at';
const KITCHEN_PROOF_COLUMNS =
  'id,source_message_id,order_id,attempt_id,association_method,routing_exception,' +
  'declared_mime_type,verified_mime_type,safe_filename,duplicate_of_id,' +
  'capture_status,received_at,analysis_status';

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

    async listPayments(orderIds): Promise<KitchenPaymentRows> {
      if (orderIds.length === 0) return { attempts: [], proofs: [] };

      // DOS consultas para todo el tablero, no dos por ticket. Con el tablero
      // recargandose cada pocos segundos, una consulta por pedido convertiria
      // una pantalla de cocina en una tormenta contra la base.
      const [attemptsRes, proofsRes] = await Promise.all([
        client
          .from('payment_attempts')
          .select(KITCHEN_ATTEMPT_COLUMNS)
          .in('order_id', orderIds)
          .order('opened_at', { ascending: false }),
        client
          .from('payment_proofs')
          .select(KITCHEN_PROOF_COLUMNS)
          .in('order_id', orderIds)
          .order('received_at', { ascending: true }),
      ]);

      if (attemptsRes.error) throw new Error('kitchen_attempts_failed');
      if (proofsRes.error) throw new Error('kitchen_proofs_failed');

      return {
        attempts: (attemptsRes.data ?? []) as unknown as PaymentAttempt[],
        proofs: (proofsRes.data ?? []) as unknown as ProofUiRow[],
      };
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
