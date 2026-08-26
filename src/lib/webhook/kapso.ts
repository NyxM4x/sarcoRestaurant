import { verifyHmacSha256 } from '@/lib/security/compare';
import { normalizePhone } from '@/lib/phone';
import { extractMessageContext, parseNfmReply } from '@/lib/flow/nfm';
import { toEnvelopes, type WebhookEnvelope } from './envelopes';
import { isAgentEligibleContent } from '@/lib/agent/core/run';
import { isReactionType } from '@/lib/kapso/channel/reaction';
import { parseLocationMessage } from '@/lib/flow/location-message';
import { isMenuTriggerMessage, isOutboundMessage, extractTextBody } from './menu-trigger';
import { isMenuIntent } from './menu-intent';
import { isOutboundEventName, parseOutboundEvent } from '@/lib/orders/notifications/outbound-event';
import {
  processOutboundEvent,
  type OutboundReconciliationStore,
} from '@/lib/orders/notifications/outbound-webhook';
import { log } from '@/lib/log';
import type { ImageAttachment } from '@/lib/kapso/channel/image';
import {
  dispositionAfterFailure,
  WEBHOOK_LEASE_SECONDS,
  type WebhookEventStatus,
} from './inbox';
import { parseKapsoProvenance } from '@/lib/kapso/channel/provenance';
import type { ProvenanceMessage } from '@/lib/kapso/channel/provenance';
import type { AgentChannelPort, HumanTakeoverResult } from '@/lib/agent/core/types';
import type { ConfirmOrderInput, ConfirmOrderResult } from '@/lib/orders/confirm';
import type { EnsureLocationResult } from '@/lib/orders/location';
import type { AttachLocationInput, AttachLocationResult } from '@/lib/orders/attach-location';
import type { DispatchMenuResult, MenuSendReason } from '@/lib/menu/dispatch';

/**
 * Webhook de Kapso — seguridad, idempotencia y procesamiento de `nfm_reply`
 * y `location` (Fases 3.1 + 3.2 + 3.3A/B). Módulo puro (sin `server-only`): el
 * acceso a datos y la lógica de negocio se inyectan para probar sin base de datos.
 *
 * Fuera de alcance aquí: mensaje final "ubicación recibida", Kapso Function,
 * flow.json, Workflow.
 */

export const KAPSO_SUPPORTED_EVENT = 'whatsapp.message.received';
export const KAPSO_PAYLOAD_VERSION = 'v2';

export interface WebhookHeaders {
  signature: string | null;
  version: string | null;
  event: string | null;
  idempotencyKey: string | null;
}

export interface InsertProcessingInput {
  event_id: string;
  event_name: string;
  message_id: string | null;
  payload: unknown;
}

export type { WebhookEventStatus };

/** Fila del inbox ya reclamada, con lo justo para procesarla. */
export interface WebhookEventRow {
  id: string;
  eventName: string;
  payload: unknown;
  /** Intentos YA gastados, incluido el que acaba de reclamarse. */
  attempts: number;
  maxAttempts: number;
}

export interface WebhookEventStore {
  findByKey(key: string): Promise<{ id: string; status: WebhookEventStatus } | null>;
  /**
   * Aceptación DURABLE: la fila nace `received` con el payload entero. Desde
   * 5C.1 NO nace `processing` — reclamar es un acto aparte, y quien reclama es
   * quien va a trabajar.
   */
  insertReceived(input: InsertProcessingInput): Promise<{ id: string } | { duplicate: true }>;
  /**
   * Reclamo ATÓMICO por id: `received → processing` con lease. Cero filas
   * significa que otra ejecución lo tiene, y quien pierde se retira sin hacer
   * nada. No hay SELECT previo que abra una ventana de carrera.
   */
  claimEvent(id: string, leaseSeconds: number): Promise<WebhookEventRow | null>;
  /**
   * Fallo TRANSITORIO con intentos disponibles: vuelve a `received` con el
   * próximo intento agendado. Nunca a `failed`, que significa "ya no se
   * intenta más".
   */
  releaseForRetry(id: string, nextAttemptAt: string, errorMessage: string): Promise<void>;
  /** `failed → received` con intento inmediato. Lo usa una reentrega de Kapso. */
  reopenForRetry(id: string): Promise<boolean>;
  markProcessed(id: string): Promise<void>;
  /** Terminal: intentos agotados. */
  markFailed(id: string, errorMessage: string): Promise<void>;
}

/** Confirmador de pedidos inyectado (la implementación real usa Supabase). */
export type ConfirmOrder = (input: ConfirmOrderInput) => Promise<ConfirmOrderResult>;

/** Solicitud de ubicación inyectada (la implementación real usa Supabase + Kapso). */
export type EnsureLocationRequest = (orderId: string) => Promise<EnsureLocationResult>;

/** Asociación de ubicación entrante inyectada (la implementación real usa Supabase). */
export type AttachOrderLocation = (input: AttachLocationInput) => Promise<AttachLocationResult>;

/** Datos mínimos para responder el CTA URL del menú por el mismo número. */
export interface SendMenuCtaInput {
  /** Teléfono del remitente, solo dígitos. */
  toDigits: string;
  /** phone_number_id del evento entrante; `null` = usar el del entorno. */
  phoneNumberId: string | null;
  /** wamid del mensaje entrante (source_message_id), para idempotencia. */
  sourceMessageId: string;
  /**
   * Con qué autoridad se pide el menú (Fase 6D.2F.5A). Lo decide ESTE módulo a
   * partir de qué detector disparó, nunca un parámetro que venga de fuera.
   */
  reason: MenuSendReason;
}

/**
 * Envío del CTA "Ver menú" inyectado. La implementación real es el Shared Menu
 * Dispatch, que reclama el envío en `menu_send_deliveries` antes de llamar a
 * Kapso; por eso el resultado ya no es el del transporte sino el del despacho.
 */
export type SendMenuCta = (input: SendMenuCtaInput) => Promise<DispatchMenuResult>;

/**
 * Cotización de delivery dinámico inyectada (Fase 6D.2C). La implementación real
 * (server-only) consulta Mapbox, calcula la tarifa y aplica la cotización o marca
 * failed / out_of_coverage. NUNCA lanza: devuelve un resultado tipado que aquí se
 * ignora (el webhook ya respondió por la ubicación). Solo se invoca para pedidos
 * que siguen `awaiting_location` tras adjuntar el GPS (delivery dinámico).
 */
export type QuoteDynamicDelivery = (orderId: string) => Promise<unknown>;

/**
 * Fallo real al enviar la solicitud de ubicación: el caller marca el evento
 * `failed` (reintentable) y responde 500. El mensaje solo lleva el código de
 * error tipado (nunca teléfono, API keys ni bodies).
 */
export class LocationRequestError extends Error {
  constructor(code: string) {
    super(`location_request_failed:${code}`);
    this.name = 'LocationRequestError';
  }
}

/**
 * `attachLocation` devolvió `concurrent_update`: la carrera de guardado no
 * terminó en un estado estable (ni ganó esta ejecución ni se observó una
 * ubicación ya adjuntada al releer). Se trata como fallo TRANSITORIO, no
 * determinista: el caller marca el evento `failed` (reintentable vía el mismo
 * mecanismo failed → processing ya implementado) y responde 500. El mensaje no
 * lleva coordenadas ni datos sensibles.
 */
export class LocationAttachRetryError extends Error {
  constructor() {
    super('location_attach_failed:concurrent_update');
    this.name = 'LocationAttachRetryError';
  }
}

/**
 * Fallo real al enviar el CTA "Ver menú": mismo criterio que
 * `LocationRequestError` — el evento queda `failed` (reintentable) y se
 * responde 500, para que Kapso reintente. El mensaje solo lleva el código
 * de error tipado (nunca teléfono, API key ni body).
 *
 * Desde 6D.2F.5A el reintento ya no vuelve a enviar: `menu_send_deliveries`
 * guarda un claim por `source_message_id`, así que el reproceso encuentra la
 * fila y responde `duplicate`. El 500 sigue existiendo para que el evento
 * quede reintentable y termine cerrándose, no para repetir el efecto.
 */
export class MenuCtaSendError extends Error {
  constructor(code: string) {
    super(`menu_cta_send_failed:${code}`);
    this.name = 'MenuCtaSendError';
  }
}

export interface WebhookResult {
  status: number;
  body: Record<string, unknown>;
  outcome:
    | 'invalid_signature'
    | 'unsupported_version'
    | 'unsupported_batch'
    | 'ignored'
    | 'missing_idempotency_key'
    | 'duplicate'
    | 'in_progress'
    /** Aceptado de forma durable; el trabajo pesado va después. */
    | 'accepted'
    | 'processed'
    | 'failed';
}

/**
 * Resultado de la ACEPTACIÓN.
 *
 * `pending` es lo único que distingue "ya está todo resuelto" (un rechazo, un
 * duplicado, o el fast path del takeover) de "hay trabajo aceptado que alguien
 * tiene que procesar". Quien llama decide si lo procesa en línea o después.
 */
export interface AcceptResult extends WebhookResult {
  pending: { rowId: string } | null;
}

export interface HandleKapsoWebhookParams {
  rawBody: string;
  headers: WebhookHeaders;
  secret: string;
  store: WebhookEventStore;
  confirmOrder: ConfirmOrder;
  ensureLocationRequest: EnsureLocationRequest;
  attachOrderLocation: AttachOrderLocation;
  sendMenuCta: SendMenuCta;
  /**
   * Cotización de delivery dinámico (Fase 6D.2C). Opcional: sin ella el webhook
   * solo guarda el GPS (comportamiento previo) y no cotiza. La cotización real es
   * server-only y nunca lanza.
   */
  quoteDynamicDelivery?: QuoteDynamicDelivery;
  /**
   * Store de reconciliación outbound (Fase 5.2D.5C). Opcional: si no se inyecta,
   * los eventos salientes de Kapso se ignoran con 200 (comportamiento previo),
   * de modo que el resto del webhook sigue funcionando sin cambios.
   */
  outbound?: OutboundReconciliationStore;
  /**
   * Agent Core: persistencia de historial y human takeover (Fase 6D.2F.2B).
   * Opcional: sin él, el webhook conserva EXACTAMENTE el comportamiento previo
   * (ni se persiste historial ni se pausa nada). Es el interruptor de apagado.
   * NO implica OpenAI: en esta fase el agente no responde.
   */
  agentChannel?: AgentChannelPort;
  /**
   * Captura de comprobantes de pago (0021-0023). Opcional: sin este puerto el
   * webhook se comporta EXACTAMENTE como antes y ninguna imagen se captura.
   * Es el interruptor de apagado de la funcion.
   *
   * Se inyecta en las TRES vias (inline, asincrona y worker) porque todas pasan
   * por `processClaimedEvent`, asi que un solo cableado las cubre.
   */
  paymentProofIntake?: PaymentProofIntake;
}

/**
 * Puerto de captura de comprobantes. Devuelve una etiqueta corta del resultado
 * para el cuerpo de la respuesta; nunca datos del cliente ni del archivo.
 */
export type PaymentProofIntake = (input: {
  sourceMessageId: string;
  customerPhone: string;
  attachment: ImageAttachment;
  providerPhoneNumberId: string | null;
  receivedAtMs: number;
}) => Promise<{ result: string }>;

const DUPLICATE: WebhookResult = {
  status: 200,
  body: { ok: true, duplicate: true },
  outcome: 'duplicate',
};

const IN_PROGRESS: WebhookResult = {
  status: 200,
  body: { ok: true, in_progress: true },
  outcome: 'in_progress',
};

function tryParseJson(raw: string): unknown {
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** Cuerpo de respuesta operativa temporal (no se envían mensajes por Kapso aún). */
function confirmationBody(confirm: ConfirmOrderResult): Record<string, unknown> {
  switch (confirm.result) {
    case 'confirmed':
    case 'already_confirmed':
      return {
        ok: true,
        handled: 'nfm_reply',
        order_id: confirm.order.id,
        order_number: confirm.order.order_number,
        status: confirm.order.status,
        result: confirm.result,
      };
    case 'already_confirmed_by_another_message':
      return {
        ok: true,
        handled: 'nfm_reply',
        order_id: confirm.order.id,
        order_number: confirm.order.order_number,
        status: confirm.order.status,
        result: 'conflict',
      };
    case 'conflict':
      return { ok: true, handled: 'nfm_reply', result: 'conflict' };
    // Rechazos deterministas (no reintentar): se marcan processed, no failed.
    case 'not_found':
    case 'flow_token_mismatch':
    case 'phone_mismatch':
    case 'empty_order':
      return { ok: false, handled: 'nfm_reply', result: 'rejected', reason: confirm.result };
  }
}

/**
 * Cuerpo de respuesta para la asociación de ubicación (sin coordenadas/teléfono).
 *
 * `concurrent_update` queda EXCLUIDO del tipo: es un fallo transitorio y se
 * lanza como `LocationAttachRetryError` antes de llegar aquí (ver
 * `processMessage`), nunca se mapea a una respuesta 200.
 */
function locationBody(
  attach: Exclude<AttachLocationResult, { result: 'concurrent_update' }>,
): Record<string, unknown> {
  switch (attach.result) {
    case 'attached':
    case 'already_attached':
      return {
        ok: true,
        handled: 'location',
        order_id: attach.order.id,
        order_number: attach.order.order_number,
        status: attach.order.status,
        result: attach.result,
      };
    case 'location_conflict':
      return { ok: true, handled: 'location', result: 'conflict' };
    // Rechazos deterministas (no reintentar): se marcan processed, no failed.
    case 'not_found':
    case 'phone_mismatch':
    case 'invalid_status':
      return { ok: false, handled: 'location', result: 'rejected', reason: attach.result };
  }
}

/**
 * Cuerpo EXACTO que devuelve `processMessage` cuando ningún flujo determinístico
 * se hizo cargo del mensaje: ni el trigger del menú, ni la intención de menú, ni
 * una ubicación, ni un `nfm_reply`.
 *
 * Es la única puerta por la que puede entrar el Agent Core (Fase 6D.2F.3), y la
 * comprobación se hace contra ESTA constante en vez de repetir las condiciones
 * determinísticas en otro sitio. Duplicarlas abriría la puerta a que el agente y
 * el pipeline discreparan sobre quién atiende un mensaje — y entonces
 * TESTMENU9842 o una ubicación podrían acabar contestadas por el modelo.
 */
const DETERMINISTIC_DECLINED = { ok: true, handled: 'ignored', result: 'ignored' } as const;

/** ¿El pipeline determinístico declinó este mensaje? */
function deterministicDeclined(body: Record<string, unknown>): boolean {
  return (
    body.handled === DETERMINISTIC_DECLINED.handled &&
    body.result === DETERMINISTIC_DECLINED.result
  );
}

/**
 * Procesa el mensaje recibido. Devuelve el body a responder. Lanza solo ante
 * fallos reales (confirmador, envío de solicitud de ubicación o asociación de
 * ubicación) → el caller marca el evento `failed` (reintentable).
 */
async function processMessage(
  ctx: {
    message: Record<string, unknown> | undefined;
    conversationPhone: string | null;
    from: string | null;
    phoneNumberId: string | null;
  },
  deps: {
    confirmOrder: ConfirmOrder;
    ensureLocationRequest: EnsureLocationRequest;
    attachOrderLocation: AttachOrderLocation;
    sendMenuCta: SendMenuCta;
    quoteDynamicDelivery?: QuoteDynamicDelivery;
  },
): Promise<Record<string, unknown>> {
  const { message, conversationPhone, from } = ctx;
  const { confirmOrder, ensureLocationRequest, attachOrderLocation } = deps;

  // Acceso al menú: se consume aquí y no continúa hacia nfm_reply, ubicación ni
  // creación de pedidos. Activa por (a) intención natural del cliente
  // (`isMenuIntent`, Fase 6D.2E) o (b) el trigger QA interno `TESTMENU9842`. La
  // negación y el filtrado de salientes ya viven en cada detector.
  const menuIntentBody = isOutboundMessage(message) ? null : extractTextBody(message);
  if (isMenuTriggerMessage(message) || (menuIntentBody !== null && isMenuIntent(menuIntentBody))) {
    // Destinatario = remitente del mensaje (`message.from`); el teléfono de la
    // conversación queda como respaldo si el mensaje no lo trae.
    const toDigits = normalizePhone(from ?? conversationPhone ?? '');
    if (!toDigits) {
      // Sin destinatario no hay nada que reintentar: rechazo determinista.
      return { ok: false, handled: 'menu_cta', result: 'invalid', reason: 'missing_phone' };
    }

    // source_message_id = wamid del mensaje entrante (message.id).
    // Requerido para idempotencia: reintento = mismo message.id → mismo token → misma sesión.
    const sourceMessageId = typeof message?.id === 'string' ? message.id : null;
    if (!sourceMessageId) {
      // Sin message_id, no hay forma de garantizar idempotencia: rechazo determinista.
      return { ok: false, handled: 'menu_cta', result: 'invalid', reason: 'missing_message_id' };
    }

    const sent = await deps.sendMenuCta({
      toDigits,
      phoneNumberId: ctx.phoneNumberId,
      sourceMessageId,
      // El trigger de QA se distingue de la petición real del cliente: misma
      // acción, distinta procedencia, y en el ledger se ve cuál fue cuál.
      reason: isMenuTriggerMessage(message) ? 'qa_trigger' : 'explicit_request',
    });

    if (sent.result === 'failed' || sent.result === 'send_unknown') {
      // Igual que antes: evento failed + 500 para permitir el reintento de
      // Kapso. Lo que cambia es que ahora ese reintento es SEGURO — encuentra
      // el claim y responde `duplicate` en vez de mandar un segundo CTA.
      throw new MenuCtaSendError(sent.error);
    }

    // `duplicate` = este WAMID ya se procesó, así que no es un fallo del
    // webhook: el evento queda procesado y no sale un segundo CTA.
    return { ok: true, handled: 'menu_cta', result: sent.result };
  }

  // Ubicación entrante (Fase 3.3B): se comprueba antes que nfm_reply porque
  // `location` no es un mensaje `interactive`.
  if (message?.type === 'location') {
    const parsedLocation = parseLocationMessage(message);
    if (!parsedLocation.ok) {
      // 'not_location' no debería ocurrir aquí (ya filtramos por type), pero se
      // trata igual que un payload inválido: no reintentar.
      return { ok: false, handled: 'location', result: 'invalid', reason: parsedLocation.reason };
    }

    const phoneDigits = normalizePhone(conversationPhone ?? from ?? '');
    const attach = await attachOrderLocation({
      contextId: parsedLocation.data.contextId,
      customerPhoneDigits: phoneDigits,
      latitude: parsedLocation.data.latitude,
      longitude: parsedLocation.data.longitude,
      address: parsedLocation.data.address ?? null,
      name: parsedLocation.data.name ?? null,
    });

    if (attach.result === 'concurrent_update') {
      // Fallo transitorio: el evento queda failed y puede reclamarse de nuevo.
      throw new LocationAttachRetryError();
    }

    // 6D.2C: si tras adjuntar el pedido sigue `awaiting_location`, es un delivery
    // dinámico (legacy pasa a `confirmed`). Se cotiza con Mapbox. La cotización
    // nunca lanza y su resultado no altera la respuesta de la ubicación: un
    // reenvío de GPS con quote='failed' vuelve a cotizar (el orquestador decide
    // por el estado del pedido, no por "primera vez"). quoted/out_of_coverage no
    // recotizan.
    if (
      (attach.result === 'attached' || attach.result === 'already_attached') &&
      attach.order.status === 'awaiting_location' &&
      deps.quoteDynamicDelivery
    ) {
      await deps.quoteDynamicDelivery(attach.order.id);
    }

    return locationBody(attach);
  }

  const parsed = parseNfmReply(message);

  if (!parsed.ok) {
    if (parsed.reason === 'not_nfm') {
      // Tipos de mensaje aún no soportados: procesados e ignorados.
      return { ...DETERMINISTIC_DECLINED };
    }
    // missing / invalid_json / invalid_shape: payload inválido, no reintentar.
    return { ok: false, handled: 'nfm_reply', result: 'invalid', reason: parsed.reason };
  }

  const messageId = typeof message?.id === 'string' ? message.id : null;
  if (!messageId) {
    return { ok: false, handled: 'nfm_reply', result: 'invalid', reason: 'missing_message_id' };
  }

  const phoneDigits = normalizePhone(conversationPhone ?? from ?? '');
  const confirm = await confirmOrder({
    orderDraftId: parsed.data.order_draft_id,
    flowToken: parsed.data.flow_token,
    customerPhoneDigits: phoneDigits,
    sourceMessageId: messageId,
  });

  const body = confirmationBody(confirm);

  // Fase 3.3A: solicitud de ubicación para delivery. Se decide SOLO por el
  // estado guardado del pedido (awaiting_location), nunca por datos del Flow.
  const needsLocation =
    (confirm.result === 'confirmed' || confirm.result === 'already_confirmed') &&
    confirm.order.status === 'awaiting_location';

  if (needsLocation) {
    const loc = await ensureLocationRequest(confirm.order.id);

    if (loc.result === 'send_failed') {
      // Sin wamid inventado; el pedido queda awaiting_location y el evento
      // quedará failed para reintentar el envío.
      throw new LocationRequestError(loc.error);
    }
    if (loc.result === 'requested') {
      return { ...body, result: 'location_requested' };
    }
    if (loc.result === 'already_requested') {
      // Idempotente: no se volvió a llamar a Kapso. Si esta ejecución fue la que
      // confirmó, reporta location_requested; si fue un reproceso, mantiene
      // already_confirmed con el mismo estado del pedido.
      return confirm.result === 'confirmed' ? { ...body, result: 'location_requested' } : body;
    }
    // 'not_applicable': el estado cambió entremedio; responder lo confirmado.
  }

  return body;
}

/**
 * Cuerpo de respuesta del human takeover. Sin teléfono, sin wamid y sin el
 * contenido del mensaje: solo el desenlace de cada paso idempotente.
 */
function takeoverBody(result: HumanTakeoverResult): Record<string, unknown> {
  if (result.result === 'rejected') {
    return { ok: false, handled: 'human_takeover', result: 'invalid', reason: result.reason };
  }
  return {
    ok: true,
    handled: 'human_takeover',
    result: result.pause, // 'paused' | 'already_paused'
    message: result.message, // 'inserted' | 'duplicate'
    control_event: result.controlEvent, // 'inserted' | 'duplicate'
  };
}

/** Desenlace saneado del registro de historial entrante. */
type InboundHistoryOutcome = 'persisted' | 'duplicate' | 'rejected';

/**
 * Fallo REAL al persistir el historial entrante del cliente: el evento queda
 * `failed` (reintentable) y se responde 500, igual que `LocationRequestError`.
 */
export class AgentHistoryPersistError extends Error {
  constructor(cause: string) {
    super(`agent_history_persist_failed:${cause}`);
    this.name = 'AgentHistoryPersistError';
  }
}

/**
 * Persiste el entrante del cliente ANTES de cualquier efecto determinístico, y
 * PROPAGA si falla (fail-before-side-effect).
 *
 * Por qué propagar y no tragarse el error: el requisito del Agent Foundation es
 * que TODO mensaje real del cliente quede en el historial. Continuar tras un
 * fallo procesaría el mensaje y lo perdería para siempre, porque nadie vuelve a
 * pasar por aquí. Se prefiere no procesarlo y reintentar.
 *
 * Por qué es seguro propagar aquí: en este punto lo único escrito es la fila de
 * `webhook_events` — que es justamente el mecanismo de reintento — y no se ha
 * confirmado ningún pedido, ni enviado el CTA del menú, ni adjuntado GPS, ni
 * cotizado delivery: todo eso vive dentro de `processMessage`, que aún no ha
 * corrido. No se inventa ningún reintento nuevo: el error viaja al `catch` de
 * siempre → `markFailed` → 500 → Kapso reentrega → `claimFailedForRetry`.
 *
 * Por qué la reejecución no duplica: el UNIQUE parcial sobre
 * `agent_messages.provider_message_id` (0014) convierte el reintento en
 * `duplicate`, y `processMessage` ya era idempotente de antes.
 *
 * `rejected` (sin teléfono resoluble) NO propaga: es determinista y reintentarlo
 * no lo arreglaría nunca; se responde y se sigue, como el resto de rechazos
 * deterministas del webhook.
 */
async function persistInbound(
  channel: AgentChannelPort,
  message: ProvenanceMessage,
): Promise<InboundHistoryOutcome> {
  try {
    const persisted = await channel.persistCustomerInbound(message);
    return persisted.result === 'rejected' ? 'rejected' : persisted.result;
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown';
    log.error('agent_history_persist_failed', { reason });
    throw new AgentHistoryPersistError(reason);
  }
}

/**
 * Ejecuta el turno del agente sin poder tumbar un resultado determinístico ya
 * conseguido.
 *
 * La asimetría con `persistInbound` es DELIBERADA, y depende de dónde está cada
 * uno en el pipeline:
 *
 *   · `persistInbound` corre ANTES de cualquier efecto. Si falla, propagar es
 *     gratis y correcto: nada ocurrió todavía y el reintento recupera el
 *     mensaje para el historial.
 *   · el turno del agente corre DESPUÉS de que el pipeline haya resuelto el
 *     mensaje. Devolver 500 marcaría como `failed` un evento que se atendió
 *     bien, y el reintento tampoco arreglaría nada: el run ya está reclamado
 *     por su WAMID, así que la segunda pasada se detendría en `duplicate` sin
 *     llegar a responder. Se registra el fallo y se sigue.
 */
async function runAgentTurnSafely(
  channel: AgentChannelPort,
  message: ProvenanceMessage,
  burst: readonly ProvenanceMessage[],
): Promise<string> {
  try {
    const turn = await channel.runAgentTurn!(message, burst);
    return turn.result === 'skipped' ? `skipped:${turn.reason}` : turn.result;
  } catch (error) {
    log.error('agent_turn_failed', {
      reason: error instanceof Error ? error.message : 'unknown',
    });
    return 'error';
  }
}

// ── Lotes: un elemento a la vez, y COMO MÁXIMO un turno (Fase 6D.2F.5C.2) ────

/** Qué papel juega un elemento del lote en el turno lógico. */
type EnvelopeKind =
  /** Lo atendió el pipeline determinístico: menú, ubicación, `nfm_reply`. */
  | 'deterministic'
  /** Declinó y puede formar turno: texto con contenido real. */
  | 'eligible'
  /** Declinó pero el agente no puede leerlo: reacción, media, tipos sin soporte. */
  | 'silent';

interface EnvelopeResult {
  index: number;
  kind: EnvelopeKind;
  body: Record<string, unknown>;
  history: InboundHistoryOutcome | null;
  /** Solo cuando es un entrante real del cliente. */
  message: ProvenanceMessage | null;
  /**
   * Evento de CANAL: algo que pasó en la conversación, no algo que alguien
   * dijo. Hoy solo la reacción (Fase 6D.2F.5C.4). Se persiste igual, pero no
   * puede abrir turno ni siquiera como último recurso.
   */
  channelEvent: boolean;
}

/**
 * Recorre los sobres EN ORDEN y aplica a cada uno el pipeline de siempre.
 *
 * Lo importante es lo que NO hace: no agrupa, no concatena y no saltea. Cada
 * elemento se persiste con su propio WAMID y su propio timestamp, y cada ruta
 * determinística —ubicación, `nfm_reply`, TESTMENU9842— se ejecuta con el
 * mensaje que la disparó. Un lote no es un mensaje grande: son N mensajes que
 * llegaron juntos.
 *
 * Secuencial y no en paralelo, a propósito: son mensajes de una misma
 * conversación y su orden es su significado. Además varias escrituras
 * simultáneas contra el mismo teléfono es justo lo que la idempotencia no
 * debería tener que arbitrar.
 */
async function processEnvelopes(
  envelopes: readonly WebhookEnvelope[],
  eventName: string,
  params: HandleKapsoWebhookParams,
  deps: {
    confirmOrder: ConfirmOrder;
    ensureLocationRequest: EnsureLocationRequest;
    attachOrderLocation: AttachOrderLocation;
    sendMenuCta: SendMenuCta;
    quoteDynamicDelivery?: QuoteDynamicDelivery;
  },
): Promise<EnvelopeResult[]> {
  const results: EnvelopeResult[] = [];

  for (const envelope of envelopes) {
    const provenance = params.agentChannel
      ? parseKapsoProvenance(eventName, envelope.payload)
      : null;
    const message = provenance?.kind === 'customer_inbound' ? provenance.message : null;

    // Historial ANTES de decidir nada y con independencia del estado de pausa.
    // Si falla, PROPAGA: el elemento no se procesa y la entrega entera se
    // reintenta. Los elementos ya persistidos vuelven como `duplicate`, así que
    // el reintento no duplica nada — ver `persistInbound`.
    const history = message ? await persistInbound(params.agentChannel!, message) : null;

    const ctx = extractMessageContext(envelope.payload);
    const body = await processMessage(ctx, deps);

    // La clasificación no es una lista aparte que haya que mantener: sale del
    // resultado REAL del pipeline. Si el determinístico lo atendió, ya está
    // atendido; si declinó, la pregunta que queda es si el agente puede leerlo.
    let kind: EnvelopeKind;
    if (!deterministicDeclined(body)) kind = 'deterministic';
    else if (message !== null && isAgentEligibleContent(message)) kind = 'eligible';
    else kind = 'silent';

    results.push({
      index: envelope.index,
      kind,
      body,
      history,
      message,
      // Por el TIPO declarado, no por el resultado del parseo: una reacción a la
      // que no supimos leer el objeto `reaction` sigue siendo una reacción, y
      // callar ante lo que no entendemos es la dirección segura.
      channelEvent: isReactionType(ctx.messageType),
    });
  }

  return results;
}

/**
 * El ancla del turno: el ÚLTIMO elegible POR POSICIÓN en `data[]`, prefiriendo
 * el que representa trabajo NUEVO.
 *
 * ── Por posición y no por timestamp ─────────────────────────────────────────
 *
 * El timestamp de WhatsApp viene en segundos y el buffering agrupa ráfagas:
 * tres mensajes seguidos comparten segundo con mucha frecuencia, así que
 * ordenar por reloj dejaría indeterminado justo el caso para el que existe el
 * lote. Kapso garantiza el orden dentro de `data[]`; ese orden es el dato.
 *
 * El último y no el primero porque es el mensaje que CIERRA la ráfaga y el que
 * el cliente espera que se conteste: en «hola» / «quería saber» / «qué
 * hamburguesas tienen?», la pregunta es la tercera.
 *
 * ── Por qué además hace falta mirar si el WAMID sigue disponible ────────────
 *
 * `claimRun` PARA al encontrar el run ya reclamado: devuelve `duplicate` y no
 * responde. Así que anclar en un WAMID ya consumido no produce un error — no
 * produce nada. El mensaje nuevo del lote quedaría persistido y sin contestar,
 * en silencio y con todo lo demás en verde.
 *
 * Y el caso llega solo: una reentrega puede mezclar un mensaje ya procesado con
 * uno que no lo estaba, y `data[]` no viene ordenado por novedad, así que el
 * consumido puede perfectamente ir el último.
 *
 * La preferencia va en tres niveles, y el orden entre ellos es el argumento:
 *
 *   1. último ELEGIBLE y NUEVO      → el caso normal y el que evita el hambre
 *   2. último ELEGIBLE              → conserva la REPARACIÓN: un mensaje ya
 *                                     persistido cuyo turno nunca se reclamó
 *                                     (la ejecución anterior murió en medio)
 *                                     tiene que poder anclar, o el cliente se
 *                                     queda sin respuesta para siempre
 *   3. último candidato             → mantiene el camino individual intacto:
 *                                     una foto suelta sigue llegando al turno y
 *                                     saliendo como `skipped:unsupported_content`
 *
 * La novedad NUNCA sustituye a la clasificación, solo desempata dentro de ella:
 * una ubicación recién llegada es lo más nuevo del lote y aun así no puede
 * anclar, porque ya la atendió su propia ruta. Persistirse no es ser accionable.
 *
 * ── Y por qué los eventos de canal quedan fuera del todo (5C.4) ─────────────
 *
 * Una reacción no puede anclar NI COMO ÚLTIMO RECURSO. Hasta 5C.4 sí podía: una
 * reacción suelta era el único candidato, ganaba el nivel 3 y llegaba a
 * `runAgentTurn`, que la descartaba en su gate de contenido antes del claim. El
 * desenlace era correcto —ni run, ni OpenAI, ni respuesta— pero por rebote, y
 * dependía de que el gate del core siguiera diciendo que no.
 *
 * Aquí se decide antes y por lo que la reacción ES, no por lo que el core opine
 * de su contenido. Se excluyen SOLO los eventos de canal: una foto o un audio
 * sueltos siguen llegando al turno y saliendo como `skipped:unsupported_content`
 * exactamente igual que antes, porque son mensajes que el cliente mandó para que
 * los leyéramos y en 5C.5 empezarán a leerse. Un ❤️ no lo es.
 */
function pickTurnAnchor(results: readonly EnvelopeResult[]): EnvelopeResult | null {
  const candidatos = results.filter(
    (r) => r.message !== null && r.kind !== 'deterministic' && !r.channelEvent,
  );
  if (candidatos.length === 0) return null;

  const elegibles = candidatos.filter((r) => r.kind === 'eligible');
  const nuevos = elegibles.filter((r) => r.history === 'persisted');

  const elegidos = nuevos.length > 0 ? nuevos : elegibles.length > 0 ? elegibles : candidatos;
  return elegidos[elegidos.length - 1];
}

/** Recuentos del lote. Nunca texto de los mensajes ni teléfonos. */
function logBatchClassification(
  eventName: string,
  results: readonly EnvelopeResult[],
  anchor: EnvelopeResult | null,
): void {
  log.info('webhook_batch_classified', {
    event: eventName,
    total: results.length,
    deterministic_count: results.filter((r) => r.kind === 'deterministic').length,
    silent_count: results.filter((r) => r.kind === 'silent').length,
    eligible_count: results.filter((r) => r.kind === 'eligible').length,
    // Subconjunto de `silent_count`, no una clase nueva: los recuentos de las
    // tres clases siguen sumando el total, como en 5C.2.
    channel_event_count: results.filter((r) => r.channelEvent).length,
    anchor_index: anchor?.index ?? null,
  });
}

/**
 * Cuerpo de una entrega en lote.
 *
 * Deliberadamente NO es el cuerpo de un mensaje con cosas añadidas: una entrega
 * de N mensajes no tiene un resultado, tiene N. Se devuelve el desenlace de cada
 * elemento en su orden original, y el turno una sola vez.
 */
function batchBody(
  results: readonly EnvelopeResult[],
  anchor: EnvelopeResult | null,
  turn: string | null,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    ok: true,
    handled: 'batch',
    batch_size: results.length,
    results: results.map((r) => ({
      index: r.index,
      kind: r.kind,
      handled: r.body.handled ?? null,
      result: r.body.result ?? null,
      ...(r.history !== null ? { agent_history: r.history } : {}),
      ...(r.channelEvent ? { channel_event: true } : {}),
    })),
    anchor_index: anchor?.index ?? null,
  };
  if (turn !== null) body.agent_turn = turn;
  return body;
}

/** Cuerpo de la aceptación durable. Sin ids internos: solo el acuse. */
const ACCEPTED_BODY: Record<string, unknown> = { ok: true, accepted: true };

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown';
}

/**
 * FASE 1 — ACEPTACIÓN.
 *
 * Valida, deja constancia durable y responde. Lo único pesado que ocurre aquí
 * es el takeover humano, y ocurre a propósito (ver más abajo).
 *
 * Todo lo que este paso hace está acotado: verificar una firma, parsear un
 * JSON y escribir una fila. Nada de OpenAI, nada de Kapso, nada de Mapbox. Por
 * eso el ACK deja de depender de cuánto tarde el modelo.
 */
export async function acceptKapsoWebhook(
  params: HandleKapsoWebhookParams,
): Promise<AcceptResult> {
  const { rawBody, headers, secret, store } = params;

  // 1. Firma HMAC SHA-256 sobre el body crudo (comparación en tiempo constante).
  //
  // SIEMPRE antes de interpretar nada. Kapso firma el JSON crudo, así que este
  // orden no es una preferencia de estilo: parsear antes de verificar sería
  // procesar datos que todavía no consta que sean suyos.
  if (!secret || !verifyHmacSha256(rawBody, headers.signature ?? '', secret)) {
    return {
      status: 401,
      body: { error: 'invalid_signature' },
      outcome: 'invalid_signature',
      pending: null,
    };
  }

  // 2. Versión del payload.
  if (headers.version !== KAPSO_PAYLOAD_VERSION) {
    return {
      status: 400,
      body: { error: 'unsupported_version' },
      outcome: 'unsupported_version',
      pending: null,
    };
  }

  const payload = tryParseJson(rawBody);

  // 3. Lote o entrega individual: a partir de aquí, una lista de sobres.
  //
  // La normalización va DESPUÉS del HMAC y de la versión, y ese orden no se
  // invierte nunca: interpretar antes de verificar sería parsear datos que
  // todavía no consta que sean suyos.
  const normalized = toEnvelopes(payload);
  if (!normalized.ok) {
    // Lote que no entendemos. 422 para que la entrega falle VISIBLEMENTE en
    // Kapso en vez de perderse en silencio: agotados sus reintentos, el
    // proveedor cae a entrega individual, que sí sabemos procesar.
    log.warn('webhook_batch_rejected', { event: headers.event, reason: normalized.reason });
    return {
      status: 422,
      body: { ok: false, error: 'unsupported_batch', reason: normalized.reason },
      outcome: 'unsupported_batch',
      pending: null,
    };
  }

  // 4. Eventos que procesamos: whatsapp.message.received (entrante) y, si hay
  // store de reconciliación inyectado, los cuatro salientes (Fase 5.2D.5C). El
  // resto se ignora con 200. Sin `outbound`, los salientes también se ignoran.
  // 6D.2F.2B: el human takeover viaja en `whatsapp.message.sent`, que ya es uno
  // de los cuatro salientes. Se admite también cuando solo está inyectado el
  // Agent Core, para que la pausa funcione aunque la reconciliación no esté.
  const isReceived = headers.event === KAPSO_SUPPORTED_EVENT;
  const isOutbound =
    isOutboundEventName(headers.event) &&
    (params.outbound != null || params.agentChannel != null);
  if (!isReceived && !isOutbound) {
    return {
      status: 200,
      body: { ok: true, ignored: true },
      outcome: 'ignored',
      pending: null,
    };
  }
  // Tras el guard, el evento es uno de los soportados: no puede ser null.
  const eventName = headers.event as string;

  // El buffering de Kapso agrupa SOLO `whatsapp.message.received`. Un lote de
  // cualquier otra cosa contradice el contrato, y lo que llegaría por ahí es
  // justo lo que no puede diferirse ni agruparse: el takeover humano viaja en
  // `whatsapp.message.sent` y tiene su propio camino síncrono.
  if (normalized.batched && !isReceived) {
    log.warn('webhook_batch_rejected', { event: eventName, reason: 'batch_unsupported_event' });
    return {
      status: 422,
      body: { ok: false, error: 'unsupported_batch', reason: 'batch_unsupported_event' },
      outcome: 'unsupported_batch',
      pending: null,
    };
  }

  if (normalized.batched) {
    // Solo recuentos y referencias del proveedor: ni texto, ni teléfono.
    log.info('webhook_batch_received', {
      event: eventName,
      batch_size: normalized.envelopes.length,
      declared_size: normalized.batchInfo?.size ?? null,
      window_ms: normalized.batchInfo?.windowMs ?? null,
      first_sequence: normalized.batchInfo?.firstSequence ?? null,
      last_sequence: normalized.batchInfo?.lastSequence ?? null,
      conversation_id: normalized.batchInfo?.conversationId ?? null,
    });
    // `batch_info.size` es diagnóstico, no autoridad: manda `data.length`, que
    // es lo que de verdad podemos procesar. Descartar mensajes reales que
    // tenemos delante por un contador que no cuadra sería el peor intercambio
    // posible; que no cuadre, en cambio, hay que verlo.
    if (
      normalized.batchInfo?.size !== null &&
      normalized.batchInfo?.size !== undefined &&
      normalized.batchInfo.size !== normalized.envelopes.length
    ) {
      log.warn('webhook_batch_size_mismatch', {
        event: eventName,
        batch_size: normalized.envelopes.length,
        declared_size: normalized.batchInfo.size,
      });
    }
  }

  // 5. Idempotency key obligatorio.
  const key = headers.idempotencyKey ?? '';
  if (!key) {
    return {
      status: 400,
      body: { error: 'missing_idempotency_key' },
      outcome: 'missing_idempotency_key',
      pending: null,
    };
  }

  // `message_id` es DIAGNÓSTICO: la idempotencia del inbox es `event_id`, que es
  // la clave de la entrega. En un lote se guarda el wamid del ÚLTIMO elemento
  // por posición — el mejor candidato barato a ancla, sin clasificar aquí. El
  // ancla real se calcula al procesar, donde se conoce cada ruta.
  const ultimo = normalized.envelopes[normalized.envelopes.length - 1].payload;
  const messageId = isReceived
    ? extractMessageContext(ultimo).messageId
    : (() => {
        const parsed = parseOutboundEvent(headers.event, payload);
        return parsed.ok ? parsed.event.externalMessageId : null;
      })();

  // 6. Idempotencia por estado.
  const existing = await store.findByKey(key);
  let rowId: string;

  if (existing) {
    if (existing.status === 'processed') return { ...DUPLICATE, pending: null };
    if (existing.status === 'failed') {
      // Terminal por intentos agotados, pero Kapso insiste: una reentrega es
      // una señal nueva y merece otra oportunidad. Vuelve a `received`.
      const reopened = await store.reopenForRetry(existing.id);
      if (!reopened) return { ...IN_PROGRESS, pending: null };
      rowId = existing.id;
    } else if (existing.status === 'received') {
      // Aceptado pero sin procesar: la reentrega sirve para volver a
      // intentarlo ya, en vez de esperar al tick del worker.
      rowId = existing.id;
    } else {
      // 'processing': alguien lo tiene con lease vigente. No se toca.
      return { ...IN_PROGRESS, pending: null };
    }
  } else {
    const inserted = await store.insertReceived({
      event_id: key,
      event_name: eventName,
      message_id: messageId,
      payload,
    });
    if ('duplicate' in inserted) return { ...IN_PROGRESS, pending: null };
    rowId = inserted.id;
  }

  // ── 7. PLANO DE CONTROL: el takeover humano NO puede diferirse ─────────────
  //
  // Si la pausa se procesara después, un turno del agente ya aceptado
  // consultaría el estado, lo vería `active` —porque el `sent` está aceptado
  // pero SIN APLICAR— y hablaría por encima de la persona. La barrera pre-send
  // solo puede ver lo que ya está escrito en la base.
  //
  // Hacerlo aquí es barato y acotado: tres escrituras, sin red externa. Nada de
  // OpenAI, nada de herramientas.
  const provenance = params.agentChannel
    ? parseKapsoProvenance(headers.event, payload)
    : null;

  if (provenance?.kind === 'human_outbound') {
    const claimed = await store.claimEvent(rowId, WEBHOOK_LEASE_SECONDS);
    if (claimed === null) return { ...IN_PROGRESS, pending: null };

    try {
      const takeover = await params.agentChannel!.handleHumanTakeover(provenance.message);
      await store.markProcessed(rowId);
      return {
        status: 200,
        body: takeoverBody(takeover),
        outcome: 'processed',
        pending: null,
      };
    } catch (error) {
      // No puede quedarse en `processing` para siempre: se deja reclamable YA
      // —no con backoff— y se responde 500 para que una reentrega de Kapso
      // pueda ayudar además del recovery. Una pausa que no se aplica es lo peor
      // que puede pasarle a la coexistencia.
      const reason = errorMessageOf(error);
      const disposition = dispositionAfterFailure(claimed.attempts, claimed.maxAttempts, Date.now());
      if (disposition.kind === 'exhausted') {
        await store.markFailed(rowId, reason);
      } else {
        await store.releaseForRetry(rowId, new Date().toISOString(), reason);
      }
      log.error('webhook_takeover_failed', { event: eventName });
      return {
        status: 500,
        body: { error: 'internal_error' },
        outcome: 'failed',
        pending: null,
      };
    }
  }

  // 8. Todo lo demás queda aceptado y pendiente. Quien llama decide cuándo.
  return { status: 200, body: ACCEPTED_BODY, outcome: 'accepted', pending: { rowId } };
}

/**
 * FASE 2 — PROCESAMIENTO.
 *
 * Es la ÚNICA implementación del negocio y no sabe quién la llama: `after()`,
 * el worker de recovery o el modo inline de rollback ejecutan exactamente esto.
 * Lo que cambia entre modos es CUÁNDO se invoca, nunca QUÉ hace.
 *
 * Empieza reclamando: si otra ejecución tiene la fila con lease vigente, esta
 * se retira sin tocar nada. El reclamo es un UPDATE condicionado, no un SELECT
 * seguido de UPDATE.
 */
export async function processWebhookEvent(
  rowId: string,
  params: HandleKapsoWebhookParams,
): Promise<WebhookResult> {
  const claimed = await params.store.claimEvent(rowId, WEBHOOK_LEASE_SECONDS);
  if (claimed === null) return IN_PROGRESS;
  return processClaimedEvent(claimed, params);
}

/**
 * Ejecuta una fila YA reclamada.
 *
 * Separada de `processWebhookEvent` porque el recovery reclama de otra forma —
 * por vencimiento y con `FOR UPDATE SKIP LOCKED`, no por id— y volver a
 * reclamar aquí le robaría su propia fila. El trabajo, en cambio, es el mismo,
 * y este es el punto donde los dos caminos convergen.
 */

/**
 * Captura los comprobantes de una entrega.
 *
 * Recorre los sobres ya normalizados —el individual es un lote de uno— y manda
 * al motor cada adjunto ENTRANTE del cliente. Los salientes se ignoran: el QR
 * que enviamos nosotros no es un comprobante.
 *
 * Nunca lanza. Devuelve solo etiquetas de resultado, jamas datos del cliente ni
 * del archivo.
 */
async function capturePaymentProofs(
  envelopes: ReadonlyArray<{ payload: unknown }>,
  eventName: string | null,
  intake: PaymentProofIntake,
): Promise<string[]> {
  const outcomes: string[] = [];
  for (const envelope of envelopes) {
    const provenance = parseKapsoProvenance(eventName, envelope.payload);
    if (provenance.kind !== 'customer_inbound') continue;

    const { message } = provenance;
    const attachment = message.image;
    if (!attachment) continue;
    if (!message.providerMessageId || !message.customerPhone) continue;

    try {
      const res = await intake({
        sourceMessageId: message.providerMessageId,
        customerPhone: message.customerPhone,
        attachment,
        providerPhoneNumberId: message.providerPhoneNumberId,
        receivedAtMs: Date.now(),
      });
      outcomes.push(res.result);
    } catch {
      // Un comprobante problematico no tumba la entrega del resto.
      outcomes.push('failed');
    }
  }
  return outcomes;
}

export async function processClaimedEvent(
  claimed: WebhookEventRow,
  params: HandleKapsoWebhookParams,
): Promise<WebhookResult> {
  const { store } = params;

  try {
    const body = await runBusiness(claimed, params);
    await store.markProcessed(claimed.id);
    return { status: 200, body, outcome: 'processed' };
  } catch (error) {
    const reason = errorMessageOf(error);
    const disposition = dispositionAfterFailure(claimed.attempts, claimed.maxAttempts, Date.now());

    if (disposition.kind === 'exhausted') {
      // Terminal de verdad: se agotaron los intentos.
      await store.markFailed(claimed.id, reason);
    } else {
      // Fallo transitorio con intentos disponibles: vuelve a `received` con su
      // próximo intento agendado. NO a `failed`, que significa "no se intenta
      // más" y dejaría el mensaje del cliente muerto tras un hipo de red.
      await store.releaseForRetry(claimed.id, disposition.nextAttemptAt, reason);
    }

    return { status: 500, body: { error: 'internal_error' }, outcome: 'failed' };
  }
}

/**
 * El negocio, a partir de la fila ya reclamada.
 *
 * Trabaja desde el `payload` guardado, no desde el request: así el worker de
 * recovery y el `after()` recorren el mismo camino con los mismos datos, y no
 * hay una versión "con request" y otra "sin request" que puedan divergir.
 *
 * Lanza ante fallos reales; el caller decide reintento o terminal.
 */
async function runBusiness(
  row: WebhookEventRow,
  params: HandleKapsoWebhookParams,
): Promise<Record<string, unknown>> {
  const { confirmOrder, ensureLocationRequest, attachOrderLocation, sendMenuCta } = params;
  const eventName = row.eventName;
  const payload = row.payload;
  const isReceived = eventName === KAPSO_SUPPORTED_EVENT;

  // 6D.2F.2B — Procedencia ANTES de bifurcar entrante/saliente. Sin el Agent
  // Core inyectado no se calcula siquiera: coste cero y comportamiento previo.
  const provenance = params.agentChannel ? parseKapsoProvenance(eventName, payload) : null;

  // El takeover normalmente se resuelve en la aceptación. Sigue aquí porque el
  // recovery tiene que poder terminarlo si aquella falló a mitad: una sola
  // implementación, alcanzable por los dos caminos.
  //
  // No puede venir en lote: el buffering agrupa solo `received`, y la aceptación
  // rechaza un lote de cualquier otro evento.
  if (provenance?.kind === 'human_outbound') {
    const takeover = await params.agentChannel!.handleHumanTakeover(provenance.message);
    return takeoverBody(takeover);
  }

  if (isReceived) {
    // Una entrega individual es un lote de uno: MISMO recorrido, mismo cuerpo.
    // Que el camino individual no tenga su propia implementación es lo que
    // impide que las dos formas se separen con el tiempo.
    const normalized = toEnvelopes(payload);
    if (!normalized.ok) {
      // La aceptación ya lo rechazó; llegar aquí significaría una fila guardada
      // antes de esta fase o un payload manipulado. No se adivina.
      log.warn('webhook_batch_rejected', { event: eventName, reason: normalized.reason });
      return { ok: false, handled: 'invalid_batch', result: normalized.reason };
    }

    const results = await processEnvelopes(normalized.envelopes, eventName, params, {
      confirmOrder,
      ensureLocationRequest,
      attachOrderLocation,
      sendMenuCta,
      quoteDynamicDelivery: params.quoteDynamicDelivery,
    });

    // ── Comprobantes de pago ─────────────────────────────────────────────────
    //
    // Todo adjunto entrante del cliente pasa por el motor canonico. Se ESPERA a
    // proposito (nada de `void`): en modo asincrono este trabajo corre dentro
    // del `after()` de la ruta, y soltar la promesa dejaria la captura a merced
    // de que la funcion serverless siga viva.
    //
    // Un fallo aqui NO tumba el resto del webhook: el pedido, la ubicacion y el
    // agente ya se atendieron arriba, y perder un comprobante es recuperable
    // (la fila queda reclamable y se reintenta) mientras que tumbar la entrega
    // entera no lo es.
    const proofs = params.paymentProofIntake
      ? await capturePaymentProofs(normalized.envelopes, eventName, params.paymentProofIntake)
      : [];

    // ── El turno agregado ────────────────────────────────────────────────────
    //
    // COMO MÁXIMO uno por entrega, ancla incluida. No se concatena nada ni se
    // fabrica un mensaje nuevo: el ancla es un mensaje REAL del cliente, con su
    // WAMID, y la ráfaga entera ya está persistida antes de llamar al modelo —
    // así que el contexto la ve completa y en orden sin ningún vínculo explícito.
    const anchor = pickTurnAnchor(results);
    let turn: string | null = null;
    if (anchor?.message && params.agentChannel?.runAgentTurn) {
      // El BURST entero, en el orden de `data[]` (5C.5). El ancla decide DE QUÉ
      // mensaje es el turno —y con ello la idempotencia—, pero lo que el modelo
      // tiene que mirar puede estar en otro elemento: en `[foto, "¿qué
      // hamburguesa es esta?"]` el ancla es el texto y la imagen es el otro.
      // Solo entrantes reales del cliente; lo determinístico ya se atendió.
      const burst = results
        .filter((r) => r.message !== null)
        .map((r) => r.message!) as readonly ProvenanceMessage[];
      turn = await runAgentTurnSafely(params.agentChannel, anchor.message, burst);
    }

    if (normalized.batched) {
      logBatchClassification(eventName, results, anchor);
      return batchBody(results, anchor, turn);
    }

    // Camino individual: el cuerpo es EXACTAMENTE el de antes de 5C.2.
    let body = results[0].body;
    if (proofs.length > 0) body = { ...body, payment_proofs: proofs };
    if (results[0].history !== null) body = { ...body, agent_history: results[0].history };
    if (turn !== null) body = { ...body, agent_turn: turn };
    return body;
  }

  if (params.outbound) {
    const outboundParsed = parseOutboundEvent(eventName, payload);
    const outboundResult = await processOutboundEvent(outboundParsed, params.outbound);
    return outboundResult as unknown as Record<string, unknown>;
  }

  // Saliente admitido solo por el Agent Core y que no era humano (cloud_api o
  // ciclo de vida): sin store de reconciliación no hay nada que hacer con él.
  return { ok: true, handled: 'ignored', result: 'ignored' };
}

/**
 * Modo INLINE: acepta y procesa antes de responder.
 *
 * Es exactamente `acceptKapsoWebhook` seguido de `processWebhookEvent`, sin una
 * línea de negocio propia. Existe como interruptor de rollback: preserva el
 * comportamiento anterior a 5C.1 —incluidos los cuerpos de respuesta— sin
 * mantener un segundo pipeline que pueda divergir del real.
 */
export async function handleKapsoWebhook(
  params: HandleKapsoWebhookParams,
): Promise<WebhookResult> {
  const accepted = await acceptKapsoWebhook(params);
  if (accepted.pending === null) {
    return { status: accepted.status, body: accepted.body, outcome: accepted.outcome };
  }
  return processWebhookEvent(accepted.pending.rowId, params);
}
