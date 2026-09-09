import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import { log } from '@/lib/log';
import type { OrderStatus } from '@/types';
import { SWEEPABLE_STATUSES } from './expiry-sweep';

/**
 * Cerrar UN pedido vencido — cableado server-only (09-09-2026).
 *
 * ── Qué hace y qué NO decide ────────────────────────────────────────────────
 *
 * Escribe `cancelled` y nada más. La pregunta de si ese pedido está vencido ya
 * la respondieron los módulos puros —`paymentGateOf` da `expired`,
 * `expiredOrderToCancel` lo selecciona— y aquí no se vuelve a hacer: si alguna
 * regla acaba escrita en este archivo, está en el sitio equivocado.
 *
 * ── Por qué existe además de `sweepExpiredOrders` ───────────────────────────
 *
 * El barrido del panel cierra una tanda cuando alguien pulsa. Este cierra UNO,
 * en el momento en que el webhook ya lo tiene delante porque acabó de leerlo
 * para decidir qué contestarle al cliente. Los dos aplican la misma regla sobre
 * los mismos datos; lo único que cambia es quién pasa por ahí primero.
 *
 * ── El cliente no se entera, y es deliberado ────────────────────────────────
 *
 * No sale ningún mensaje de "tu pedido se canceló". El cliente ya está
 * recibiendo el menú en ese mismo turno —ver `decideDefaultReply`—, y anunciarle
 * la cancelación de algo que abandonó hace dos horas sería un mensaje extra
 * para decirle lo que el menú ya le está diciendo: que puede pedir de nuevo.
 */

/**
 * Cancela el pedido vencido. NUNCA lanza.
 *
 * La escritura lleva la MISMA guarda optimista que el barrido del panel: solo
 * toca la fila si sigue en el estado que se leyó. Entre que el webhook consultó
 * el estado y llega aquí caben un comprobante aceptado en cocina y un INICIAR
 * pulsado durante un fallo de la base; sin la guarda, este atajo cancelaría un
 * pedido que acaba de entrar en la plancha.
 *
 * `SWEEPABLE_STATUSES` se comprueba aquí y no solo en quien llama porque es la
 * frontera de lo que este archivo puede tocar: lo que ya está en la plancha no
 * se cancela, venga la petición de donde venga.
 */
export async function cancelExpiredOrder(
  orderId: string,
  status: OrderStatus,
  client: SupabaseClient = getSupabaseAdmin(),
): Promise<{ cancelled: boolean }> {
  if (!SWEEPABLE_STATUSES.includes(status)) return { cancelled: false };

  try {
    const { data, error } = await client
      .from('orders')
      .update({ status: 'cancelled' })
      .eq('id', orderId)
      // Solo si sigue donde estaba cuando se leyó.
      .eq('status', status)
      .select('id');

    if (error) return { cancelled: false };

    const cancelled = (data ?? []).length === 1;
    // Sin id, sin número y sin teléfono: que ocurrió es todo lo que hace falta
    // para responder "¿por qué este pedido está cancelado?" en los logs.
    if (cancelled) log.info('order_expired_cancelled', { via: 'inbound_message' });
    return { cancelled };
  } catch (error) {
    log.error('order_expired_cancel_failed', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
    return { cancelled: false };
  }
}
