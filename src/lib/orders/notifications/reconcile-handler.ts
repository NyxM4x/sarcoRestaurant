import { z } from 'zod';
import { extractBearer, safeCompare } from '@/lib/security/auth';
import { log } from '@/lib/log';
import { reconcileOrder, type ReconcileDeps } from './reconcile-runner';

/**
 * Handler de la reconciliación MANUAL de notificaciones (Fase 5.2D.5C).
 *
 * Una persona autorizada indica un `order_id` concreto. El endpoint SOLO trabaja
 * sobre notificaciones existentes del pedido: consulta `GET /messages`, decide
 * con módulos puros y persiste con las RPC de 0005. NUNCA envía un mensaje ni
 * inicializa notificaciones para pedidos históricos.
 *
 * El request nunca indica destino ni estado: ni teléfono, ni notification_type,
 * ni wamid, ni timestamps, ni filtros de Kapso. Todo se resuelve desde la base.
 */

/** Único cuerpo aceptado. `strictObject` rechaza cualquier campo extra. */
export const reconcileRequestSchema = z.strictObject({
  order_id: z.uuid(),
});

export interface NotificationReconcileDeps extends ReconcileDeps {
  /** Token interno configurado. Ausente o vacío = no configurado. */
  internalToken?: string | null;
}

function jsonResponse(status: number, body: unknown): Response {
  return Response.json(body, { status });
}

/**
 * `POST /api/internal/order-notifications/reconcile`.
 *
 * Nunca devuelve teléfono, phone_number_id, claim_token, wamid, conversation_id,
 * coordenadas ni cuerpos de mensajes.
 */
export async function handleNotificationReconcile(
  request: Request,
  deps: NotificationReconcileDeps,
): Promise<Response> {
  // 1. Autenticación. Sin token configurado se responde como con token inválido.
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

  // 3. Contrato estricto. No se reflejan los valores recibidos.
  const parsed = reconcileRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return jsonResponse(422, { error: 'validation_error' });
  }
  const orderId = parsed.data.order_id;

  try {
    const result = await reconcileOrder(orderId, deps);

    const body = {
      ok: result.ok,
      order_id: orderId,
      order_received: result.orderReceived,
      confirmation: result.confirmation,
      location_request: result.locationRequest,
      reason: result.reason,
    };

    // Log estructurado y saneado: solo el order_id y los outcomes por tipo.
    log.info('internal.order_notifications.reconcile', body);

    return jsonResponse(200, body);
  } catch {
    // Sin error.message: nada técnico sale ni al log ni a la respuesta.
    log.error('internal.order_notifications.reconcile_failed', { order_id: orderId });
    return jsonResponse(500, { error: 'internal_error' });
  }
}
