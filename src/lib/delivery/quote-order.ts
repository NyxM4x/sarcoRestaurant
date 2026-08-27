import type { DeliveryPricing, DeliveryQuoteStatus, DeliveryType, OrderStatus } from '@/types';
import type { MapboxDistanceResult } from './mapbox';
import { feeForMeters } from './fee';

/**
 * Orquestador de cotización dinámica (Fase 6D.2C) — módulo PURO.
 *
 * NO importa Supabase, Mapbox ni Kapso: todo llega por `QuoteOrchestratorDeps`.
 * NO define tarifa (usa `./fee`) ni arma URLs de Mapbox (eso es `./mapbox`). Es
 * la pieza que, tras guardarse el GPS de un delivery dinámico, decide entre:
 *   - cotización EXITOSA        → apply_delivery_quote → confirmación;
 *   - fuera de cobertura (>18km) → mark_delivery_quote_result('out_of_coverage')
 *                                 → mensaje best-effort al cliente;
 *   - fallo técnico de Mapbox   → mark_delivery_quote_result('failed').
 *
 * GARANTÍA: nunca lanza hacia el caller (el webhook). Cualquier error se traduce
 * a un `QuoteOutcome` tipado y seguro. NUNCA registra el token de Mapbox.
 */

/** Vista mínima del pedido necesaria para cotizar (resuelta desde la base). */
export interface QuoteOrderRow {
  id: string;
  order_number: string;
  delivery_type: DeliveryType;
  delivery_pricing: DeliveryPricing | null;
  delivery_quote_status: DeliveryQuoteStatus | null;
  status: OrderStatus;
  delivery_latitude: number | null;
  delivery_longitude: number | null;
  customer_phone: string;
  phone_number_id: string;
}

/** Resultado de `apply_delivery_quote` (0009), ya saneado. */
export type QuoteApplyResult = { result: 'applied' | 'already_applied' | 'conflict' | 'error' };

/** Resultado de `mark_delivery_quote_result` (0010), ya saneado. */
export type QuoteMarkResult = { result: 'applied' | 'already_applied' | 'conflict' | 'error' };

export interface QuoteOrchestratorDeps {
  /** Carga el pedido (GPS + estado de pricing + destinatario). `null` si no existe. */
  loadForQuote(orderId: string): Promise<QuoteOrderRow | null>;
  /**
   * Distancia de ruta real Don Zarco → destino. La implementación server-only ya
   * conoce el origen (RESTAURANT_LAT/LNG) y el token; aquí solo llega el destino.
   */
  getDistanceMeters(destination: { lat: number; lng: number }): Promise<MapboxDistanceResult>;
  /** `apply_delivery_quote(order, distance, amount)`. */
  applyQuote(
    orderId: string,
    distanceMeters: number,
    deliveryAmount: number,
  ): Promise<QuoteApplyResult>;
  /** `mark_delivery_quote_result(order, status, distance)`. */
  markQuoteResult(
    orderId: string,
    status: 'failed' | 'out_of_coverage',
    distanceMeters: number | null,
  ): Promise<QuoteMarkResult>;
  /** Mensaje best-effort "fuera de cobertura" (texto directo, sin fila durable). */
  sendOutOfCoverageMessage(order: QuoteOrderRow): Promise<void>;
  /** Habilita/dispara la confirmación tras una cotización válida (durable + directo). */
  dispatchConfirmation(orderId: string): Promise<void>;
  /** Alerta interna best-effort (opcional): fuera de cobertura y fallos de auth. */
  alert?(text: string): Promise<void>;
  /**
   * ¿Está activa la tarifa de lluvia? La enciende el encargado desde el panel.
   *
   * Se consulta AQUÍ, en el momento de cotizar, y no se guarda en el pedido: lo
   * que queda escrito es el importe final. Un pedido ya cotizado conserva su
   * precio aunque el encargado apague el recargo un minuto después — el cliente
   * vio una cifra y esa es la que vale.
   *
   * Opcional: sin este puerto no hay recargo, que es el comportamiento de antes.
   * Si la consulta falla, se cobra SIN recargo: es mejor cobrar 3 Bs de menos que
   * cobrar de más por un fallo técnico que el cliente no puede ni ver.
   */
  isRainSurchargeActive?(): Promise<boolean>;
}

export type QuoteOutcome =
  | { result: 'quoted'; distanceMeters: number; amount: number; apply: 'applied' | 'already_applied' }
  | { result: 'out_of_coverage'; distanceMeters: number; mark: QuoteMarkResult['result'] }
  | { result: 'failed'; error: string }
  | { result: 'conflict' }
  | { result: 'skipped'; reason: string }
  /** `reason` es el mensaje del error atrapado; nunca lleva valores de config. */
  | { result: 'error'; reason: string };

/**
 * Errores de Mapbox que SÍ ameritan un reintento inmediato (transitorios). El
 * resto (auth, sin ruta, respuesta inválida, coordenadas inválidas) no se
 * reintenta: reintentar no cambiaría el resultado.
 */
const TRANSIENT_MAPBOX_ERRORS: ReadonlySet<string> = new Set([
  'timeout',
  'network_error',
  'http_5xx',
  'http_error',
]);

/** Máximo 1 intento inicial + 1 reintento inmediato, solo para errores transitorios. */
async function distanceWithRetry(
  deps: QuoteOrchestratorDeps,
  destination: { lat: number; lng: number },
): Promise<MapboxDistanceResult> {
  const first = await deps.getDistanceMeters(destination);
  if (first.ok) return first;
  if (TRANSIENT_MAPBOX_ERRORS.has(first.error)) {
    return deps.getDistanceMeters(destination);
  }
  return first;
}

function validDestination(order: QuoteOrderRow): { lat: number; lng: number } | null {
  const { delivery_latitude: lat, delivery_longitude: lng } = order;
  if (
    typeof lat !== 'number' ||
    typeof lng !== 'number' ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lng)
  ) {
    return null;
  }
  return { lat, lng };
}

/** Ejecuta un efecto best-effort sin propagar (mensajes/alertas nunca tumban la cotización). */
async function safe(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch {
    // Best-effort: un fallo aquí no revierte la cotización ya persistida.
  }
}

async function safeAlert(deps: QuoteOrchestratorDeps, text: string): Promise<void> {
  if (!deps.alert) return;
  const alert = deps.alert;
  await safe(() => alert(text));
}

/**
 * Cotiza (o marca el resultado de) un delivery dinámico. Idempotente y seguro
 * ante reenvíos: relee el pedido y decide por `delivery_pricing` / `status` /
 * `delivery_quote_status`, NO por "es la primera ubicación". Un pedido ya
 * `quoted` u `out_of_coverage` no se recotiza.
 */
export async function quoteDynamicOrder(
  deps: QuoteOrchestratorDeps,
  orderId: string,
): Promise<QuoteOutcome> {
  try {
    const order = await deps.loadForQuote(orderId);
    if (!order) return { result: 'skipped', reason: 'order_not_found' };

    // Solo delivery dinámico.
    if (order.delivery_type !== 'delivery' || order.delivery_pricing !== 'dynamic') {
      return { result: 'skipped', reason: 'not_dynamic' };
    }
    // Solo mientras espera ubicación (quoted ya confirmó; nada que hacer).
    if (order.status !== 'awaiting_location') {
      return { result: 'skipped', reason: 'not_awaiting_location' };
    }
    // Solo estados pre-cotización. quoted / out_of_coverage NO se recotizan.
    if (
      order.delivery_quote_status !== 'pending' &&
      order.delivery_quote_status !== 'failed'
    ) {
      return { result: 'skipped', reason: 'not_quotable' };
    }

    const destination = validDestination(order);
    if (!destination) return { result: 'skipped', reason: 'missing_gps' };

    // 1. Distancia real por calle (con 1 reintento para transitorios).
    const distance = await distanceWithRetry(deps, destination);
    if (!distance.ok) {
      await deps.markQuoteResult(orderId, 'failed', null);
      if (distance.error === 'http_401' || distance.error === 'http_403') {
        // Config de Mapbox rota: no se reintenta a ciegas; se alerta a staff.
        await safeAlert(deps, `delivery_quote_auth_error order=${order.order_number}`);
      }
      return { result: 'failed', error: distance.error };
    }

    // 2. Tarifa / cobertura (fee.ts es la autoridad de negocio).
    //
    // El recargo por lluvia se consulta ahora, no al recibir el pedido: cuenta
    // el momento en que se fija el precio. Si la consulta falla se cobra sin
    // recargo — perder 3 Bs es preferible a cobrárselos a alguien por un fallo
    // técnico que no puede ver ni discutir.
    let rain = false;
    if (deps.isRainSurchargeActive) {
      try {
        rain = await deps.isRainSurchargeActive();
      } catch {
        rain = false;
      }
    }

    const fee = feeForMeters(distance.distanceMeters, { rain });
    if (!fee.ok) {
      if (fee.reason === 'out_of_coverage') {
        const mark = await deps.markQuoteResult(
          orderId,
          'out_of_coverage',
          distance.distanceMeters,
        );
        // El mensaje al cliente SOLO en la transición REAL (applied), nunca en
        // already_applied ni conflict: evita duplicados ante reenvíos/reintentos.
        if (mark.result === 'applied') {
          await safe(() => deps.sendOutOfCoverageMessage(order));
          await safeAlert(deps, `delivery_out_of_coverage order=${order.order_number}`);
        }
        return { result: 'out_of_coverage', distanceMeters: distance.distanceMeters, mark: mark.result };
      }
      // invalid_distance no debería ocurrir (Mapbox da entero ≥ 0); se trata como fallo.
      await deps.markQuoteResult(orderId, 'failed', null);
      return { result: 'failed', error: 'invalid_distance' };
    }

    // 3. Cotización exitosa: apply atómico (money guard re-valida la tarifa).
    const apply = await deps.applyQuote(orderId, distance.distanceMeters, fee.amount);
    if (apply.result === 'applied' || apply.result === 'already_applied') {
      // La claim SQL sigue siendo la barrera atómica; esto es el disparo rápido.
      await safe(() => deps.dispatchConfirmation(orderId));
      return {
        result: 'quoted',
        distanceMeters: distance.distanceMeters,
        amount: fee.amount,
        apply: apply.result,
      };
    }
    // conflict / error: una cotización cerrada nunca se pisa y no se confirma aquí.
    return { result: 'conflict' };
  } catch (error) {
    // Defensa final: el orquestador nunca propaga hacia el webhook.
    //
    // Pero el MOTIVO sí sale, porque tragarlo en silencio costaba carísimo: si
    // `getDeliveryConfig()` lanza (una variable de Mapbox ausente o inválida),
    // no se llega a `markQuoteResult`, el pedido se queda en `pending` para
    // siempre y no hay una sola línea que diga por qué. Quien loguea es
    // `quoteDynamicDeliveryForOrder`, que sí es server-only; este módulo
    // sigue siendo puro.
    //
    // `getDeliveryConfig` construye su mensaje con los NOMBRES de las variables
    // faltantes, nunca sus valores: por eso es seguro propagarlo.
    return { result: 'error', reason: error instanceof Error ? error.message : 'unknown' };
  }
}
