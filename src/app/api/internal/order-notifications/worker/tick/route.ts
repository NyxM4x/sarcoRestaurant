import { getServerEnv } from '@/lib/env/env';
import { log } from '@/lib/log';
import { handleWorkerTick } from '@/lib/orders/notifications/worker-handler';
import { buildWorkerDeps } from '@/lib/orders/notifications/service';

// Requiere APIs de Node (crypto, service_role, GET/POST a Kapso) — no Edge.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Un tick puede reconciliar (hasta 2 GET) y enviar (1 POST) antes de responder.
export const maxDuration = 60;

/**
 * POST /api/internal/order-notifications/worker/tick
 *
 * Worker interno de recuperación de notificaciones. Procesa únicamente el
 * trabajo VENCIDO que selecciona la base (`select_due_notification_orders`),
 * con presupuesto acotado (≤1 POST y ≤2 GET por tick) e idempotente. El caller
 * no decide qué pedido, notificación ni cliente se procesa.
 *
 * Protegido con el Bearer interno (`INTERNAL_API_TOKEN`). La ruta solo cablea
 * dependencias; la lógica vive en `@/lib/orders/notifications/worker`.
 */
export async function POST(request: Request): Promise<Response> {
  let internalToken: string | undefined;
  try {
    internalToken = getServerEnv().INTERNAL_API_TOKEN;
  } catch {
    log.error('internal.order_notifications.worker_env_unavailable');
    return Response.json({ error: 'internal_error' }, { status: 500 });
  }

  let deps;
  try {
    deps = buildWorkerDeps();
  } catch {
    // Faltan credenciales de Kapso/Supabase: el worker no puede arrancar.
    log.error('internal.order_notifications.worker_deps_unavailable');
    return Response.json({ error: 'internal_error' }, { status: 500 });
  }

  return handleWorkerTick(request, { internalToken, ...deps });
}
