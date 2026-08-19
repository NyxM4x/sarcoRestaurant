import { getServerEnv } from '@/lib/env/env';
import { log } from '@/lib/log';
import { handleNotificationRetry } from '@/lib/orders/notifications/retry-handler';
import {
  dispatchExistingWebOrderWhatsApp,
  loadWebOrderNotificationStates,
  scheduleWebOrderNotificationSend,
} from '@/lib/orders/notifications/service';

// Requiere APIs de Node (crypto, service_role) — no Edge. Siempre dinámico.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// A diferencia del checkout, aquí se ESPERA el dispatch (sin `after()`): puede
// implicar dos llamadas a Kapso antes de responder.
export const maxDuration = 60;

/**
 * POST /api/internal/order-notifications/retry
 *
 * Recuperación manual de las notificaciones de un pedido web concreto.
 * Protegido con el Bearer interno (`VERCEL_INTERNAL_TOKEN`).
 *
 * Usa `dispatchExistingWebOrderWhatsApp` (nunca `initializeAndDispatch`): el
 * reintento manual opera SOLO sobre notificaciones ya existentes, de modo que
 * un pedido histórico no puede reactivarse ni convertirse en trabajo pendiente.
 * La ruta solo cablea dependencias; la lógica vive en
 * `@/lib/orders/notifications/retry-handler`.
 */
export async function POST(request: Request): Promise<Response> {
  let internalToken: string | undefined;
  try {
    internalToken = getServerEnv().VERCEL_INTERNAL_TOKEN;
  } catch {
    // Entorno incompleto: nunca se detalla qué falta.
    log.error('internal.order_notifications.env_unavailable');
    return Response.json({ error: 'internal_error' }, { status: 500 });
  }

  return handleNotificationRetry(request, {
    internalToken,
    loadStates: loadWebOrderNotificationStates,
    scheduleSend: scheduleWebOrderNotificationSend,
    dispatch: dispatchExistingWebOrderWhatsApp,
  });
}
