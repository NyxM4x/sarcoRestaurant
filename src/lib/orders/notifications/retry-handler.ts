import { z } from 'zod';
import { extractBearer, safeCompare } from '@/lib/security/auth';
import { log } from '@/lib/log';
import type { DispatchResult } from './web-notify';
import type { NotificationType } from './web-notify';
import {
  planOrderRetry,
  type NotificationStatesResult,
  type RetryRejectionReason,
} from './retry-plan';

/**
 * Handler del reintento interno de notificaciones (Fases 5.2D.4 + 5.2D.5B.2).
 *
 * Recuperación MANUAL y explícita: una persona autorizada indica un `order_id`
 * concreto. No escanea pedidos ni acepta `order_number`.
 *
 * CAMBIO DE 5.2D.5B.2 — el endpoint ya NO inicializa notificaciones. Antes
 * usaba `initializeAndDispatch`, que sobre un pedido antiguo podía CREAR filas
 * nuevas con `next_attempt_at = now()` y convertirlo en trabajo pendiente para
 * el futuro worker. Ahora:
 *   1. lee el estado real de las filas EXISTENTES (0005);
 *   2. decide con un planificador puro si algún envío es seguro;
 *   3. programa con `schedule_notification_send` solo los `failed` NO ambiguos;
 *   4. despacha con `dispatchExisting`, que nunca crea filas.
 *
 * Un pedido sin notificaciones devuelve `not_found`: no se le inventan.
 *
 * El request nunca puede indicar el destino ni el estado: ni teléfono, ni
 * phone_number_id, ni texto, ni wamid, ni notification_type, ni fechas. Todo se
 * resuelve desde la base de datos.
 */

/** Único cuerpo aceptado. `strictObject` rechaza cualquier campo extra. */
export const retryRequestSchema = z.strictObject({
  order_id: z.uuid(),
});

export interface NotificationRetryDeps {
  /** Token interno configurado. Ausente o vacío = no configurado. */
  internalToken?: string | null;
  /** Estado de recuperación de las filas existentes del pedido. */
  loadStates(orderId: string): Promise<NotificationStatesResult>;
  /** `schedule_notification_send` para un `failed` no ambiguo. */
  scheduleSend(orderId: string, notificationType: NotificationType): Promise<boolean>;
  /**
   * Dispatch SOLO de notificaciones existentes. La ruta real inyecta
   * `dispatchExistingWebOrderWhatsApp`; nunca `initializeAndDispatch`.
   */
  dispatch(orderId: string): Promise<DispatchResult>;
  /** Reloj inyectable para las pruebas. */
  now?(): number;
}

/** Resultado global del reintento, sanitizado. */
export type RetryOutcome =
  | 'dispatched'
  | 'scheduled_and_dispatched'
  | RetryRejectionReason;

function jsonResponse(status: number, body: unknown): Response {
  return Response.json(body, { status });
}

/**
 * `POST /api/internal/order-notifications/retry`.
 *
 * Nunca devuelve teléfono, phone_number_id, claim_token, wamid, nombres,
 * productos, texto enviado ni mensajes técnicos.
 */
export async function handleNotificationRetry(
  request: Request,
  deps: NotificationRetryDeps,
): Promise<Response> {
  // 1. Autenticación. Sin token configurado se responde igual que con un token
  // inválido (401): no se revela el estado de configuración.
  const provided = extractBearer(request.headers.get('authorization'));
  if (!deps.internalToken || !safeCompare(provided, deps.internalToken)) {
    return jsonResponse(401, { error: 'unauthorized' });
  }

  // 2. Cuerpo JSON.
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return jsonResponse(400, { error: 'invalid_json' });
  }

  // 3. Contrato. No se reflejan los valores recibidos: podrían traer un token.
  const parsed = retryRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return jsonResponse(422, { error: 'validation_error' });
  }
  const orderId = parsed.data.order_id;

  try {
    const now = deps.now ? deps.now() : Date.now();
    const states = await deps.loadStates(orderId);

    // Sin NINGUNA fila (ni conocida ni desconocida) no se inicializa nada: un
    // pedido histórico jamás se reactiva desde aquí.
    if (states.rows.length === 0 && states.unknownStateCount === 0) {
      return respond(orderId, 'not_found', null);
    }

    // Filas existentes que no sabemos interpretar NO son un pedido inexistente.
    // Se registra solo el recuento; nunca el contenido de la fila.
    if (states.unknownStateCount > 0) {
      log.warn('internal.order_notifications.unknown_state', {
        order_id: orderId,
        unknown_rows: states.unknownStateCount,
      });
    }

    const plan = planOrderRetry(states, now);

    // Ningún envío es seguro: se informa el motivo de la confirmación (o el de
    // la ubicación si la confirmación no aplica).
    if (!plan.willDispatch) {
      const reason =
        plan.orderReceived?.reason ??
        plan.confirmation.reason ??
        plan.locationRequest?.reason ??
        'unknown';
      return respond(orderId, reason, null);
    }

    // Programar solo lo estrictamente necesario, antes de despachar.
    let scheduledAny = false;
    for (const type of plan.toSchedule) {
      // Si la RPC rechaza (ambiguo, terminal, intentos agotados), se continúa:
      // el claim posterior volverá a rechazarlo y el dispatch lo reportará.
      const scheduled = await deps.scheduleSend(orderId, type);
      scheduledAny = scheduledAny || scheduled;
    }

    const result = await deps.dispatch(orderId);
    return respond(orderId, scheduledAny ? 'scheduled_and_dispatched' : 'dispatched', result);
  } catch {
    // Sin error.message: nada técnico sale ni al log ni a la respuesta.
    log.error('internal.order_notifications.retry_failed', { order_id: orderId });
    return jsonResponse(500, { error: 'internal_error' });
  }
}

/**
 * Respuesta sanitizada. Mantiene `confirmation` / `location_request` / `reason`
 * del contrato anterior para no romper al consumidor actual, y añade `outcome`
 * con la decisión global.
 */
function respond(
  orderId: string,
  outcome: RetryOutcome,
  result: DispatchResult | null,
): Response {
  const body = {
    ok: result ? result.ok : false,
    order_id: orderId,
    outcome,
    confirmation: result?.confirmation ?? null,
    location_request: result?.locationRequest ?? null,
    reason: result?.reason ?? null,
  };

  log.info('internal.order_notifications.retry', body);

  // 200 aunque el resultado operativo sea un rechazo: la petición se atendió
  // correctamente y el estado se reporta en el cuerpo.
  return jsonResponse(200, body);
}
