import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import { log } from '@/lib/log';
import type { DeliveryQuoteStatus } from '@/types';
import { isAbandonedCart, UNQUOTED_CART_WINDOW_MS } from './abandoned-cart';

/**
 * Cerrar los carritos que nunca llegaron a cotizarse — server-only (09-09-2026).
 *
 * Lee los candidatos, le pregunta al módulo puro cuáles vencieron y los cancela.
 * Ninguna regla vive aquí: si algo que decide QUÉ se cancela acaba escrito en
 * este archivo, está en el sitio equivocado.
 *
 * ── Por qué NO le avisa al cliente ──────────────────────────────────────────
 *
 * A diferencia del barrido del CONFIRMO en efectivo —que sí manda un WhatsApp—
 * este se cancela en silencio, y es una decisión del dueño (09-09-2026).
 *
 * La diferencia entre los dos casos es qué sabe el cliente. Al de efectivo se
 * le hizo una pregunta con su total delante: dejarlo sin respuesta después de
 * preguntarle sería maleducado. A este no se le prometió nada — no tiene total,
 * ni QR, ni una pregunta pendiente— y lo que hizo fue abandonar un carrito a
 * medias. Avisarle de que un pedido que nunca llegó a existir dejó de existir es
 * ruido.
 *
 * Lo que sí recibe, y de inmediato, es el menú la próxima vez que escriba: en
 * cuanto la fila deja de estar abierta, `default-reply` lo trata como el cliente
 * que es —uno que quiere pedir— en vez de pedirle la ubicación de un pedido que
 * ya olvidó.
 */

/**
 * Techo de filas por barrido.
 *
 * El mismo que el del CONFIRMO en efectivo, y por el mismo motivo: esto corre
 * cada minuto, así que una cola larga se drena en unas pocas pasadas sin que
 * ninguna se alargue. Aquí además no hay ningún mensaje que mandar —el barrido
 * es silencioso—, así que 25 UPDATEs por índice no acercan la invocación a su
 * techo ni de lejos.
 */
const MAX_POR_BARRIDO = 25;

interface FilaCarrito {
  id: string;
  order_number: string;
  status: string;
  delivery_quote_status: DeliveryQuoteStatus | null;
  created_at: string | null;
}

/**
 * Cancela los carritos abandonados que ya vencieron. NUNCA lanza.
 *
 * La escritura lleva guarda optimista sobre `awaiting_location`: si entre la
 * lectura y el UPDATE llegó la ubicación del cliente y la cotización confirmó el
 * pedido, la fila ya no coincide y no se cancela. Sin esa guarda, el barrido
 * podría matar un pedido que acaba de cobrar vida — y el cliente se quedaría con
 * un total en el chat y un pedido cancelado por detrás.
 */
export async function expireAbandonedCarts(
  /**
   * El cliente se resuelve DENTRO del try, no en el valor por defecto: esto
   * corre en el tick de un Worker, donde un entorno a medio configurar haría
   * lanzar a `getSupabaseAdmin()` antes de entrar a la función.
   */
  client?: SupabaseClient,
): Promise<{ cancelled: number }> {
  try {
    const supabase = client ?? getSupabaseAdmin();
    const limite = new Date(Date.now() - UNQUOTED_CART_WINDOW_MS).toISOString();

    const { data, error } = await supabase
      .from('orders')
      .select('id, order_number, status, delivery_quote_status, created_at')
      .eq('status', 'awaiting_location')
      // El filtro por fecha acota en la base; la regla la aplica igualmente el
      // módulo puro más abajo, que es quien decide de verdad.
      .lt('created_at', limite)
      .limit(MAX_POR_BARRIDO);

    if (error || !data) return { cancelled: 0 };

    const filas = data as unknown as FilaCarrito[];
    const nowMs = Date.now();
    let cancelados = 0;

    for (const fila of filas) {
      // NO se cancela por el filtro de la consulta: se cancela por la regla.
      // `failed` —Mapbox caído— entra en este `select` y sale aquí, que es lo
      // que impide que un fallo nuestro le cueste el pedido al cliente.
      const vencido = isAbandonedCart({
        status: 'awaiting_location',
        deliveryQuoteStatus: fila.delivery_quote_status,
        createdAt: fila.created_at,
        nowMs,
      });
      if (!vencido) continue;

      const { data: cerrado, error: errorUpdate } = await supabase
        .from('orders')
        .update({ status: 'cancelled' })
        .eq('id', fila.id)
        // Guarda optimista: solo si sigue esperando su ubicación.
        .eq('status', 'awaiting_location')
        .select('id');

      if (errorUpdate || (cerrado ?? []).length === 0) continue;
      cancelados += 1;
    }

    // Solo recuentos: ni ids, ni números de pedido, ni teléfonos.
    if (cancelados > 0) log.info('abandoned_carts_expired', { cancelled: cancelados });
    return { cancelled: cancelados };
  } catch (error) {
    log.error('abandoned_carts_sweep_failed', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
    return { cancelled: 0 };
  }
}
