import { getServerEnv } from '@/lib/env/env';
import { log } from '@/lib/log';
import { handleNotificationReconcile } from '@/lib/orders/notifications/reconcile-handler';
import { buildWebReconcileDeps } from '@/lib/orders/notifications/service';

// Requiere APIs de Node (crypto, service_role, GET /messages) — no Edge.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// La reconciliación puede consultar el historial de Kapso por cada notificación
// antes de responder; se concede el mismo presupuesto que el reintento.
export const maxDuration = 60;

/**
 * POST /api/internal/order-notifications/reconcile
 *
 * Reconciliación manual de las notificaciones de un pedido web concreto.
 * Protegido con el Bearer interno (`INTERNAL_API_TOKEN`).
 *
 * Opera SOLO sobre notificaciones existentes: consulta `GET /messages`, decide
 * con módulos puros y persiste con las RPC de 0005. NUNCA envía un mensaje ni
 * inicializa notificaciones para pedidos históricos. La ruta solo cablea
 * dependencias; la lógica vive en `@/lib/orders/notifications/reconcile-handler`.
 */
export async function POST(request: Request): Promise<Response> {
  let internalToken: string | undefined;
  try {
    internalToken = getServerEnv().INTERNAL_API_TOKEN;
  } catch {
    log.error('internal.order_notifications.reconcile_env_unavailable');
    return Response.json({ error: 'internal_error' }, { status: 500 });
  }

  let deps;
  try {
    deps = buildWebReconcileDeps();
  } catch {
    // Faltan credenciales de Kapso/Supabase: nunca se detalla qué falta.
    log.error('internal.order_notifications.reconcile_deps_unavailable');
    return Response.json({ error: 'internal_error' }, { status: 500 });
  }

  return handleNotificationReconcile(request, { internalToken, ...deps });
}
