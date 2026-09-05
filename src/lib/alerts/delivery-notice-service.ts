import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import { getServerEnv } from '@/lib/env/env';
import { log } from '@/lib/log';
import { buildDeliveryNotice, type DeliveryNoticeItem } from './delivery-notice';
import { deliveryCollectOf } from '@/lib/kitchen/ticket-view';
import { amountLabelHint, amountLabelText } from '@/lib/payment-proof/labels';
import type { ProofAmountLabel } from '@/lib/payment-proof/analysis';
import { createAlertRunnerDeps, enqueueAlert } from './outbox-store';
import { trySendNow } from './outbox-runner';

/**
 * Envío del aviso de pedido al grupo de reparto — wiring server-only.
 *
 * Se dispara cuando un delivery queda confirmado y cotizado. Ensambla los datos
 * reales de Supabase y manda el texto de `./delivery-notice` por el mismo
 * transporte de Telegram que usan las alertas técnicas.
 *
 * ── Idempotencia ────────────────────────────────────────────────────────────
 *
 * `dispatchConfirmation` puede ejecutarse más de una vez sobre el mismo pedido:
 * el envío directo tras cotizar y el descubrimiento por `select_due` conviven a
 * propósito. Sin protección, el grupo recibiría el pedido repetido.
 *
 * Desde 0028 el aviso vive en el OUTBOX y su unicidad la garantiza el índice
 * `(kind, target_ref)`: dos ejecuciones concurrentes encolan una sola alerta.
 *
 * Sigue siendo cierto que un aviso duplicado es peor que uno ausente —dos
 * personas podrían salir a llevar el mismo pedido— pero eso ya no obliga a
 * perderlo cuando Telegram falla. Antes el claim se escribía ANTES del envío y
 * un fallo posterior dejaba el pedido marcado como avisado para siempre; ahora
 * la fila es durable, el estado se escribe DESPUÉS de saber qué pasó, y lo que
 * no salió se reintenta con backoff sin poder salir dos veces.
 *
 * `orders.delivery_notice_sent_at` (0019) queda sin usar: su nombre decía
 * "enviado" y significaba "reclamado", y esa mentira es la que impedía
 * detectar el problema mirando la base.
 *
 * NUNCA lanza: un fallo aquí no puede tumbar la confirmación al cliente, que es
 * lo importante del turno.
 */

/**
 * `subtotal_amount`, `payment_method` y `delivery_fee_paid` entraron el
 * 03-09-2026: son lo que `deliveryCollectOf` necesita para decidir qué se cobra
 * en la puerta. `total_amount` sigue pidiéndose porque esa misma función lo usa
 * para calcular el envío restando — lo que ya NO hace es salir en el mensaje.
 *
 * `notes` entró el 04-09-2026: es la nota del cliente, y hasta ahora solo la
 * veía cocina. Quien reparte es el que tiene la bolsa delante y el que recibe
 * el reclamo en la puerta, así que también tiene que poder leerla.
 */
const NOTICE_SELECT =
  'id, order_number, customer_name, customer_phone, delivery_type, status, ' +
  'notes, delivery_quote_status, delivery_amount, subtotal_amount, total_amount, ' +
  'payment_method, delivery_fee_paid, delivery_latitude, ' +
  'delivery_longitude, delivery_distance_meters, ' +
  'order_items ( product_name_snapshot, quantity )';

/**
 * La etiqueta del comprobante más reciente de este pedido.
 *
 * ── Por qué se consulta aquí y no se recibe ────────────────────────────────
 *
 * Porque el aviso se dispara con un `orderId` y nada más, desde el punto en que
 * se acepta un pago. Traer la etiqueta es una consulta pequeña y acotada, y la
 * alternativa —hacerla viajar por la cadena de llamadas— ataría este aviso al
 * flujo de decisión, que es justo lo que hoy lo mantiene reintentable.
 *
 * Se exige `analysis_status = 'done'` por la misma razón que en el panel: una
 * etiqueta escrita a medio análisis afirmaría algo que nadie llegó a comprobar.
 * `null` ante cualquier fallo: sin dato no se deduce, se calla.
 */
async function etiquetaDelComprobante(
  orderId: string,
  supabase: SupabaseClient,
): Promise<{ code: ProofAmountLabel; text: string; hint: string } | null> {
  try {
    const { data, error } = await supabase
      .from('payment_proofs')
      .select('analysis_amount_label, received_at')
      .eq('order_id', orderId)
      .eq('analysis_status', 'done')
      .not('analysis_amount_label', 'is', null)
      .order('received_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error || !data) return null;

    const code = (data as { analysis_amount_label: ProofAmountLabel }).analysis_amount_label;
    const text = amountLabelText(code);
    const hint = amountLabelHint(code);
    return text === null || hint === null ? null : { code, text, hint };
  } catch {
    return null;
  }
}

function num(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/**
 * Desde dónde se pide el aviso. Decide QUÉ pedidos son legítimos aquí.
 *
 * El momento correcto depende del método de pago, y esa comprobación vive en
 * esta función porque es la única que ya tiene la fila delante:
 *
 *   `payment_accepted`  alguien aceptó el comprobante. Es el camino del QR y el
 *                       de siempre: hasta que el pago no está cobrado, nadie
 *                       sale a llevar nada.
 *   `cash_confirmed`    el pedido en EFECTIVO acaba de quedar cotizado. No hay
 *                       pago que esperar —el repartidor cobra en la puerta—, así
 *                       que este es su equivalente exacto.
 *
 * Cada origen solo admite su método: un pedido por QR pedido desde
 * `cash_confirmed` se descarta, y con eso ningún pedido sin pagar puede colarse
 * al grupo por la puerta nueva.
 */
export type DeliveryNoticeTrigger = 'payment_accepted' | 'cash_confirmed';

/**
 * Avisa al grupo de reparto de un pedido recién cotizado. Best-effort.
 *
 * No devuelve nada: quien la llama no puede hacer nada distinto según el
 * resultado, y el detalle queda en los logs.
 */
export async function notifyDeliveryGroup(
  orderId: string,
  supabase: SupabaseClient = getSupabaseAdmin(),
  trigger: DeliveryNoticeTrigger = 'payment_accepted',
): Promise<void> {
  try {
    const env = getServerEnv();
    if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
      // Sin credenciales no hay canal: no es un error, es una función apagada.
      return;
    }

    const { data, error } = await supabase
      .from('orders')
      .select(NOTICE_SELECT)
      .eq('id', orderId)
      .maybeSingle();

    if (error || !data) {
      log.warn('delivery_notice_load_failed', { order_id: orderId });
      return;
    }

    // Doble cast a través de `unknown`: el tipo que infiere Supabase para un
    // select con JOIN embebido no se solapa con un registro plano, y aquí los
    // campos se leen uno a uno con validación propia (`num`, `String`).
    const order = data as unknown as Record<string, unknown>;

    // Solo delivery ya cotizado: un pedido de recojo no necesita repartidor, y
    // uno sin cotizar todavía no tiene ni monto ni destino que comunicar.
    if (order.delivery_type !== 'delivery' || order.delivery_quote_status !== 'quoted') {
      return;
    }

    // Y solo el método que corresponde a quien llama. Ver `DeliveryNoticeTrigger`.
    const esEfectivo = order.payment_method === 'cash';
    if (trigger === 'cash_confirmed' && !esEfectivo) return;
    if (trigger === 'payment_accepted' && esEfectivo) return;

    const latitude = num(order.delivery_latitude);
    const longitude = num(order.delivery_longitude);
    if (latitude === null || longitude === null) {
      log.warn('delivery_notice_without_gps', { order_id: orderId });
      return;
    }

    const rawItems = Array.isArray(order.order_items) ? order.order_items : [];
    const items: DeliveryNoticeItem[] = rawItems.map((raw) => {
      const item = raw as Record<string, unknown>;
      return {
        name: String(item.product_name_snapshot ?? 'producto'),
        quantity: num(item.quantity) ?? 1,
      };
    });

    // Qué se cobra en la puerta, con la MISMA función que lo decide en cocina.
    //
    // Manda la marca del cocinero si la hay, y si no la etiqueta del
    // comprobante. Ojo con el momento: este aviso sale al ACEPTAR el pago, y el
    // botón del ticket se pulsa después, al empacar — así que lo normal es que
    // aquí todavía no haya marca y salga lo que dice el comprobante.
    const collect = deliveryCollectOf(
      {
        id: String(order.id ?? ''),
        order_number: String(order.order_number ?? ''),
        status: order.status as never,
        delivery_type: order.delivery_type as never,
        notes: null,
        created_at: '',
        confirmed_at: null,
        updated_at: '',
        subtotal_amount: num(order.subtotal_amount),
        total_amount: num(order.total_amount),
        payment_method: (order.payment_method ?? null) as never,
        delivery_fee_paid:
          typeof order.delivery_fee_paid === 'boolean' ? order.delivery_fee_paid : null,
      },
      await etiquetaDelComprobante(orderId, supabase),
    );

    const text = buildDeliveryNotice({
      orderNumber: String(order.order_number ?? ''),
      customerName: typeof order.customer_name === 'string' ? order.customer_name : null,
      customerPhone: String(order.customer_phone ?? ''),
      items,
      deliveryAmount: num(order.delivery_amount) ?? 0,
      subtotalAmount: num(order.subtotal_amount) ?? 0,
      // El método de pago SÍ viaja al aviso, y es la única pieza del sistema
      // donde lo hace: el ticket de cocina sigue recibiendo solo la instrucción
      // ("COBRAR TODO"), porque quien cocina no necesita saber cómo se paga.
      // Quien reparte, sí: es él quien cobra.
      isCash: order.payment_method === 'cash',
      // El tipo del aviso no lleva `basis` ni `canOverride`: en el grupo de
      // reparto no hay nada que marcar, solo una instrucción que seguir.
      collect:
        collect === null
          ? null
          : collect.kind === 'todo'
            ? { kind: 'todo', amount: collect.amount }
            : { kind: collect.kind },
      // La nota va TAL CUAL sale de la base: es la misma que imprime la comanda.
      // Si el cliente añade una por chat después de que este aviso ya salió, el
      // grupo no la verá —el outbox no reescribe lo enviado—, y esa es
      // exactamente la razón por la que también se le contesta a él.
      customerNote: typeof order.notes === 'string' ? order.notes : null,
      latitude,
      longitude,
      distanceMeters: num(order.delivery_distance_meters),
    });

    // ── ENCOLAR, y solo después mandar ────────────────────────────────────
    //
    // Aquí estaba el fallo. El claim sobre `delivery_notice_sent_at` se escribía
    // ANTES de llamar a Telegram: si Telegram fallaba después, el pedido quedaba
    // marcado como avisado para siempre. Nadie salía a repartirlo, no se
    // reintentaba y no aparecía en ninguna pantalla.
    //
    // La protección contra el duplicado no desaparece, cambia de sitio: el
    // índice único `(kind, target_ref)` de 0028 solo admite UNA alerta por
    // pedido, así que dos ejecuciones concurrentes encolan una sola. Y como la
    // fila es durable, reintentar el envío ya no arriesga un segundo aviso.
    const alertId = await enqueueAlert('delivery_notice', orderId, text, supabase);
    if (alertId === null) return; // Ya encolada: silencio, no es un error.

    // Fast path: la fila ya está: esto solo adelanta el aviso. Si falla, el
    // worker lo reintenta con backoff en vez de perderlo.
    const resultado = await trySendNow(alertId, createAlertRunnerDeps(supabase));

    // El número de pedido no es un dato sensible y hace el log accionable; el
    // texto enviado NO se registra, porque lleva teléfono y ubicación.
    if (resultado === 'sent') {
      log.info('delivery_notice_sent', { order_number: order.order_number });
    } else {
      log.info('delivery_notice_queued', {
        order_number: order.order_number,
        outcome: resultado,
      });
    }
  } catch (error) {
    // Jamás propagar: la confirmación al cliente vale más que este aviso.
    log.error('delivery_notice_error', {
      order_id: orderId,
      reason: error instanceof Error ? error.message : 'unknown',
    });
  }
}
