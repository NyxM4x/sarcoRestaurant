import { getServerEnv } from '@/lib/env/env';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import { log } from '@/lib/log';
import {
  attachLocationForOrder,
  attachLooseLocationForOrder,
  confirmDraftOrder,
  ensureLocationRequestForOrder,
} from '@/lib/orders/service';
import { sendMenuCtaMessage } from '@/lib/kapso/send-menu-cta';
import { createSupabaseOutboundStore } from '@/lib/orders/notifications/service';
import { createAgentChannel } from '@/lib/agent/service';
import { intakePaymentProof } from '@/lib/payment-proof/intake-service';
import { quoteDynamicDeliveryForOrder } from '@/lib/delivery/quote-service';
import {
  askLocationForQuote,
  quoteStandaloneLocation,
} from '@/lib/delivery/quote-request-service';
import { expandMapsLink } from '@/lib/delivery/maps-link-service';
import { escalateIfStuck } from '@/lib/agent/handoff/stuck-customer-service';
import { createSupabaseDueSelector, createSupabaseWebhookStore } from '@/lib/webhook/store';
import { handleInboxTick, type InboxWorkerDeps } from '@/lib/webhook/inbox-worker';

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

  // Anotado, y no inferido: `InboxWorkerDeps.processing` es el MISMO tipo que
  // usa la ruta del webhook, así que un puerto mal escrito falla al compilar en
  // vez de quedarse sin cablear en silencio.
  let deps: InboxWorkerDeps;
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
        // Estas cuatro faltaban, y su ausencia no se veía: el mismo mensaje
        // salía atendido o en silencio según quién lo procesara. Un pin suelto
        // recogido por el recovery no se cotizaba, un "¿cuánto sale el envío?"
        // caía en el modelo, un pin sin contexto no encontraba su pedido y el
        // cliente atascado no se escalaba — todo con la fila marcada
        // `processed`, que es la peor forma de fallar.
        //
        // El comentario de arriba dice "EXACTAMENTE las mismas dependencias que
        // el webhook". Ahora lo son.
        quoteStandaloneLocation: (input) => quoteStandaloneLocation(input),
        attachLooseLocation: (input) => attachLooseLocationForOrder(input),
        expandMapsLink: (url) => expandMapsLink(url),
        askLocationForQuote: (input) => askLocationForQuote(input),
        checkStuckCustomer: (phone) => escalateIfStuck(phone),
        outbound: createSupabaseOutboundStore(supabase),
        agentChannel: createAgentChannel(),
        // Vía del worker: el mismo motor canonico que las otras dos.
        paymentProofIntake: intakePaymentProof,
      },
    };
  } catch {
    log.error('webhook_inbox_worker_deps_unavailable');
    return Response.json({ error: 'internal_error' }, { status: 500 });
  }

  return handleInboxTick(request, deps);
}
