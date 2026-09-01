import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import { log } from '@/lib/log';
import { toPaymentView } from '@/lib/dashboard/attempt-review';
import type { ProofUiRow } from '@/lib/dashboard/proofs-data-source';
import type { OrderStatus, PaymentAttempt, PaymentMethod } from '@/types';
import { selectExpiredOrders, SWEEPABLE_STATUSES, type ExpiryCandidate } from './expiry-sweep';

/**
 * Materializar las cancelaciones vencidas — cableado server-only.
 *
 * Lee los pedidos que podrían haber vencido, pregunta al módulo puro cuáles y
 * los cancela. Ninguna regla vive aquí: si algo que decide QUÉ se cancela acaba
 * escrito en este archivo, está en el sitio equivocado.
 *
 * ── Cuántos por pulsación ───────────────────────────────────────────────────
 *
 * El barrido mira solo la jornada en curso y con un techo. No es un proceso de
 * mantenimiento histórico: es el botón que cierra los pedidos que el turno de
 * esta noche dejó colgando.
 */

/** Techo de pedidos revisados por barrido. */
const MAX_SWEEP_ROWS = 200;

export interface SweepResult {
  /** Pedidos efectivamente cancelados. */
  cancelled: number;
  /** Números de pedido cancelados, para poder decirlo en pantalla. */
  orderNumbers: string[];
}

/**
 * Cancela los pedidos cuya ventana de gracia venció. Nunca lanza.
 *
 * La escritura lleva guarda optimista sobre el estado que se leyó: si entre la
 * lectura y el UPDATE alguien aceptó el pago —o el cocinero pulsó INICIAR
 * durante un fallo de la base— la fila ya no coincide y no se cancela. Sin esa
 * guarda, el barrido podría cancelar un pedido que acaba de entrar en la
 * plancha.
 */
export async function sweepExpiredOrders(
  nowMs: number = Date.now(),
  client: SupabaseClient = getSupabaseAdmin(),
): Promise<SweepResult> {
  const vacio: SweepResult = { cancelled: 0, orderNumbers: [] };

  try {
    const { data: orders, error } = await client
      .from('orders')
      .select('id,order_number,status,payment_method')
      .in('status', [...SWEEPABLE_STATUSES])
      .eq('payment_method', 'qr')
      .order('created_at', { ascending: false })
      .limit(MAX_SWEEP_ROWS);
    if (error || !orders) return vacio;

    const filas = orders as Array<{
      id: string;
      order_number: string;
      status: OrderStatus;
      payment_method: PaymentMethod | null;
    }>;
    if (filas.length === 0) return vacio;

    const ids = filas.map((f) => f.id);
    const [attemptsRes, proofsRes] = await Promise.all([
      client.from('payment_attempts').select('*').in('order_id', ids),
      client.from('payment_proofs').select('*').in('order_id', ids),
    ]);
    // Un fallo leyendo los pagos NO cancela nada: sin saber en qué va el pago,
    // el módulo puro lee `null` como `unknown` y se abstiene. Se sale antes
    // para no construir doscientas vistas vacías que significarían lo mismo.
    if (attemptsRes.error || proofsRes.error) return vacio;

    const attempts = (attemptsRes.data ?? []) as unknown as PaymentAttempt[];
    const proofs = (proofsRes.data ?? []) as unknown as ProofUiRow[];

    const candidatos: ExpiryCandidate[] = filas.map((f) => ({
      orderId: f.id,
      orderNumber: f.order_number,
      status: f.status,
      paymentMethod: f.payment_method,
      payment: toPaymentView(
        attempts.filter((a) => a.order_id === f.id),
        proofs.filter((p) => p.order_id === f.id),
      ),
    }));

    const vencidos = selectExpiredOrders(candidatos, nowMs);
    const cancelados: string[] = [];

    for (const v of vencidos) {
      const { data, error: updateError } = await client
        .from('orders')
        .update({ status: 'cancelled' })
        .eq('id', v.orderId)
        // Guarda optimista: solo si sigue en el estado que se leyó.
        .eq('status', v.status)
        .select('order_number');
      if (updateError) continue;
      if ((data ?? []).length === 1) cancelados.push(v.orderNumber);
    }

    // Solo recuentos: ni teléfonos ni importes. El número de pedido no es un
    // dato sensible y hace el log accionable.
    if (cancelados.length > 0) log.info('orders_expiry_swept', { cancelled: cancelados.length });

    return { cancelled: cancelados.length, orderNumbers: cancelados };
  } catch (error) {
    log.error('orders_expiry_sweep_failed', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
    return vacio;
  }
}
