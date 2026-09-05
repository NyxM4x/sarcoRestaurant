import { after, NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
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
import { lookupCustomerState } from '@/lib/webhook/customer-state-service';
import { sendProofReminder } from '@/lib/kapso/send-proof-reminder';
import { appendKitchenNote } from '@/lib/orders/kitchen-note-service';
import { sendOrderReview, sendOrderReviewKept } from '@/lib/kapso/send-order-review';
import { cancelCashOrder, confirmCashOrder } from '@/lib/orders/cash-confirm-service';
import { switchOrderToPickup } from '@/lib/orders/pickup-switch-service';
import { createSupabaseWebhookStore } from '@/lib/webhook/store';
import {
  acceptKapsoWebhook,
  handleKapsoWebhook,
  processWebhookEvent,
  type HandleKapsoWebhookParams,
} from '@/lib/webhook/kapso';

// Requiere APIs de Node (crypto, service_role) — no Edge. Siempre dinámico.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// 6D.2C: al recibir la ubicación de un delivery dinámico se consulta Mapbox
// (con un reintento) y se envía la confirmación de forma síncrona; se amplía el
// presupuesto de la invocación como en la ruta de checkout.
//
// 6D.2F.5C.1: en modo asíncrono el trabajo de `after()` corre dentro de este
// mismo presupuesto, y el lease del inbox (90 s) está por encima a propósito.
export const maxDuration = 60;

/**
 * POST /api/kapso/webhook.
 *
 * Dos modos, UNA implementación del negocio:
 *
 *   inline (por defecto)  accept + process antes de responder. Es exactamente
 *                         el comportamiento anterior a 5C.1, cuerpos incluidos.
 *   async                 accept → 200 → `after()` procesa.
 *
 * El fast path del takeover humano es síncrono en LOS DOS: una pausa que llega
 * tarde no sirve para nada, porque el turno del agente la habría consultado
 * antes de que estuviera escrita.
 */
export async function POST(request: Request): Promise<Response> {
  const env = getServerEnv();

  // El body crudo es necesario para validar el HMAC de la firma.
  const rawBody = await request.text();

  const headers = {
    signature: request.headers.get('x-webhook-signature'),
    version: request.headers.get('x-webhook-payload-version'),
    event: request.headers.get('x-webhook-event'),
    idempotencyKey: request.headers.get('x-idempotency-key'),
  };

  const startedAt = Date.now();

  try {
    const supabase: SupabaseClient = getSupabaseAdmin();
    const params: HandleKapsoWebhookParams = {
      rawBody,
      headers,
      secret: env.KAPSO_WEBHOOK_SECRET ?? '',
      store: createSupabaseWebhookStore(supabase),
      confirmOrder: confirmDraftOrder,
      ensureLocationRequest: ensureLocationRequestForOrder,
      attachOrderLocation: attachLocationForOrder,
      sendMenuCta: sendMenuCtaMessage,
      // Fase 6D.2C: cotización de delivery dinámico tras guardar el GPS.
      quoteDynamicDelivery: quoteDynamicDeliveryForOrder,
      // 0027: cotización de un pin suelto, antes de que exista ningún pedido.
      quoteStandaloneLocation: (input) => quoteStandaloneLocation(input),
      // 0028: el pin que llega sin contexto pero con un pedido esperándolo. Va
      // antes que la cotización suelta: primero se mira si alguien lo espera.
      attachLooseLocation: (input) => attachLooseLocationForOrder(input),
      // 0029: la ubicación que llega como link de Google Maps en vez de pin.
      // Solo la expansión sale a la red; leer las coordenadas es puro.
      expandMapsLink: (url) => expandMapsLink(url),
      // 0027: "¿cuánto sale el envío?" se contesta pidiendo la ubicación, sin
      // pasar por el modelo — medido, el modelo lo derivaba a una persona.
      askLocationForQuote: (input) => askLocationForQuote(input),
      // Avisa al equipo del cliente que escribe y escribe sin conseguir pedir.
      checkStuckCustomer: (phone) => escalateIfStuck(phone),
      // 03-09-2026: el botón del menú es la respuesta por defecto de todo texto
      // que ninguna otra puerta atendió. Estos dos puertos son los que hacen
      // posible que tenga excepciones —un humano atendiendo, un pedido en
      // curso—; sin ellos no sale nada por defecto y el texto cae en el agente,
      // que es el comportamiento anterior. Ver `webhook/default-reply.ts`.
      lookupCustomerState: (phone) => lookupCustomerState(phone),
      sendProofReminder: (input) => sendProofReminder(input),
      // 05-09-2026: antes del botón de modificar se le enseña lo que armó y se
      // le pregunta si le falta algo. Ver `kapso/send-order-review.ts`.
      sendOrderReview: ({ kept, ...input }) =>
        kept ? sendOrderReviewKept(input) : sendOrderReview(input),
      // 05-09-2026: el pedido en efectivo no entra a cocina ni sale al grupo de
      // reparto hasta que el cliente escribe CONFIRMO. Ver 0036 y
      // `orders/cash-confirm-service.ts`.
      decideCashOrder: ({ decision, ...input }) =>
        decision === 'confirm' ? confirmCashOrder(input) : cancelCashOrder(input),
      // 04-09-2026: "sin cebolla" no es rearmar el pedido — se anota en la
      // comanda y se le contesta que sí. Ver `webhook/order-change-intent.ts`.
      appendKitchenNote: (input) => appendKitchenNote(input),
      switchToPickup: (input) => switchOrderToPickup(input),
      // Fase 5.2D.5C: reconciliación de eventos salientes de Kapso.
      outbound: createSupabaseOutboundStore(supabase),
      // Fase 6D.2F.2B: historial del cliente + human takeover.
      agentChannel: createAgentChannel(),
      // Cubre las vias inline y asincrona: ambas comparten estos params.
      paymentProofIntake: intakePaymentProof,
    };

    // Solo la cadena 'true' enciende el ACK durable.
    const asyncAck = env.WEBHOOK_ASYNC_ACK === 'true';

    const accepted = asyncAck ? await acceptKapsoWebhook(params) : null;
    const result = accepted ?? (await handleKapsoWebhook(params));
    const ackDurationMs = Date.now() - startedAt;

    if (accepted?.pending) {
      const { rowId } = accepted.pending;
      // `after()` es el fast path de LATENCIA, no la durabilidad: la fila ya
      // está escrita, así que si esto no llega a correr —o muere a mitad— el
      // lease vence y el worker de recovery la recoge.
      after(async () => {
        const processingStartedAt = Date.now();
        try {
          const processed = await processWebhookEvent(rowId, params);
          log.info('webhook_processed_async', {
            event: headers.event,
            outcome: processed.outcome,
            processing_duration_ms: Date.now() - processingStartedAt,
          });
        } catch {
          // `processWebhookEvent` ya deja la fila reclamable o terminal por sí
          // mismo. Esto solo evita una promesa rechazada sin dueño.
          log.error('webhook_async_processing_failed', { event: headers.event });
        }
      });
    }

    // Logs estructurados sin secretos (nunca firma, secreto ni payload completo).
    const logFields = { event: headers.event, outcome: result.outcome, ack_duration_ms: ackDurationMs };
    if (result.outcome === 'unsupported_batch') {
      // Mala configuración: el webhook de Kapso debe estar SIN buffering.
      log.warn('webhook_unsupported_batch', {
        ...logFields,
        hint: 'configure_kapso_webhook_without_buffering',
      });
    } else if (result.outcome === 'invalid_signature') {
      log.warn('webhook_rejected', logFields);
    } else if (result.body.handled === 'menu_cta' && result.body.result === 'sent') {
      // Fase 5.2A. Sin teléfono (ni siquiera enmascarado) ni URL de la API:
      // el wamid del CTA no se persiste porque no hay pedido al que asociarlo.
      log.info('menu_cta_sent', logFields);
    } else if (result.body.handled === 'location') {
      // El motivo del rechazo viajaba SOLO en el body HTTP hacia Kapso y aquí
      // se descartaba: en Vercel un `not_found` era indistinguible de un
      // `attached`, y los cuatro modos de fallo de la correlación
      // (`invalid_shape`, `not_found`, `phone_mismatch`, `invalid_status`) se
      // veían igual — como un `webhook_handled` cualquiera.
      //
      // Sin coordenadas ni teléfono: `result` y `reason` son enums cerrados de
      // `AttachLocationResult`, no datos del cliente.
      log.info('webhook_location', {
        ...logFields,
        result: result.body.result,
        reason: result.body.reason ?? null,
      });
    } else {
      log.info('webhook_handled', logFields);
    }

    return NextResponse.json(result.body, { status: result.status });
  } catch (error) {
    log.error('webhook_unhandled_error', {
      event: headers.event,
      reason: error instanceof Error ? error.message : 'unknown',
    });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
