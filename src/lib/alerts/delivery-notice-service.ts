import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import { getServerEnv } from '@/lib/env/env';
import { log } from '@/lib/log';
import { reverseGeocode } from '@/lib/delivery/geocode';
import { parseDeliveryConfig } from '@/lib/delivery/config';
import { buildDeliveryNotice, type DeliveryNoticeItem } from './delivery-notice';
import { createTelegramAlertSender } from './telegram';

/**
 * Envío del aviso de pedido al grupo de reparto — wiring server-only.
 *
 * Se dispara cuando un delivery queda confirmado y cotizado. Ensambla los datos
 * reales (Supabase + geocoding) y manda el texto de `./delivery-notice` por el
 * mismo transporte de Telegram que usan las alertas técnicas.
 *
 * ── Idempotencia ────────────────────────────────────────────────────────────
 *
 * `dispatchConfirmation` puede ejecutarse más de una vez sobre el mismo pedido:
 * el envío directo tras cotizar y el descubrimiento por `select_due` conviven a
 * propósito. Sin protección, el grupo recibiría el pedido repetido.
 *
 * El claim es un UPDATE condicional sobre `delivery_notice_sent_at IS NULL`
 * (migración 0019), el mismo mecanismo que ya protege la ubicación: solo una
 * ejecución concurrente puede escribirlo.
 *
 * El claim va ANTES del envío. Si Telegram falla después, el aviso se pierde y
 * no se reintenta — deliberado: para el grupo, un pedido duplicado es peor que
 * uno ausente, porque dos personas podrían salir a llevar lo mismo. El pedido
 * está en el dashboard de todos modos.
 *
 * NUNCA lanza: un fallo aquí no puede tumbar la confirmación al cliente, que es
 * lo importante del turno.
 */

const NOTICE_SELECT =
  'id, order_number, customer_name, customer_phone, delivery_type, status, ' +
  'delivery_quote_status, delivery_amount, total_amount, delivery_latitude, ' +
  'delivery_longitude, delivery_address, delivery_distance_meters, ' +
  'order_items ( product_name_snapshot, quantity )';

function num(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/**
 * Avisa al grupo de reparto de un pedido recién cotizado. Best-effort.
 *
 * No devuelve nada: quien la llama no puede hacer nada distinto según el
 * resultado, y el detalle queda en los logs.
 */
export async function notifyDeliveryGroup(
  orderId: string,
  supabase: SupabaseClient = getSupabaseAdmin(),
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

    const latitude = num(order.delivery_latitude);
    const longitude = num(order.delivery_longitude);
    if (latitude === null || longitude === null) {
      log.warn('delivery_notice_without_gps', { order_id: orderId });
      return;
    }

    // CLAIM: gana quien ponga la marca primero. Si no vuelve fila, otro ya
    // avisó de este pedido y aquí no hay nada que hacer.
    const { data: claimed, error: claimError } = await supabase
      .from('orders')
      .update({ delivery_notice_sent_at: new Date().toISOString() })
      .eq('id', orderId)
      .is('delivery_notice_sent_at', null)
      .select('id')
      .maybeSingle();

    if (claimError) {
      log.warn('delivery_notice_claim_failed', { order_id: orderId });
      return;
    }
    if (!claimed) return; // Ya avisado: silencio, no es un error.

    // La dirección es un adorno: si el geocoder no contesta, el aviso sale
    // igual con el enlace de mapa. Se prefiere la que mandó WhatsApp cuando
    // existe, porque suele ser un lugar con nombre elegido por el cliente.
    const whatsappAddress =
      typeof order.delivery_address === 'string' && order.delivery_address.trim() !== ''
        ? order.delivery_address.trim()
        : null;

    // `parseDeliveryConfig` en vez de `getDeliveryConfig()`: la segunda LANZA
    // si falta una variable de Mapbox, y eso tumbaría un aviso que puede salir
    // perfectamente sin dirección. El token de Mapbox no está en el esquema
    // general del entorno; vive en el de delivery.
    const deliveryConfig = parseDeliveryConfig(process.env);
    const address =
      whatsappAddress ??
      (deliveryConfig.ok
        ? await reverseGeocode(latitude, longitude, {
            accessToken: deliveryConfig.config.mapboxAccessToken,
          })
        : null);

    const rawItems = Array.isArray(order.order_items) ? order.order_items : [];
    const items: DeliveryNoticeItem[] = rawItems.map((raw) => {
      const item = raw as Record<string, unknown>;
      return {
        name: String(item.product_name_snapshot ?? 'producto'),
        quantity: num(item.quantity) ?? 1,
      };
    });

    const text = buildDeliveryNotice({
      orderNumber: String(order.order_number ?? ''),
      customerName: typeof order.customer_name === 'string' ? order.customer_name : null,
      customerPhone: String(order.customer_phone ?? ''),
      items,
      deliveryAmount: num(order.delivery_amount) ?? 0,
      totalAmount: num(order.total_amount) ?? 0,
      latitude,
      longitude,
      address,
      distanceMeters: num(order.delivery_distance_meters),
    });

    const sender = createTelegramAlertSender({
      botToken: env.TELEGRAM_BOT_TOKEN,
      chatId: env.TELEGRAM_CHAT_ID,
    });
    const outcome = await sender.send(text);

    // El número de pedido no es un dato sensible y hace el log accionable; el
    // texto enviado NO se registra, porque lleva teléfono y ubicación.
    if (outcome.kind === 'sent') {
      log.info('delivery_notice_sent', { order_number: order.order_number });
    } else {
      log.warn('delivery_notice_send_failed', {
        order_number: order.order_number,
        outcome: outcome.kind,
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
