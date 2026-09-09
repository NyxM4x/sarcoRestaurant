import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import { log } from '@/lib/log';
import type { PaymentMethod } from '@/types';
import { isUnpaidAbandonedOrder, UNPAID_ORDER_WINDOW_MS } from './unpaid-order';

/**
 * Cerrar los pedidos por QR que nunca se pagaron — server-only (09-09-2026).
 *
 * Lee los candidatos, le pregunta al módulo puro cuáles vencieron y los cancela.
 * Ninguna regla vive aquí.
 *
 * ── Se cancela en silencio ──────────────────────────────────────────────────
 *
 * Decisión del dueño, la misma que para el carrito abandonado. Lo que este
 * cliente recibe —y de inmediato— es el menú la próxima vez que escriba, en vez
 * del recordatorio de un pedido que ya olvidó.
 *
 * Es el único de los tres barridos donde la decisión no es obvia: a este cliente
 * SÍ se le mandó un total y un QR, así que se parece al de efectivo, que sí
 * recibe aviso. Si algún día se decide avisarle, el sitio es este y el texto va
 * en `kapso/messages.ts` — nunca aquí.
 */

/**
 * Techo de filas por barrido.
 *
 * El mismo que sus dos hermanos. Este corre cada minuto y no manda ningún
 * mensaje, así que 25 pedidos por pasada no acercan la invocación a su techo.
 */
const MAX_POR_BARRIDO = 25;

interface FilaPedido {
  id: string;
  order_number: string;
  payment_method: PaymentMethod | null;
  confirmed_at: string | null;
}

/**
 * Cancela los pedidos por QR cuya ventana de pago venció sin que llegara nada.
 * NUNCA lanza.
 *
 * ── Por qué un fallo leyendo los pagos NO cancela nada ──────────────────────
 *
 * Si la consulta de intentos o comprobantes falla, no sabemos si el cliente
 * pagó. Cancelar entonces sería matar el pedido de alguien que sí cumplió, por
 * un hipo de la base. Se sale sin tocar nada: el minuto que viene se vuelve a
 * intentar, con el trabajo intacto.
 *
 * Es la dirección contraria a la de la puerta del KDS —que ante la duda ABRE y
 * deja cocinar— y las dos son correctas: abrir ante la duda cuesta un pedido de
 * más, cancelar ante la duda cuesta el pedido de un cliente que pagó.
 */
export async function expireUnpaidOrders(
  /** Se resuelve DENTRO del try: ver `expireAbandonedCarts`. */
  client?: SupabaseClient,
): Promise<{ cancelled: number }> {
  try {
    const supabase = client ?? getSupabaseAdmin();
    const limite = new Date(Date.now() - UNPAID_ORDER_WINDOW_MS).toISOString();

    const { data, error } = await supabase
      .from('orders')
      .select('id, order_number, payment_method, confirmed_at')
      .eq('status', 'confirmed')
      .eq('payment_method', 'qr')
      .lt('confirmed_at', limite)
      .limit(MAX_POR_BARRIDO);

    if (error || !data) return { cancelled: 0 };

    const filas = data as unknown as FilaPedido[];
    if (filas.length === 0) return { cancelled: 0 };

    // ── ¿A cuáles les llegó ALGO? ─────────────────────────────────────────
    //
    // Las dos tablas, no solo `payment_attempts`: un comprobante que llegó y no
    // se pudo capturar vive en `payment_proofs` sin intento asociado, y
    // significa exactamente lo que esta regla necesita saber — que el cliente
    // hizo su parte. Cancelarle el pedido a ese sería castigarlo por un fallo
    // nuestro al descargar su foto.
    const ids = filas.map((f) => f.id);
    const [intentos, comprobantes] = await Promise.all([
      supabase.from('payment_attempts').select('order_id').in('order_id', ids),
      supabase.from('payment_proofs').select('order_id').in('order_id', ids),
    ]);

    // Ante un fallo de lectura no se cancela nada. Ver la cabecera.
    if (intentos.error || comprobantes.error) return { cancelled: 0 };

    const conAlgo = new Set<string>();
    for (const fila of (intentos.data ?? []) as Array<{ order_id: string }>) {
      conAlgo.add(fila.order_id);
    }
    for (const fila of (comprobantes.data ?? []) as Array<{ order_id: string }>) {
      conAlgo.add(fila.order_id);
    }

    const nowMs = Date.now();
    let cancelados = 0;

    for (const fila of filas) {
      const vencido = isUnpaidAbandonedOrder({
        status: 'confirmed',
        paymentMethod: fila.payment_method,
        confirmedAt: fila.confirmed_at,
        hasAnyPaymentRow: conAlgo.has(fila.id),
        nowMs,
      });
      if (!vencido) continue;

      const { data: cerrado, error: errorUpdate } = await supabase
        .from('orders')
        .update({ status: 'cancelled' })
        .eq('id', fila.id)
        // Guarda optimista: si entre la lectura y el UPDATE alguien aceptó el
        // pago y cocina pulsó INICIAR, la fila ya no coincide y no se cancela.
        .eq('status', 'confirmed')
        .select('id');

      if (errorUpdate || (cerrado ?? []).length === 0) continue;
      cancelados += 1;
    }

    // Solo recuentos: ni ids, ni números de pedido, ni teléfonos.
    if (cancelados > 0) log.info('unpaid_orders_expired', { cancelled: cancelados });
    return { cancelled: cancelados };
  } catch (error) {
    log.error('unpaid_orders_sweep_failed', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
    return { cancelled: 0 };
  }
}
