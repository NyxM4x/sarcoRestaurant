import { getServerEnv } from '@/lib/env/env';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import { log } from '@/lib/log';
import {
  attachLocationForOrder,
  confirmDraftOrder,
  ensureLocationRequestForOrder,
} from '@/lib/orders/service';
import { sendMenuCtaMessage } from '@/lib/kapso/send-menu-cta';
import { createSupabaseOutboundStore } from '@/lib/orders/notifications/service';
import { createAgentChannel } from '@/lib/agent/service';
import { quoteDynamicDeliveryForOrder } from '@/lib/delivery/quote-service';
import { createSupabaseDueSelector, createSupabaseWebhookStore } from '@/lib/webhook/store';
import { handleInboxTick } from '@/lib/webhook/inbox-worker';

// Requiere APIs de Node (service_role, POST a Kapso, OpenAI) — no Edge.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Un tick puede llevar varios turnos del agente. El lease del inbox (90 s) está
// por encima a propósito: una fila no vuelve a estar disponible mientras esta
// invocación siga viva.
export const maxDuration = 60;

/**
 * POST /api/internal/webhook-events/worker/tick
 *
 * Recovery del inbox durable: recoge lo que `after()` no llegó a ejecutar y lo
 * que murió a mitad. El caller no decide qué fila se procesa — la elige la base
 * con `claim_due_webhook_events`.
 *
 * Protegido con el Bearer interno (`INTERNAL_API_TOKEN`), igual que el
 * worker de notificaciones. La ruta solo cablea dependencias.
 */
export async function POST(request: Request): Promise<Response> {
  let internalToken: string | undefined;
  try {
    internalToken = getServerEnv().INTERNAL_API_TOKEN;
  } catch {
    log.error('webhook_inbox_worker_env_unavailable');
    return Response.json({ error: 'internal_error' }, { status: 500 });
  }

  let deps;
  try {
    const env = getServerEnv();
    const supabase = getSupabaseAdmin();
    deps = {
      internalToken,
      selector: createSupabaseDueSelector(supabase),
      // EXACTAMENTE las mismas dependencias que el webhook: el recovery no
      // ejecuta una versión reducida del negocio, ejecuta el negocio.
      processing: {
        // El reproceso trabaja desde el `payload` guardado, así que no hay
        // request del que sacar cuerpo ni cabeceras. La firma ya se verificó
        // cuando el evento se aceptó: no se vuelve a comprobar sobre una fila
        // que ya está dentro, y por eso este endpoint exige Bearer interno.
        rawBody: '',
        headers: { signature: null, version: null, event: null, idempotencyKey: null },
        secret: env.KAPSO_WEBHOOK_SECRET ?? '',
        store: createSupabaseWebhookStore(supabase),
        confirmOrder: confirmDraftOrder,
        ensureLocationRequest: ensureLocationRequestForOrder,
        attachOrderLocation: attachLocationForOrder,
        sendMenuCta: sendMenuCtaMessage,
        quoteDynamicDelivery: quoteDynamicDeliveryForOrder,
        outbound: createSupabaseOutboundStore(supabase),
        agentChannel: createAgentChannel(),
      },
    };
  } catch {
    log.error('webhook_inbox_worker_deps_unavailable');
    return Response.json({ error: 'internal_error' }, { status: 500 });
  }

  return handleInboxTick(request, deps);
}
