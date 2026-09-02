import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import type { MenuCategory, OrderStatus, PaymentMethod } from '@/types';
import { KITCHEN_BOARD_STATUSES } from './kds-status';
import type { PaymentAttempt } from '@/types';
import type { ProofUiRow } from '@/lib/dashboard/proofs-data-source';
import {
  promotionsToKitchenLines,
  type KitchenPromotionRow,
} from '@/lib/promotions/kitchen-lines';
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
/**
 * Las tres columnas del análisis van JUNTAS, y hace falta que estén las tres.
 *
 * Faltaban `analysis_verdict` y `analysis_reasons` (29-08-2026). Con solo el
 * `analysis_status`, `toAnalysisView` encontraba el 'done' y se quedaba sin
 * veredicto que leer, así que devolvía `null` y el aviso del ticket NO se
 * pintaba nunca: el análisis detectaba el comprobante falso, lo escribía en la
 * base, y en la única pantalla donde alguien iba a decidir no aparecía nada.
 *
 * El panel del encargado sí las pedía, y por eso el fallo era invisible desde
 * ahí. Si alguien vuelve a tocar esta lista, el test de columnas la contrasta
 * contra lo que la vista lee de verdad.
 */
const KITCHEN_PROOF_COLUMNS =
  'id,source_message_id,order_id,attempt_id,association_method,routing_exception,' +
  'declared_mime_type,verified_mime_type,safe_filename,duplicate_of_id,' +
  'capture_status,received_at,analysis_status,analysis_verdict,analysis_reasons';

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

      // Tres consultas en paralelo: el tablero se recarga cada pocos segundos
      // y encadenarlas triplicaría la latencia de cada ciclo.
      //
      // El catálogo entra porque el resumen del planchero reparte lo que hay
      // en comidas, extras y refrescos, y la CATEGORÍA no viaja con la línea
      // del pedido: `order_items` guarda el nombre y el precio de entonces,
      // no a qué parte de la cocina pertenece. Son quince filas.
      const [itemsRes, promosRes, catalogoRes] = await Promise.all([
        client
          .from('order_items')
          .select('order_id,product_code,product_name_snapshot,quantity')
          .in('order_id', ids),
        client
          .from('order_promotions')
          .select('order_id,quantity,components_snapshot')
          .in('order_id', ids),
        // Sin filtrar por `is_active`: un producto retirado esta misma noche
        // sigue estando en los pedidos que ya entraron, y su categoría hace
        // falta para colocarlo en su bloque.
        client.from('menu_items').select('code,category'),
      ]);
      if (itemsRes.error) throw new Error('kitchen_items_failed');
      if (promosRes.error) throw new Error('kitchen_promotions_failed');

      // Si el catálogo falla NO se cae el tablero: las líneas se quedan sin
      // categoría y el resumen las agrupa en "Otros". Perder el reparto es
      // molesto; perder la pantalla en plena noche no es recuperable.
      const categoriaDe = new Map<string, MenuCategory>(
        ((catalogoRes.data ?? []) as unknown as Array<{ code: string; category: MenuCategory }>)
          .map((m) => [m.code, m.category]),
      );
      const conCategoria = <T extends { product_code?: string }>(fila: T) => ({
        ...fila,
        category: fila.product_code ? categoriaDe.get(fila.product_code) ?? null : null,
      });

      // Los componentes del combo NO están en `order_items` —irían dos veces
      // en el subtotal— así que se aplanan aquí. Sin esto, un pedido de solo
      // promociones llegaría a la cocina sin nada que preparar.
      const items = (
        (itemsRes.data ?? []) as unknown as Array<RawKitchenItemRow & { product_code: string }>
      ).map(conCategoria);
      const deCombos = promotionsToKitchenLines(
        (promosRes.data ?? []) as unknown as KitchenPromotionRow[],
      ).map(conCategoria);

      return { rows, items: [...items, ...deCombos] };
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

    async paymentFor(orderNumber) {
      // El pedido y su pago EN EL MOMENTO de pulsar, no lo que el navegador
      // tenía cargado: entre que se pinta el tablero y alguien pulsa INICIAR,
      // otro puede haber aceptado o rechazado ese mismo comprobante.
      const { data, error } = await client
        .from('orders')
        .select('id,payment_method')
        .eq('order_number', orderNumber)
        .limit(1);
      // Se propaga: el repositorio lo traduce a `unknown` —puerta abierta y
      // aviso en pantalla— y esa decisión vive en un solo sitio, no aquí.
      if (error) throw new Error('kitchen_payment_lookup_failed');

      const row = (data ?? [])[0] as
        | { id: string; payment_method: PaymentMethod | null }
        | undefined;
      if (!row) return null;

      return {
        orderId: row.id,
        paymentMethod: row.payment_method,
        rows: await this.listPayments!([row.id]),
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
