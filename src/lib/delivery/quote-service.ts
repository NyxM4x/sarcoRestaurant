import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import { readRainSurcharge } from './settings';
import { getServerEnv } from '@/lib/env/env';
import { getKapsoClient } from '@/lib/kapso/client';
import { log } from '@/lib/log';
import { OUT_OF_COVERAGE_TEXT } from '@/lib/kapso/messages';
import { createTelegramAlertSender } from '@/lib/alerts/telegram';
import {
  createKapsoNotificationSender,
  createSupabaseNotificationStore,
} from '@/lib/orders/notifications/service';
import { notifyDeliveryGroup } from '@/lib/alerts/delivery-notice-service';
import { dispatchSingleNotification } from '@/lib/orders/notifications/web-notify';
import type { DeliveryPricing, DeliveryQuoteStatus, DeliveryType, OrderStatus } from '@/types';
import { normalizePhone } from '@/lib/phone';
import { getDeliveryConfig } from './config';
import { findReusableDistanceMeters } from './quote-request-service';
import { getDistanceByRoad, type MapboxDistanceResult } from './mapbox';
import {
  quoteDynamicOrder,
  type QuoteApplyResult,
  type QuoteMarkResult,
  type QuoteOrchestratorDeps,
  type QuoteOrderRow,
  type QuoteOutcome,
} from './quote-order';

/**
 * Wiring server-only del orquestador de cotización (Fase 6D.2C).
 *
 * Ensambla las dependencias reales (Supabase + Mapbox + Kapso + Telegram) para
 * `quoteDynamicOrder`. El token de Mapbox NUNCA se registra: solo lo usa
 * `getDistanceByRoad` internamente. El origen de la ruta (RESTAURANT_LAT/LNG) y
 * el timeout salen de `getDeliveryConfig()`.
 */

const QUOTE_ORDER_SELECT =
  'id, order_number, delivery_type, status, delivery_pricing, delivery_quote_status, ' +
  'delivery_latitude, delivery_longitude, customer_phone, ' +
  'menu_session:menu_sessions!orders_menu_session_id_fk ( phone_number_id )';

function unwrapToOne(value: unknown): Record<string, unknown> | null {
  const v = Array.isArray(value) ? value[0] : value;
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Resultados válidos de apply/mark; cualquier otro se degrada a 'error' (no confirma). */
const QUOTE_RESULTS: readonly string[] = ['applied', 'already_applied', 'conflict'];

function parseQuoteResult(data: unknown): 'applied' | 'already_applied' | 'conflict' | 'error' {
  const result = asRecord(data)?.result;
  return typeof result === 'string' && QUOTE_RESULTS.includes(result)
    ? (result as 'applied' | 'already_applied' | 'conflict')
    : 'error';
}

/** Alerta interna best-effort: solo si Telegram está configurado. `undefined` si no. */
function buildAlert(): ((text: string) => Promise<void>) | undefined {
  const env = getServerEnv();
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return undefined;
  const sender = createTelegramAlertSender({
    botToken: env.TELEGRAM_BOT_TOKEN,
    chatId: env.TELEGRAM_CHAT_ID,
  });
  return async (text: string) => {
    await sender.send(text);
  };
}

export function createQuoteOrchestratorDeps(
  supabase: SupabaseClient = getSupabaseAdmin(),
): QuoteOrchestratorDeps {
  const kapso = getKapsoClient();
  const store = createSupabaseNotificationStore(supabase);
  const sender = createKapsoNotificationSender(kapso);

  return {
    async loadForQuote(orderId: string): Promise<QuoteOrderRow | null> {
      const { data, error } = await supabase
        .from('orders')
        .select(QUOTE_ORDER_SELECT)
        .eq('id', orderId)
        .maybeSingle();
      if (error) throw new Error(`quote.loadForQuote: ${error.message}`);
      if (!data) return null;

      const row = data as unknown as Record<string, unknown>;
      const session = unwrapToOne(row.menu_session);
      const phoneNumberId =
        typeof session?.phone_number_id === 'string' ? session.phone_number_id : '';

      return {
        id: String(row.id),
        order_number: String(row.order_number),
        delivery_type: row.delivery_type as DeliveryType,
        status: row.status as OrderStatus,
        delivery_pricing: (row.delivery_pricing as DeliveryPricing | null) ?? null,
        delivery_quote_status: (row.delivery_quote_status as DeliveryQuoteStatus | null) ?? null,
        delivery_latitude: (row.delivery_latitude as number | null) ?? null,
        delivery_longitude: (row.delivery_longitude as number | null) ?? null,
        customer_phone: String(row.customer_phone ?? ''),
        phone_number_id: phoneNumberId,
      };
    },

    /**
     * Reuso de una medición reciente del mismo punto (0027).
     *
     * El teléfono se normaliza AQUÍ y no en el ledger: `orders.customer_phone`
     * guarda lo que llegó del checkout —con `+`, espacios o guiones—, mientras
     * que `delivery_quote_requests.customer_phone` son dígitos, como
     * `agent_conversations`. Comparar los dos crudos no encontraría nunca nada
     * y el reuso quedaría muerto sin que fallara ningún test.
     */
    async findReusedDistanceMeters(destination, customerPhone): Promise<number | null> {
      const digitos = normalizePhone(customerPhone);
      if (!digitos) return null;
      return findReusableDistanceMeters(supabase, digitos, destination);
    },

    async getDistanceMeters(destination): Promise<MapboxDistanceResult> {
      const config = getDeliveryConfig();
      return getDistanceByRoad(
        {
          origin: { lat: config.restaurantLat, lng: config.restaurantLng },
          destination,
        },
        { accessToken: config.mapboxAccessToken, timeoutMs: config.mapboxTimeoutMs },
      );
    },

    async applyQuote(orderId, distanceMeters, deliveryAmount): Promise<QuoteApplyResult> {
      const { data, error } = await supabase.rpc('apply_delivery_quote', {
        p_order_id: orderId,
        p_distance_meters: distanceMeters,
        p_delivery_amount: deliveryAmount,
      });
      // Un RAISE de la RPC (estado no cotizable, money guard) llega como error:
      // se degrada a 'error' → el orquestador no confirma nada.
      if (error) return { result: 'error' };
      return { result: parseQuoteResult(data) };
    },

    async markQuoteResult(orderId, status, distanceMeters): Promise<QuoteMarkResult> {
      const { data, error } = await supabase.rpc('mark_delivery_quote_result', {
        p_order_id: orderId,
        p_status: status,
        p_distance_meters: distanceMeters,
      });
      if (error) return { result: 'error' };
      return { result: parseQuoteResult(data) };
    },

    async sendOutOfCoverageMessage(order: QuoteOrderRow): Promise<void> {
      // Texto directo best-effort: NO crea fila en order_notifications ni amplía
      // notification_type. El orquestador solo lo llama en la transición real.
      await kapso.sendText(order.customer_phone, OUT_OF_COVERAGE_TEXT, {
        phoneNumberId: order.phone_number_id || undefined,
      });
    },

    async dispatchConfirmation(orderId: string): Promise<void> {
      // Envío directo inmediato; la durabilidad la cubre select_due (0011), que
      // descubre la confirmación dinámica una vez el pedido queda 'quoted'.
      await dispatchSingleNotification(store, sender, orderId, 'confirmation');

      // El aviso al grupo de reparto NO sale aquí para los pedidos por QR.
      //
      // Ahí solo se ha cotizado y se ha mandado el QR: el cliente todavía no ha
      // pagado. Avisar en ese punto ponía el pedido delante del reparto antes
      // de cobrarlo, y si el cliente no llegaba a pagar, alguien podía salir a
      // llevar algo que nadie había pagado. Sale cuando el pago se acepta, en
      // `decidePaymentAttempt`.
      //
      // ── Para el EFECTIVO, este SÍ es el momento (04-09-2026) ──────────────
      //
      // Un pedido en efectivo no genera `payment_attempts`, así que no hay
      // ningún `accept` que disparar: por el camino del QR no llegaría nunca al
      // grupo. Y el argumento de arriba no le aplica —no hay pago que esperar,
      // el repartidor cobra en la puerta—, mientras que el pedido ya es firme:
      // el cliente eligió, mandó su ubicación y conoce el total.
      //
      // La función comprueba el método por su cuenta: si el pedido resulta ser
      // por QR, se descarta aquí mismo. Y el índice único `(kind, target_ref)`
      // de 0028 sigue garantizando un solo aviso por pedido.
      await notifyDeliveryGroup(orderId, undefined, 'cash_confirmed');
    },

    isRainSurchargeActive: () => readRainSurcharge(supabase),

    alert: buildAlert(),
  };
}

/** Cotiza un delivery dinámico ya con GPS (server-only). Nunca lanza. */
export async function quoteDynamicDeliveryForOrder(orderId: string): Promise<QuoteOutcome> {
  const outcome = await quoteDynamicOrder(createQuoteOrchestratorDeps(), orderId);

  // El orquestador es puro y no puede registrar nada; aquí sí. Sin esto, los
  // tres desenlaces sin cotización eran indistinguibles del éxito: el pedido
  // quedaba en `awaiting_location` y no había nada que mirar.
  //
  // Ninguno de estos campos lleva secretos: `order_id` es un uuid, y `reason` /
  // `error` son mensajes de configuración o enums de Mapbox. El token jamás
  // aparece en ellos.
  if (outcome.result === 'error') {
    log.error('delivery_quote_error', { order_id: orderId, reason: outcome.reason });
  } else if (outcome.result === 'failed') {
    log.warn('delivery_quote_failed', { order_id: orderId, error: outcome.error });
  } else if (outcome.result === 'skipped') {
    log.info('delivery_quote_skipped', { order_id: orderId, reason: outcome.reason });
  }

  return outcome;
}
