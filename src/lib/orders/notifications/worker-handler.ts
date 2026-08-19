import { z } from 'zod';
import { extractBearer, safeCompare } from '@/lib/security/auth';
import { log } from '@/lib/log';
import { runWorkerTick, type WorkerDeps } from './worker';

/**
 * Handler del tick del worker interno de recuperación (Fase 5.2D.5D).
 *
 * El caller NUNCA decide qué procesar: no acepta order_id, notification_type,
 * teléfono, wamid, estado, claim_token, timestamps, texto, destinatario ni
 * identificadores de cliente. El trabajo lo selecciona exclusivamente la base
 * (`select_due_notification_orders`).
 */

/** Cuerpo aceptado: vacío. `strictObject` rechaza cualquier campo. */
export const workerTickRequestSchema = z.strictObject({});

export interface NotificationWorkerDeps extends WorkerDeps {
  /** Token interno configurado. Ausente o vacío = no configurado. */
  internalToken?: string | null;
}

function jsonResponse(status: number, body: unknown): Response {
  return Response.json(body, { status });
}

/**
 * `POST /api/internal/order-notifications/worker/tick`.
 *
 * Códigos: 401 auth inválida · 405 método incorrecto · 400 JSON inválido ·
 * 422 cuerpo con campos no permitidos · 200 tick ejecutado (aunque una fila
 * aislada falle o se agote el presupuesto) · 500 solo si el worker no pudo
 * arrancar ni seleccionar el trabajo inicial.
 */
export async function handleWorkerTick(
  request: Request,
  deps: NotificationWorkerDeps,
): Promise<Response> {
  // Método: solo POST.
  if (request.method !== 'POST') {
    return jsonResponse(405, { error: 'method_not_allowed' });
  }

  // Autenticación. Sin token configurado se responde como con token inválido.
  const provided = extractBearer(request.headers.get('authorization'));
  if (!deps.internalToken || !safeCompare(provided, deps.internalToken)) {
    return jsonResponse(401, { error: 'unauthorized' });
  }

  // Cuerpo: vacío o {} exactamente. Cualquier campo se rechaza.
  let raw: unknown = {};
  const text = await request.text();
  if (text.trim() !== '') {
    try {
      raw = JSON.parse(text);
    } catch {
      return jsonResponse(400, { error: 'invalid_json' });
    }
  }
  const parsed = workerTickRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return jsonResponse(422, { error: 'validation_error' });
  }

  try {
    const result = await runWorkerTick(deps);
    // Ya viene saneado (recuentos + acciones + outcomes cortos, sin datos
    // sensibles). Se responde 200 aunque haya rechazos o presupuesto agotado.
    return jsonResponse(200, result);
  } catch {
    // Fallo al arrancar o al seleccionar el trabajo inicial: 500 controlado.
    log.error('internal.order_notifications.worker_failed');
    return jsonResponse(500, { error: 'internal_error' });
  }
}
