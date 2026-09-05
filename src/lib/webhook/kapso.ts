import { verifyHmacSha256 } from '@/lib/security/compare';
import { normalizePhone } from '@/lib/phone';
import { extractMessageContext, parseNfmReply } from '@/lib/flow/nfm';
import { toEnvelopes, type WebhookEnvelope } from './envelopes';
import { isAgentEligibleContent } from '@/lib/agent/core/run';
import { isReactionType } from '@/lib/kapso/channel/reaction';
import { parseLocationMessage, parseStandaloneLocation } from '@/lib/flow/location-message';
import { isDeliveryQuoteIntent } from './delivery-quote-intent';
import {
  extractCoordsFromMapsUrl,
  findMapsLink,
  isShortMapsLink,
  parsePlainCoords,
} from '@/lib/delivery/maps-link';
import { classifyMenuCtaContext, type MenuCtaContext } from '@/lib/menu/cta-context';
import { MENU_CHANGE_BUTTON_TEXT, orderChangeCtaText } from '@/lib/kapso/messages';
import { isMenuTriggerMessage, isOutboundMessage, extractTextBody } from './menu-trigger';
import { isGreetingOnly, isMenuIntent } from './menu-intent';
import { decideDefaultReply, type CustomerStateSnapshot } from './default-reply';
import { isExplicitMenuRequest } from '@/lib/agent/business/menu-request';
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
import { INCAPTURABLE_MEDIA, parseKapsoProvenance } from '@/lib/kapso/channel/provenance';
import type { ProvenanceMessage } from '@/lib/kapso/channel/provenance';
import {
  buildVisionAllowlist,
  withholdAttachments,
  withholdAttachmentsFromBurst,
  EMPTY_VISION_ALLOWLIST,
  type ProofClassification,
  type ProofGateEntry,
  type VisionAllowlist,
} from '@/lib/payment-proof/agent-gate';
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
  /**
   * De qué venía hablando el cliente. Solo elige el copy que acompaña al botón,
   * y por eso NO se persiste: no es un hecho del envío. Ver `menu/cta-context.ts`.
   */
  ctaContext?: MenuCtaContext | null;
  /**
   * Pedido al que el enlace viene a SUSTITUIR (0035). Cambia lo que el enlace
   * hace, no a quién se manda: el checkout que lo reciba reemplazará ese pedido.
   */
  replacesOrderId?: string | null;
  /** Etiqueta del botón. Ausente = "Ver menú". */
  buttonText?: string;
  /** Cuerpo ya redactado en backend. Ausente = lo elige el canal. */
  bodyText?: string;
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
 * Cotización de envío para un pin que NO responde a ninguna petición nuestra.
 *
 * Hasta 0027 ese mensaje moría aquí: el parser exige `context.id` para poder
 * correlacionar con `orders.location_request_message_id`, y un pin mandado con
 * el botón normal de WhatsApp no lo trae. Se descartaba como `invalid_shape`,
 * el clasificador lo daba por atendido y el agente ni lo veía. Resultado:
 * silencio absoluto al cliente que quería saber cuánto le sale el envío antes
 * de decidir si pide.
 *
 * La implementación real es server-only: mide con Mapbox (o reutiliza una
 * medición reciente del mismo punto), tarifa con `feeForMeters` y le contesta.
 * NUNCA lanza. Opcional: sin ella el comportamiento es el de antes.
 */
/**
 * Petición de ubicación para cotizar, cuando el cliente pregunta el precio del
 * envío ANTES de mandar su pin (0027).
 *
 * La respuesta es un texto fijo, así que no hay nada que elegir — y el modelo
 * elegía mal: medido con el eval real, derivaba a una persona 3 de cada 3 veces
 * ante "cuanto me saldria delivery aqui". Ver `delivery-quote-intent.ts`.
 *
 * Opcional: sin ella, esas preguntas siguen cayendo en el turno del agente,
 * que es el comportamiento previo.
 */
export type AskLocationForQuote = (input: {
  toDigits: string;
  phoneNumberId: string | null;
  sourceMessageId: string;
  /** Qué texto toca. Ausente = el de siempre. Ver `askLocationForQuote`. */
  reason?: 'asked' | 'link_without_coords';
}) => Promise<{ ok: boolean }>;

/**
 * En qué situación está el cliente que escribió (03-09-2026).
 *
 * Responde a la única pregunta que hace falta para el botón por defecto: ¿hay
 * alguien atendiéndole, y tiene un pedido en curso? La implementación real es
 * server-only y consulta la pausa del agente, el pedido abierto más reciente y
 * el estado de su pago.
 *
 * `null` significa NO SE PUDO AVERIGUAR —una consulta que falla, un teléfono
 * ilegible— y no "está despejado". Ante ese `null` no sale nada por defecto:
 * ver `decideDefaultReply`.
 *
 * NUNCA lanza: un fallo de contabilidad no puede tumbar una entrega que ya
 * atendió el pedido, la ubicación o el comprobante del cliente.
 */
export type LookupCustomerState = (
  customerPhone: string,
) => Promise<CustomerStateSnapshot | null>;

/**
 * Recordatorio del comprobante para el cliente que ya tiene su QR (03-09-2026).
 *
 * Es la respuesta por defecto de quien armó su pedido, recibió su total y aún no
 * mandó el pago: a ese, el menú no le sirve de nada. El texto lo construye el
 * canal a partir de datos del backend (`proofReminderText`); aquí solo viajan el
 * número de pedido y el monto.
 *
 * NUNCA lanza. Opcional: sin ella ese cliente no recibe nada, que es lo que
 * pasaba antes de esta política.
 */
export type SendProofReminder = (input: {
  toDigits: string;
  phoneNumberId: string | null;
  /** WAMID del mensaje del cliente. Clave de idempotencia del envío. */
  sourceMessageId: string;
  orderNumber: string;
  totalAmount: number;
  /** `received` = ya mandó su comprobante y se le dice que lo tenemos. */
  variant?: 'missing' | 'received';
}) => Promise<{ ok: boolean }>;

/**
 * "¿Querés agregar algo más?" y su cierre (05-09-2026).
 *
 * DOS envios que son el mismo diálogo: la pregunta con el desglose del pedido,
 * y la confirmación para quien contesta que está bien así. El texto lo
 * construye el canal con datos de la base; aquí solo viaja el pedido.
 *
 * `kept` distingue cuál de los dos, y no es cosmético: solo la PREGUNTA abre la
 * espera de una respuesta. Ver `send-order-review.ts`.
 *
 * NUNCA lanza. Opcional: sin él no se pregunta nada y el botón sale directo,
 * que es como se comportaba antes de esta pieza.
 */
export type SendOrderReview = (input: {
  toDigits: string;
  phoneNumberId: string | null;
  /** WAMID del mensaje del cliente. Clave de idempotencia del envío. */
  sourceMessageId: string;
  orderId: string;
  orderNumber: string;
  totalAmount: number;
  isCash: boolean;
  /** `true` = el cierre ("queda así"); ausente = la pregunta. */
  kept?: boolean;
}) => Promise<{ ok: boolean }>;

/**
 * "Sin cebolla" anotado en el pedido y confirmado al cliente (04-09-2026).
 *
 * DOS efectos que no se pueden separar: se escribe la nota en `orders.notes`
 * —que es lo que la cocina imprime— y solo entonces se le contesta al cliente
 * que sí. Si la nota no llega a escribirse, el mensaje NO sale: un "claro que
 * sí" sin nota es exactamente la promesa falsa que este proyecto persigue desde
 * agosto.
 *
 * NUNCA lanza. Opcional: sin ella, esas frases siguen su camino de hoy.
 */
export type AppendKitchenNote = (input: {
  toDigits: string;
  phoneNumberId: string | null;
  /** WAMID del mensaje del cliente. */
  sourceMessageId: string;
  orderId: string;
  /** El texto del cliente, ya saneado por `kitchenNoteFrom`. */
  note: string;
}) => Promise<{ ok: boolean }>;

/**
 * Pasa el pedido a recojo cuando el cliente dice que se lo lleva él.
 *
 * `ok: false` = no se convirtió, por guarda o por fallo. El webhook lo trata
 * como un mensaje SIN atender: nunca se le dice al cliente que quedó para
 * recoger si el pedido sigue saliendo a reparto.
 */
export type SwitchToPickup = (input: {
  toDigits: string;
  phoneNumberId: string | null;
  /** WAMID del mensaje del cliente. */
  sourceMessageId: string;
  orderId: string;
}) => Promise<{ ok: boolean }>;

/**
 * Comprobación del cliente atascado (0027 / 29-08-2026).
 *
 * Corre una vez por entrega, después de persistir los mensajes y con
 * independencia de quién los atendió. Antes colgaba del despacho del menú, así
 * que solo veía a quien pedía el menú una y otra vez; el que se traba
 * preguntando por el envío era invisible.
 *
 * NUNCA lanza y su resultado se ignora: es contabilidad, no puede tumbar una
 * entrega ya atendida. Opcional — sin ella no se comprueba nada.
 */
export type CheckStuckCustomer = (customerPhone: string) => Promise<void>;

export type QuoteStandaloneLocation = (input: {
  /** Teléfono del cliente, solo dígitos. */
  customerPhone: string;
  /** WAMID del pin. Es la clave de idempotencia del ledger. */
  sourceMessageId: string;
  coords: { lat: number; lng: number };
  phoneNumberId: string | null;
}) => Promise<{ result: string }>;

/**
 * Expansión de un link corto de Google Maps (0029).
 *
 * `maps.app.goo.gl/5biYBaWPiPGPPcyB9` no lleva coordenadas dentro: hay que
 * pedirle a Google la URL larga. Es la ÚNICA parte de este flujo con red, y por
 * eso es lo único que se inyecta — detectar el link y leer las coordenadas es
 * puro y vive en `@/lib/delivery/maps-link`.
 *
 * Opcional: sin ella, un link corto no se resuelve y el mensaje sigue su camino
 * de hoy (el agente). Las coordenadas escritas en el texto y los links ya
 * largos se atienden igual, porque no necesitan salir a ningún lado.
 */
export type ExpandMapsLink = (url: string) => Promise<string | null>;

/**
 * Rescate del pin que llegó sin contexto teniendo un pedido esperando (0028).
 *
 * El botón de ubicación que mandamos se contesta desde el propio mensaje, y
 * bastantes clientes no lo usan: adjuntan su ubicación con el clip de WhatsApp,
 * como harían en cualquier otro chat. Ese pin llega sin `context.id`, así que
 * no se puede correlacionar por wamid — pero el pedido que lo espera existe, y
 * se encuentra por teléfono.
 *
 * Opcional: sin ella, ese pin se sigue tratando como una consulta suelta de
 * tarifa, que es el comportamiento previo.
 */
export type AttachLooseLocation = (input: {
  /** Teléfono del cliente, solo dígitos. */
  customerPhoneDigits: string;
  latitude: number;
  longitude: number;
  address?: string | null;
  name?: string | null;
}) => Promise<AttachLocationResult>;

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
   * Cotización de un pin suelto (0027). Opcional: sin ella, una ubicación que no
   * responde a nuestra petición se sigue descartando en silencio.
   */
  quoteStandaloneLocation?: QuoteStandaloneLocation;
  /**
   * 0028: el pin que llegó sin contexto cuando hay un pedido esperándolo. Sin
   * ella, ese pin se sigue tratando como consulta suelta de tarifa.
   */
  attachLooseLocation?: AttachLooseLocation;
  /**
   * 0029: expande el link corto de Google Maps que el cliente manda en vez del
   * pin. Sin ella, esos links siguen cayendo en el agente.
   */
  expandMapsLink?: ExpandMapsLink;
  /** 0027: "¿cuánto sale el envío?" antes de que mande el pin. */
  askLocationForQuote?: AskLocationForQuote;
  /**
   * En qué situación está el cliente que acaba de escribir (03-09-2026).
   *
   * Es el INTERRUPTOR de la política "el botón por defecto": sin este puerto no
   * se manda nada por defecto y el texto suelto sigue cayendo en el agente,
   * exactamente como antes. No hay un modo intermedio a ciegas, y es
   * deliberado — lo que este puerto contesta incluye "hay un humano atendiendo
   * ahora mismo", y eso no se puede suponer.
   */
  lookupCustomerState?: LookupCustomerState;
  /**
   * Recordatorio del comprobante para quien ya tiene su QR (03-09-2026). Sin
   * este puerto ese cliente no recibe nada, que es lo que pasaba antes.
   */
  sendProofReminder?: SendProofReminder;
  sendOrderReview?: SendOrderReview;
  /**
   * Preferencias de cocina sobre un pedido ya armado (04-09-2026). Sin este
   * puerto, "sin cebolla" cae en el recordatorio del comprobante.
   */
  appendKitchenNote?: AppendKitchenNote;
  switchToPickup?: SwitchToPickup;
  /** Avisa al equipo del cliente que lleva muchos mensajes y no consigue pedir. */
  checkStuckCustomer?: CheckStuckCustomer;
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
  /** `null` cuando llegó media que el canal aún no sabe parsear. */
  attachment: ImageAttachment | null;
  /** Tipo declarado por el proveedor; solo se usa cuando no hay adjunto. */
  declaredMimeType?: string | null;
  providerPhoneNumberId: string | null;
  receivedAtMs: number;
}) => Promise<{
  result: string;
  /**
   * Veredicto del motor determinístico: ¿esto llegó COMO UN PAGO?
   *
   * Ausente significa "no me pronuncié", y la puerta de `agent-gate` lo trata
   * como comprobante (fail closed). Es opcional para que un doble de prueba que
   * solo comprueba la captura no tenga que hablar de Vision, no para que la
   * implementación real pueda ahorrárselo.
   */
  proofClassification?: ProofClassification;
}>;

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
 * Lo que recibe un cliente cuyo mensaje no encajó en ninguna puerta (03-09-2026).
 *
 * Devuelve el body cuando ATENDIÓ el mensaje, y `null` cuando no hay nada que
 * mandar — y entonces el mensaje sigue su camino de siempre hacia el agente.
 * Ese `null` es el que conserva intacto el comportamiento anterior en todo lo
 * que esta política no toca: sin puerto cableado, sin texto, sin ser el ancla
 * del lote o con un humano atendiendo, aquí no pasa nada.
 *
 * La DECISIÓN es pura y vive en `default-reply.ts`. Esto es solo el brazo: lee
 * el estado, pregunta qué hacer y lo hace.
 */
async function responderPorDefecto(
  ctx: {
    message: Record<string, unknown> | undefined;
    conversationPhone: string | null;
    from: string | null;
    phoneNumberId: string | null;
    ultimoTextoDelLote?: boolean;
    /** TODOS los textos entrantes de la entrega. Ver `batchTexts`. */
    textosDelLote?: readonly string[];
    menuYaEnviadoEnElLote?: boolean;
  },
  deps: {
    sendMenuCta: SendMenuCta;
    lookupCustomerState?: LookupCustomerState;
    sendProofReminder?: SendProofReminder;
  sendOrderReview?: SendOrderReview;
    appendKitchenNote?: AppendKitchenNote;
  switchToPickup?: SwitchToPickup;
  },
  /** Texto entrante del cliente, o `null` si el mensaje no era texto suyo. */
  texto: string | null,
  opciones: {
    /**
     * ¿Viene de la puerta de intención (`isMenuIntent`, el saludo pelado)?
     *
     * Las DOS puertas pasan por aquí desde el 03-09-2026, y esa es la parte
     * importante del cambio: antes, la petición explícita mandaba el botón sin
     * mirar nada, así que un cliente con una persona atendiéndole recibía un
     * CTA automático por escribir "quiero pedir". Las excepciones no pueden
     * depender de qué palabras usó.
     */
    explicita: boolean;
    /** Motivo del ledger cuando dispara la puerta de intención. */
    reason?: MenuSendReason;
    /** Estado ya consultado en este mismo mensaje. Evita preguntar dos veces. */
    estado?: CustomerStateSnapshot | null;
  },
): Promise<Record<string, unknown> | null> {
  const toDigits = normalizePhone(ctx.from ?? ctx.conversationPhone ?? '');
  const sourceMessageId = typeof ctx.message?.id === 'string' ? ctx.message.id : null;
  // Sin destinatario o sin WAMID no hay envío posible NI idempotencia que lo
  // proteja. Se declina en silencio: es el mismo criterio de la puerta del menú,
  // salvo que aquí nadie pidió nada, así que tampoco hay nada que rechazar.
  if (!toDigits || !sourceMessageId) return null;

  const phoneDigits = normalizePhone(ctx.conversationPhone ?? ctx.from ?? '');
  // Sin el puerto no se consulta nada y el estado queda desconocido. Lo que pasa
  // entonces lo decide `decideDefaultReply`, y no es lo mismo para los dos
  // caminos: al que pidió el menú se le manda igual —comportamiento de siempre—
  // y al que no, no se le manda nada. Esa asimetría es el interruptor: sin
  // cablear, esta política no existe y nada de lo anterior cambia.
  const state =
    opciones.estado !== undefined
      ? opciones.estado
      : deps.lookupCustomerState
        ? await deps.lookupCustomerState(phoneDigits || toDigits)
        : null;

  const decision = decideDefaultReply({
    text: texto,
    isBatchAnchor: ctx.ultimoTextoDelLote === true,
    batchTexts: ctx.textosDelLote,
    menuAlreadySent: ctx.menuYaEnviadoEnElLote === true,
    explicitIntent: opciones.explicita,
    state,
  });

  if (decision.action === 'none') {
    // Solo el motivo, que es un enum cerrado: ni teléfono, ni texto, ni número
    // de pedido. Sirve para responder "¿por qué este cliente no recibió nada?"
    // sin tener que leer la conversación de nadie.
    if (decision.reason !== 'no_text' && decision.reason !== 'not_anchor') {
      log.info('webhook_default_reply_skipped', { reason: decision.reason });
    }
    return null;
  }

  if (decision.action === 'pickup_switch') {
    // Sin puerto no se contesta que sí: decirle "queda para recoger" sin haberlo
    // convertido dejaría al repartidor saliendo igual.
    if (!deps.switchToPickup) return null;

    const convertido = await deps.switchToPickup({
      toDigits,
      phoneNumberId: ctx.phoneNumberId,
      sourceMessageId,
      orderId: decision.order.orderId,
    });
    // Ni el número de pedido ni el texto: solo si se pudo.
    log.info('webhook_pickup_switch', { result: convertido.ok ? 'switched' : 'skipped' });

    // Si no se pudo —ya salió el repartidor, el envío consta cobrado—, este
    // mensaje NO queda atendido: sigue su camino y lo verá una persona.
    if (!convertido.ok) return null;
    return { ok: true, handled: 'pickup_switch', result: 'switched' };
  }

  if (decision.action === 'kitchen_note') {
    // Sin puerto no se contesta que sí: sin escribir la nota, decirlo sería
    // mentir. Cae al camino de siempre, que como mucho le recordará el pago.
    if (!deps.appendKitchenNote) return null;

    const anotada = await deps.appendKitchenNote({
      toDigits,
      phoneNumberId: ctx.phoneNumberId,
      sourceMessageId,
      orderId: decision.order.orderId,
      note: decision.note,
    });
    // Ni la nota ni el número de pedido viajan al log: es texto del cliente.
    log.info('webhook_kitchen_note', { result: anotada.ok ? 'saved' : 'failed' });

    // Si no se pudo anotar, este mensaje NO queda atendido: se devuelve `null`
    // y sigue su camino —el agente puede contestarle— en vez de darle por
    // buena una preferencia que la cocina nunca verá.
    if (!anotada.ok) return null;
    return { ok: true, handled: 'kitchen_note', result: 'saved' };
  }

  if (decision.action === 'order_review' || decision.action === 'order_review_kept') {
    // Sin puerto no se pregunta nada: el mensaje sigue su camino. Preguntar y
    // no poder leer la respuesta sería peor que no preguntar.
    if (!deps.sendOrderReview) return null;

    const esCierre = decision.action === 'order_review_kept';
    const hecho = await deps.sendOrderReview({
      toDigits,
      phoneNumberId: ctx.phoneNumberId,
      sourceMessageId,
      orderId: decision.order.orderId,
      orderNumber: decision.order.orderNumber,
      totalAmount: decision.order.totalAmount,
      isCash: decision.order.paymentMethod === 'cash',
      kept: esCierre,
    });

    // Si no salió —o no quedó anotada— el turno NO se da por atendido: la
    // respuesta del cliente no se leería como tal, así que es mejor que el
    // mensaje siga su camino.
    if (!hecho.ok) return null;

    log.info('webhook_order_review', { variant: esCierre ? 'kept' : 'asked' });
    return { ok: true, handled: esCierre ? 'order_review_kept' : 'order_review', result: 'sent' };
  }

  if (decision.action === 'order_change') {
    // El MISMO despacho de siempre —claim, ledger, memoria—, con dos datos que
    // cambian lo que el enlace significa: a qué pedido sustituye y qué dice el
    // botón. El copy lo construye el canal con datos del backend (su número y
    // su total), nunca el modelo. Ver `orderChangeCtaText`.
    const sent = await deps.sendMenuCta({
      toDigits,
      phoneNumberId: ctx.phoneNumberId,
      sourceMessageId,
      // Pidió cambiar SU pedido: eso es una petición explícita, aunque no haya
      // dicho "menú" en ninguna parte.
      reason: 'explicit_request',
      replacesOrderId: decision.order.orderId,
      buttonText: MENU_CHANGE_BUTTON_TEXT,
      bodyText: orderChangeCtaText(
        decision.order.orderNumber,
        decision.order.totalAmount,
        decision.order.paymentMethod === 'cash',
      ),
    });

    if (sent.result === 'failed' || sent.result === 'send_unknown') {
      throw new MenuCtaSendError(sent.error);
    }
    log.info('webhook_order_change_offered', { result: sent.result });
    return { ok: true, handled: 'order_change', result: sent.result };
  }

  if (decision.action === 'proof_reminder') {
    // Sin puerto de recordatorio no se improvisa con el menú: mandarle la carta
    // a quien está por pagar es exactamente lo que esta rama evita.
    if (!deps.sendProofReminder) return null;

    const avisado = await deps.sendProofReminder({
      toDigits,
      phoneNumberId: ctx.phoneNumberId,
      sourceMessageId,
      orderNumber: decision.order.orderNumber,
      totalAmount: decision.order.totalAmount,
      variant: decision.variant,
    });
    log.info('webhook_proof_reminder', { result: avisado.ok ? 'sent' : 'failed' });
    return {
      ok: avisado.ok,
      handled: 'proof_reminder',
      result: avisado.ok ? 'sent' : 'failed',
    };
  }

  const sent = await deps.sendMenuCta({
    toDigits,
    phoneNumberId: ctx.phoneNumberId,
    sourceMessageId,
    // El motivo lo decide el backend leyendo el entrante REAL, con la MISMA
    // función que usa la tool del agente: el cliente que nombra la carta con
    // palabras que `isMenuIntent` no reconoce ("mandame la carta") llega hasta
    // aquí, y en el ledger tiene que constar como lo que fue — una petición.
    // Cuando dispara la puerta de intención, el motivo ya viene decidido por
    // ella, que sabe además si fue un saludo pelado.
    reason:
      opciones.reason ?? (isExplicitMenuRequest(texto) ? 'explicit_request' : 'agent_suggestion'),
    // El botón es el único mensaje que sale, así que su texto contesta lo que
    // el cliente acababa de preguntar. Es lo que convierte un botón en una
    // respuesta: quien pregunta un precio lee "los precios están todos ahí".
    ctaContext: classifyMenuCtaContext(texto),
  });

  if (sent.result === 'failed' || sent.result === 'send_unknown') {
    // Mismo trato que en la puerta del menú: 500 para que Kapso reintente, y el
    // reintento es seguro porque encuentra el claim y responde `duplicate`.
    throw new MenuCtaSendError(sent.error);
  }

  return { ok: true, handled: 'menu_cta', result: sent.result };
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
    /**
     * ¿Este mensaje llegó acompañado de otros en la MISMA entrega?
     *
     * Solo lo mira el saludo pelado, y es lo que impide dos botones seguidos.
     * El buffering de Kapso agrupa "Hola" / "quiero pedir" en un lote: si el
     * saludo contestara por su cuenta, el cliente recibiría un CTA por el
     * saludo y otro por la petición, en el mismo segundo.
     *
     * Dentro de una ráfaga el saludo es preámbulo, no mensaje — el mismo
     * criterio con el que `pickTurnAnchor` ancla el turno en el ÚLTIMO y no en
     * el primero. Ausente = entrega individual, que es un lote de uno.
     */
    rafagaDeVarios?: boolean;
    /**
     * ¿Es el ÚLTIMO texto entrante de esta entrega?
     *
     * Solo lo mira la respuesta POR DEFECTO (`default-reply.ts`), y es lo que
     * hace que una ráfaga produzca un botón y no tres. Es hermano de
     * `rafagaDeVarios` pero no lo mismo: aquel pregunta si el mensaje viene
     * acompañado, este cuál de los acompañantes contesta. Ausente = no es el
     * ancla, y entonces no sale nada por defecto.
     */
    ultimoTextoDelLote?: boolean;
    /** TODOS los textos entrantes de la entrega. Ver `batchTexts`. */
    textosDelLote?: readonly string[];
    /**
     * ¿Un mensaje ANTERIOR de esta misma entrega ya recibió el botón?
     *
     * Un lote puede traer "quiero pedir" y "a cuanto": la primera frase la
     * atiende la puerta de intención y la segunda es el ancla del default. Sin
     * esta bandera el cliente recibiría dos botones seguidos por haber escrito
     * dos veces, que es peor que el silencio que esta política vino a arreglar.
     */
    menuYaEnviadoEnElLote?: boolean;
  },
  deps: {
    confirmOrder: ConfirmOrder;
    ensureLocationRequest: EnsureLocationRequest;
    attachOrderLocation: AttachOrderLocation;
    sendMenuCta: SendMenuCta;
    quoteDynamicDelivery?: QuoteDynamicDelivery;
    quoteStandaloneLocation?: QuoteStandaloneLocation;
    attachLooseLocation?: AttachLooseLocation;
    expandMapsLink?: ExpandMapsLink;
    askLocationForQuote?: AskLocationForQuote;
    lookupCustomerState?: LookupCustomerState;
    sendProofReminder?: SendProofReminder;
  sendOrderReview?: SendOrderReview;
    appendKitchenNote?: AppendKitchenNote;
  switchToPickup?: SwitchToPickup;
  },
): Promise<Record<string, unknown>> {
  const { message, conversationPhone, from } = ctx;
  const { confirmOrder, ensureLocationRequest, attachOrderLocation } = deps;

  // El teléfono del cliente, una sola vez. Es el de la CONVERSACIÓN con el
  // remitente de respaldo, y tiene que ser el mismo en todos los caminos: si el
  // que adjunta y el que cotiza usaran teléfonos distintos, el ledger y el
  // pedido hablarían de clientes distintos y el reuso no encontraría nada.
  const phoneDigits = normalizePhone(conversationPhone ?? from ?? '');
  const wamid = typeof message?.id === 'string' ? message.id : null;

  // Acceso al menú: se consume aquí y no continúa hacia nfm_reply, ubicación ni
  // creación de pedidos. Activa por (a) intención natural del cliente
  // (`isMenuIntent`, Fase 6D.2E), (b) un saludo pelado (`isGreetingOnly`,
  // 03-09-2026) o (c) el trigger QA interno `TESTMENU9842`. La negación y el
  // filtrado de salientes ya viven en cada detector.
  //
  // El saludo entra por la MISMA puerta pero no con la misma etiqueta: quien
  // escribe "Hola" no ha pedido el menú, así que en el ledger queda como
  // `agent_suggestion` —"el entrante no lo nombraba"—, que es exactamente lo
  // que esa etiqueta significa. Lo que sí recibe es el saludo completo con el
  // horario, porque el contexto manda sobre el motivo al elegir el copy.
  const menuIntentBody = isOutboundMessage(message) ? null : extractTextBody(message);
  const soloSaludo =
    menuIntentBody !== null && !ctx.rafagaDeVarios && isGreetingOnly(menuIntentBody);
  const esTriggerQa = isMenuTriggerMessage(message);
  const intencionDeMenu =
    soloSaludo || (menuIntentBody !== null && isMenuIntent(menuIntentBody));

  /**
   * El estado del cliente, consultado UNA vez por mensaje.
   *
   * Las dos puertas del menú lo necesitan y las dos pueden evaluarse en el mismo
   * mensaje —la de intención declina por pausa, el mensaje sigue su camino y
   * llega abajo—, así que sin memoizar serían dos consultas idénticas separadas
   * por unos milisegundos.
   */
  let estadoConsultado: CustomerStateSnapshot | null | undefined;
  const estadoDelCliente = async (): Promise<CustomerStateSnapshot | null> => {
    if (estadoConsultado === undefined) {
      estadoConsultado = deps.lookupCustomerState
        ? await deps.lookupCustomerState(phoneDigits || normalizePhone(from ?? ''))
        : null;
    }
    return estadoConsultado;
  };

  if (esTriggerQa || intencionDeMenu) {
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

    if (esTriggerQa) {
      // El trigger interno NO pasa por las excepciones, y es lo único que no lo
      // hace: existe para comprobar de punta a punta que el CTA sale, y un
      // diagnóstico que a veces calla —porque quien prueba tenía un pedido
      // abierto o la conversación pausada— no diagnostica nada.
      const sent = await deps.sendMenuCta({
        toDigits,
        phoneNumberId: ctx.phoneNumberId,
        sourceMessageId,
        reason: 'qa_trigger',
        ctaContext: classifyMenuCtaContext(menuIntentBody),
      });
      if (sent.result === 'failed' || sent.result === 'send_unknown') {
        throw new MenuCtaSendError(sent.error);
      }
      return { ok: true, handled: 'menu_cta', result: sent.result };
    }

    // La petición del cliente pasa por el MISMO filtro que el botón automático.
    // Antes no lo hacía, y ese era el agujero: quien escribía "quiero pedir"
    // mientras una persona del equipo le respondía recibía igualmente un CTA
    // automático encima. Las excepciones no pueden depender de las palabras que
    // usó el cliente — ver `responderPorDefecto`.
    //
    // El saludo pelado no es una petición y por eso queda como
    // `agent_suggestion`, pero recorre esta misma puerta: lo que comparten es el
    // desenlace, no el significado.
    const atendido = await responderPorDefecto(ctx, deps, menuIntentBody, {
      explicita: true,
      reason: soloSaludo ? 'agent_suggestion' : 'explicit_request',
      estado: await estadoDelCliente(),
    });
    if (atendido) return atendido;

    // Declinó (pausa, o su pedido espera un comprobante que ya se le recordó).
    // El mensaje sigue su camino: puede llevar una ubicación dentro, y de todas
    // formas terminará en el agente, que tiene su propia barrera de pausa.
  }

  // ── Una ubicación entrante, venga como venga ───────────────────────────────
  //
  // Lo que sigue es UN camino con tres puertas: el pin nativo de WhatsApp
  // (0027/0028), el link de Google Maps y las coordenadas escritas (0029). Las
  // tres significan lo mismo —"aquí vivo"— y por eso terminan en la misma
  // función. Tener un camino por puerta era lo que hacía que el mismo cliente
  // recibiera su QR o silencio según qué botón hubiera encontrado.

  /**
   * Qué había en el texto.
   *
   * `link_ilegible` es su propio caso y no un `nada` cualquiera: hay una
   * diferencia enorme entre alguien que escribió algo sin ubicación y alguien
   * que CREE que acaba de mandarla. Al primero no hay que decirle nada; al
   * segundo, decirle "compartila con el botón" lo deja mandando el mismo link
   * otra vez — que es lo que pasó el 01-09-2026, dos veces.
   */
  type UbicacionEnTexto =
    | { tipo: 'coordenadas'; coords: { lat: number; lng: number } }
    | { tipo: 'link_ilegible' }
    | { tipo: 'nada' };

  /** Una ubicación ya reducida a números, sin importar cómo llegó. */
  interface UbicacionEntrante {
    coords: { lat: number; lng: number };
    /** WAMID del mensaje que la trajo. Clave de idempotencia del ledger. */
    sourceMessageId: string;
    address?: string | null;
    name?: string | null;
  }

  /**
   * El pedido que estaba esperando esta ubicación, si lo hay (0028).
   *
   * Se intenta ANTES de cotizar, y ese orden es todo el arreglo. Quien acaba de
   * armar su pedido y manda su ubicación —con el clip, con un link o copiando
   * las coordenadas— está contestando lo que le pedimos. Cotizárselo como
   * consulta de tarifa le devolvía un precio suelto y un "armá tu pedido en el
   * menú" que ya había hecho, mientras su pedido se quedaba esperando una
   * ubicación que ya había mandado: sin total, sin QR y sin nadie preparándolo.
   */
  const adjuntarUbicacion = async (
    u: UbicacionEntrante,
  ): Promise<Record<string, unknown> | null> => {
    if (!deps.attachLooseLocation) return null;
    if (!phoneDigits) return null;

    const adjuntada = await deps.attachLooseLocation({
      customerPhoneDigits: phoneDigits,
      latitude: u.coords.lat,
      longitude: u.coords.lng,
      address: u.address ?? null,
      name: u.name ?? null,
    });

    // Ningún pedido esperaba esto: no es un fallo, es la otra mitad del caso.
    // Vuelve `null` para que el llamador lo cotice suelto.
    if (adjuntada.result === 'not_found') return null;

    if (adjuntada.result === 'concurrent_update') {
      // Mismo trato que en el camino con contexto: fallo transitorio, el evento
      // queda reclamable.
      throw new LocationAttachRetryError();
    }

    // Cotizar es lo que convierte el GPS en un total con envío y en el QR. Sin
    // esto el pedido tendría ubicación y seguiría sin confirmarse: el silencio
    // de siempre, un paso más adelante.
    if (
      (adjuntada.result === 'attached' || adjuntada.result === 'already_attached') &&
      adjuntada.order.status === 'awaiting_location' &&
      deps.quoteDynamicDelivery
    ) {
      await deps.quoteDynamicDelivery(adjuntada.order.id);
    }

    return locationBody(adjuntada);
  };

  /**
   * Cotización de una ubicación que no adjunta a ningún pedido (0027).
   *
   * Para el cliente los tres caminos que llegan aquí significan lo mismo
   * —"mandé mi ubicación y nadie me dijo nada"—: que no responda a nada, que
   * responda a una petición que ya no tiene pedido detrás, o que ni siquiera
   * fuera un pin.
   */
  const cotizarUbicacion = async (
    u: UbicacionEntrante,
  ): Promise<Record<string, unknown> | null> => {
    if (!deps.quoteStandaloneLocation) return null;
    if (!phoneDigits) return null;

    const cotizacion = await deps.quoteStandaloneLocation({
      customerPhone: phoneDigits,
      sourceMessageId: u.sourceMessageId,
      coords: u.coords,
      phoneNumberId: ctx.phoneNumberId,
    });
    return { ok: true, handled: 'delivery_quote', result: cotizacion.result };
  };

  /** Primero el pedido que espera; si no hay ninguno, la tarifa. */
  const atenderUbicacion = async (
    u: UbicacionEntrante,
  ): Promise<Record<string, unknown> | null> => {
    const adjuntada = await adjuntarUbicacion(u);
    if (adjuntada) return adjuntada;
    return cotizarUbicacion(u);
  };

  /**
   * La ubicación que viene dentro de un TEXTO (0029).
   *
   * Mucha gente no usa el pin: abre Google Maps, busca su casa y le da a
   * compartir. Lo que llega es un texto con un link corto, así que hoy ni el
   * parser de ubicación lo ve ni el detector de "¿cuánto sale el envío?" lo
   * reconoce — termina en el modelo, que contesta pidiéndole la ubicación que
   * acaba de mandar.
   *
   * Las coordenadas escritas van PRIMERO porque salen gratis: son dos números,
   * sin red y sin depender del formato de nadie. El link corto es el único que
   * obliga a salir a internet, y solo se sale si de verdad hay uno.
   */
  const ubicacionEnTexto = async (texto: string): Promise<UbicacionEnTexto> => {
    const escritas = parsePlainCoords(texto);
    if (escritas) return { tipo: 'coordenadas', coords: escritas };

    const link = findMapsLink(texto);
    if (!link) return { tipo: 'nada' };

    let url = link;
    if (isShortMapsLink(link)) {
      // Sin el puerto no se sale a la red: el mensaje sigue su camino de hoy.
      if (!deps.expandMapsLink) return { tipo: 'nada' };
      const expandida = await deps.expandMapsLink(link);
      if (!expandida) return { tipo: 'link_ilegible' };
      url = expandida;
    }

    const extraida = extractCoordsFromMapsUrl(url);
    return extraida
      ? { tipo: 'coordenadas', coords: extraida.coords }
      : { tipo: 'link_ilegible' };
  };

  // Va DESPUÉS del menú y ANTES de "¿cuánto sale el envío?", y ese orden
  // importa: "cotízame aquí <link>" lleva palabra de coste y palabra de lugar,
  // así que `isDeliveryQuoteIntent` lo reconocería y le pediría la ubicación
  // que acaba de mandar. Quien YA mandó su ubicación no tiene que mandarla otra
  // vez.
  if (menuIntentBody !== null && wamid) {
    const desdeTexto = await ubicacionEnTexto(menuIntentBody);

    if (desdeTexto.tipo === 'coordenadas') {
      const atendida = await atenderUbicacion({
        coords: desdeTexto.coords,
        sourceMessageId: wamid,
      });
      if (atendida) return atendida;
    }

    /*
      Un link de Maps del que no se pudo sacar el punto.

      Hay dos clases de link corto y solo una sirve: compartir un LUGAR trae
      `!3d/!4d`, pero compartir "tu ubicación" desde la app expande a
      `?q=Av+Santos+Dumont…&ftid=…`, con el nombre de la calle y nada más.
      Medido con links reales del negocio; ni el User-Agent ni el segundo salto
      lo cambian, y geocodificar ese texto da el punto medio de una avenida de
      kilómetros — cobrar mal es peor que no cobrar.

      Antes esto caía al modelo, que contestaba "compartí tu ubicación con el
      botón" a alguien convencido de haberlo hecho. Ahora se le dice qué le
      faltó al link y qué tocar, por el camino determinista.
    */
    if (desdeTexto.tipo === 'link_ilegible' && deps.askLocationForQuote) {
      const toDigits = normalizePhone(from ?? conversationPhone ?? '');
      if (toDigits) {
        const avisada = await deps.askLocationForQuote({
          toDigits,
          phoneNumberId: ctx.phoneNumberId,
          sourceMessageId: wamid,
          reason: 'link_without_coords',
        });
        return {
          ok: avisada.ok,
          handled: 'delivery_quote_prompt',
          result: avisada.ok ? 'sent' : 'failed',
          reason: 'link_without_coords',
        };
      }
    }
  }

  // "¿Cuánto sale el envío?" (0027). Va DESPUÉS del menú a propósito: quien
  // escribe "quiero pedir, cuánto sale el envío" quiere pedir, y el CTA sigue
  // ganando. Aquí solo se recogen los mensajes que HOY caen en el modelo — y
  // que el modelo resuelve derivándolos a una persona.
  if (
    deps.askLocationForQuote &&
    menuIntentBody !== null &&
    isDeliveryQuoteIntent(menuIntentBody)
  ) {
    const toDigits = normalizePhone(from ?? conversationPhone ?? '');
    const sourceMessageId = typeof message?.id === 'string' ? message.id : null;
    // Sin destinatario o sin WAMID no se inventa nada: cae al camino de antes.
    if (toDigits && sourceMessageId) {
      const pedida = await deps.askLocationForQuote({
        toDigits,
        phoneNumberId: ctx.phoneNumberId,
        sourceMessageId,
      });
      return { ok: pedida.ok, handled: 'delivery_quote_prompt', result: pedida.ok ? 'sent' : 'failed' };
    }
  }

  // Ubicación entrante (Fase 3.3B): se comprueba antes que nfm_reply porque
  // `location` no es un mensaje `interactive`.
  if (message?.type === 'location') {
    /** El pin como ubicación entrante, si sus coordenadas son legibles. */
    const pin = ((): UbicacionEntrante | null => {
      const suelta = parseStandaloneLocation(message);
      if (!suelta.ok) return null;
      return {
        coords: { lat: suelta.data.latitude, lng: suelta.data.longitude },
        sourceMessageId: suelta.data.messageId,
        address: suelta.data.address ?? null,
        name: suelta.data.name ?? null,
      };
    })();

    const adjuntarSuelta = async () => (pin ? adjuntarUbicacion(pin) : null);
    const cotizarSuelta = async () => (pin ? cotizarUbicacion(pin) : null);

    const parsedLocation = parseLocationMessage(message);
    if (!parsedLocation.ok) {
      // Un pin sin `context.id` NO es un payload roto. Son dos personas
      // distintas, y en este orden: la que ya armó su pedido y contesta con el
      // clip de WhatsApp en vez de con el botón, y la que solo pregunta cuánto
      // le sale el envío. Primero se mira si hay un pedido esperando; si no lo
      // hay, es una consulta de tarifa.
      const adjuntada = await adjuntarSuelta();
      if (adjuntada) return adjuntada;

      const cotizada = await cotizarSuelta();
      if (cotizada) return cotizada;

      // 'not_location' no debería ocurrir aquí (ya filtramos por type), pero se
      // trata igual que un payload inválido: no reintentar.
      return { ok: false, handled: 'location', result: 'invalid', reason: parsedLocation.reason };
    }

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

    // El pin respondía a una petición nuestra, pero ya no hay pedido detrás: el
    // cliente reutilizó un botón viejo, o el pedido se fue. Puede que tenga otro
    // pedido esperando ubicación —el botón viejo estaba a mano y lo tocó—, y en
    // ese caso el pin es para ese. Si tampoco, su ubicación sigue siendo una
    // pregunta legítima y se cotiza en vez de callar.
    if (attach.result === 'not_found') {
      const adjuntada = await adjuntarSuelta();
      if (adjuntada) return adjuntada;

      const cotizada = await cotizarSuelta();
      if (cotizada) return cotizada;
    }

    return locationBody(attach);
  }

  const parsed = parseNfmReply(message);

  if (!parsed.ok) {
    if (parsed.reason === 'not_nfm') {
      // ── LA RESPUESTA POR DEFECTO (03-09-2026) ────────────────────────────
      //
      // Aquí abajo es donde tiene que estar, y no arriba con `isMenuIntent`:
      // esto no es un detector más, es lo que se hace cuando NINGÚN detector
      // reconoció nada. Todas las puertas específicas —la ubicación en
      // cualquiera de sus formas, la cotización del envío, el pedido armado—
      // ya dijeron que no, así que lo que queda es un cliente escribiendo sin
      // que sepamos exactamente qué quiere.
      //
      // Y a ese, hasta hoy, le contestaba el modelo con una pregunta. Ahora le
      // llega el botón. Ver `default-reply.ts` para las excepciones.
      const porDefecto = await responderPorDefecto(ctx, deps, menuIntentBody, {
        explicita: false,
        estado: await estadoDelCliente(),
      });
      if (porDefecto) return porDefecto;

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
    quoteStandaloneLocation?: QuoteStandaloneLocation;
    attachLooseLocation?: AttachLooseLocation;
    expandMapsLink?: ExpandMapsLink;
    askLocationForQuote?: AskLocationForQuote;
    lookupCustomerState?: LookupCustomerState;
    sendProofReminder?: SendProofReminder;
  sendOrderReview?: SendOrderReview;
    appendKitchenNote?: AppendKitchenNote;
  switchToPickup?: SwitchToPickup;
  },
): Promise<EnvelopeResult[]> {
  const results: EnvelopeResult[] = [];

  // ── Cuál de los mensajes del lote contesta ────────────────────────────────
  //
  // El ÚLTIMO texto entrante, por posición en `data[]`. Se calcula antes del
  // bucle porque la respuesta por defecto se decide mensaje a mensaje y sin esto
  // "buenas" / "noches" / "a cuanto" saldría con tres botones en el mismo
  // segundo — que es peor que el silencio que vino a arreglar.
  //
  // Es el mismo criterio de `pickTurnAnchor` (el que cierra la ráfaga es el que
  // el cliente espera que se conteste), aplicado antes y sobre menos cosas: aquí
  // solo cuenta el texto, porque solo el texto puede recibir el botón.
  const ultimoTextoIndex = ((): number | null => {
    let encontrado: number | null = null;
    for (const envelope of envelopes) {
      const { message } = extractMessageContext(envelope.payload);
      if (isOutboundMessage(message)) continue;
      if (extractTextBody(message) === null) continue;
      encontrado = envelope.index;
    }
    return encontrado;
  })();

  // ── Y QUÉ se contesta, que no es lo mismo (05-09-2026) ────────────────────
  //
  // El ancla dice CUÁNDO responder —una vez por ráfaga— pero no puede decidir
  // qué, porque la petición va en el primer mensaje y la cortesía en el último:
  // "Un vaso de lims" / "Grande" / "También" / "Xfa". La primera frase sí se
  // reconoce; el ancla, "Xfa", no dice nada. Aquel cliente no recibió respuesta
  // y acabó armando un segundo pedido. Ver `batchTexts` en `default-reply`.
  const textosDelLote = envelopes.reduce<string[]>((acc, envelope) => {
    const { message } = extractMessageContext(envelope.payload);
    if (isOutboundMessage(message)) return acc;
    const texto = extractTextBody(message);
    if (texto !== null) acc.push(texto);
    return acc;
  }, []);

  // Un botón por entrega, venga de la puerta que venga. Se acumula dentro del
  // bucle porque los sobres se procesan EN ORDEN: cuando le toca al ancla, ya
  // consta si alguno anterior mandó el suyo.
  let menuYaEnviado = false;

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
    const body = await processMessage(
      {
        ...ctx,
        // Un lote de uno es una entrega individual: solo a partir de dos hay
        // ráfaga, y solo entonces el saludo se lee como preámbulo.
        rafagaDeVarios: envelopes.length > 1,
        ultimoTextoDelLote: ultimoTextoIndex !== null && envelope.index === ultimoTextoIndex,
        textosDelLote,
        menuYaEnviadoEnElLote: menuYaEnviado,
      },
      deps,
    );

    // `duplicate` no cuenta: significa que ESE wamid ya se había atendido en
    // otra entrega, no que este cliente acabe de recibir un botón ahora.
    if (body.handled === 'menu_cta' && body.result === 'sent') menuYaEnviado = true;

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
  const mensajes = results.filter((r) => r.message !== null && !r.channelEvent);

  // ── La entrega ya fue contestada (03-09-2026) ─────────────────────────────
  //
  // Si el ÚLTIMO mensaje del cliente lo atendió el pipeline determinístico —su
  // botón, su cotización, su pedido confirmado—, la ráfaga entera ya tiene
  // respuesta y el turno sobra. Y no sobra en abstracto: sin esto, "buenas" /
  // "noches" / "a cuanto" produce el botón por el tercero Y una frase del modelo
  // por el segundo, porque los dos primeros declinaron y uno de ellos ancla.
  //
  // Dos respuestas a la misma ráfaga es justo lo que el cliente lee como que no
  // le entendimos. Antes casi no pasaba —el determinístico atendía muy poco—;
  // con el botón por defecto pasaría en cada conversación que empieza.
  //
  // Se mira el ÚLTIMO y no "si hubo alguno": en `[ubicación, "y cuánto tarda?"]`
  // la ubicación tiene su propio camino y la pregunta sigue siendo del modelo.
  const ultimo = mensajes[mensajes.length - 1];
  if (ultimo && ultimo.kind === 'deterministic') return null;

  // ── Y el botón del menú cierra la entrega, esté donde esté ────────────────
  //
  // Es la misma regla que ya gobierna la tool del agente (`effectCompletesTurn`
  // en `send_menu`): el CTA lleva imagen, copy y botón, o sea que ES la
  // respuesta entera, y un turno que hable después solo puede repetirla o
  // contradecirla. Vale igual cuando el botón salió por el camino determinista.
  //
  // El caso llega en cuanto se agrupan dos mensajes: "quiero pedir" abre el
  // botón por la puerta de intención y "a cuanto está el trancapecho" queda de
  // ancla — sin esto, el cliente recibe su menú y encima una frase del modelo.
  //
  // `duplicate` cuenta como enviado: significa que ese WAMID ya produjo un CTA,
  // así que el cliente lo tiene igual.
  const menuEntregado = results.some(
    (r) => r.body.handled === 'menu_cta' && (r.body.result === 'sent' || r.body.result === 'duplicate'),
  );
  if (menuEntregado) return null;

  const candidatos = mensajes.filter((r) => r.kind !== 'deterministic');
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
): Promise<{ outcomes: string[]; allowlist: VisionAllowlist }> {
  const outcomes: string[] = [];
  /** Veredicto por WAMID. De aquí sale la lista de AUTORIZADOS a Vision. */
  const veredictos: ProofGateEntry[] = [];
  for (const envelope of envelopes) {
    const provenance = parseKapsoProvenance(eventName, envelope.payload);
    if (provenance.kind !== 'customer_inbound') continue;

    const { message } = provenance;

    // Imagen o DOCUMENTO: los dos son comprobantes validos y recorren el mismo
    // motor. Un comprobante bancario descargado de la app del banco llega como
    // PDF, y hasta ahora ese camino no existia.
    //
    // La imagen tiene prioridad solo por orden de aparicion: un mensaje trae uno
    // u otro, nunca los dos.
    const attachment = message.image ?? message.document ?? null;

    // Media que este canal todavia no sabe leer —hoy audio y video—. NO se
    // descarta: hasta ahora un `continue` mudo la hacia desaparecer sin fila,
    // sin log y sin respuesta. Se manda al motor sin adjunto, y alli se decide
    // si merece registro (solo si habia un pedido esperando cobro) o si es
    // ruido.
    const mediaSinLeer = attachment === null && INCAPTURABLE_MEDIA.has(message.contentType);
    if (!attachment && !mediaSinLeer) continue;
    if (!message.providerMessageId || !message.customerPhone) continue;

    try {
      const res = await intake({
        sourceMessageId: message.providerMessageId,
        customerPhone: message.customerPhone,
        attachment,
        declaredMimeType: attachment ? null : message.declaredMediaMimeType,
        providerPhoneNumberId: message.providerPhoneNumberId,
        receivedAtMs: Date.now(),
      });
      outcomes.push(res.result);
      veredictos.push({
        sourceMessageId: message.providerMessageId,
        classification: res.proofClassification ?? 'unknown',
      });
    } catch {
      // Un comprobante problematico no tumba la entrega del resto.
      outcomes.push('failed');
      // …y NO autoriza a ese mensaje. El motor no llegó a decidir, y una
      // imagen sin veredicto no viaja a OpenAI.
      veredictos.push({
        sourceMessageId: message.providerMessageId,
        classification: 'unknown',
      });
    }
  }
  return { outcomes, allowlist: buildVisionAllowlist(veredictos) };
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
      quoteStandaloneLocation: params.quoteStandaloneLocation,
      attachLooseLocation: params.attachLooseLocation,
      expandMapsLink: params.expandMapsLink,
      askLocationForQuote: params.askLocationForQuote,
      lookupCustomerState: params.lookupCustomerState,
      sendProofReminder: params.sendProofReminder,
      sendOrderReview: params.sendOrderReview,
      appendKitchenNote: params.appendKitchenNote,
      switchToPickup: params.switchToPickup,
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
    //
    // De aquí sale también la LISTA DE AUTORIZADOS: qué WAMIDs recibieron un
    // veredicto explícito de "esto no es un pago" y solo por eso pueden mandar
    // sus bytes al modelo. Se calcula ANTES del turno porque ese es el único
    // orden en el que puede servir de algo.
    //
    // Sin puerto de captura cableado la lista queda VACÍA, y vacía significa
    // que ningún adjunto viaja. No hay un tercer camino sin puerta.
    const captura = params.paymentProofIntake
      ? await capturePaymentProofs(normalized.envelopes, eventName, params.paymentProofIntake)
      : { outcomes: [] as string[], allowlist: EMPTY_VISION_ALLOWLIST };
    const proofs = captura.outcomes;

    // ── El turno agregado ────────────────────────────────────────────────────
    //
    // COMO MÁXIMO uno por entrega, ancla incluida. No se concatena nada ni se
    // fabrica un mensaje nuevo: el ancla es un mensaje REAL del cliente, con su
    // WAMID, y la ráfaga entera ya está persistida antes de llamar al modelo —
    // así que el contexto la ve completa y en orden sin ningún vínculo explícito.
    // ── ¿Se está trabando este cliente? ──────────────────────────────────────
    //
    // Va aquí, no en el turno del agente: cuando el pipeline determinista
    // atiende un mensaje —el CTA del menú, la cotización del envío— no hay
    // turno, y son justo esos clientes los que se quedaban sin detectar. Los
    // mensajes ya están persistidos, así que el conteo incluye el de ahora.
    //
    // Best-effort y sin `await` que pueda tumbar nada: el módulo captura sus
    // propios errores. Se hace ANTES del turno para que la pausa, si la pone,
    // frene al agente en su barrera en lugar de dejarlo hablar encima.
    const anclaCliente = results.find((r) => r.message !== null)?.message ?? null;
    if (params.checkStuckCustomer && anclaCliente) {
      const phoneDigits = normalizePhone(anclaCliente.customerPhone);
      if (phoneDigits) await params.checkStuckCustomer(phoneDigits);
    }

    const anchor = pickTurnAnchor(results);
    let turn: string | null = null;
    if (anchor?.message && params.agentChannel?.runAgentTurn) {
      // El BURST entero, en el orden de `data[]` (5C.5). El ancla decide DE QUÉ
      // mensaje es el turno —y con ello la idempotencia—, pero lo que el modelo
      // tiene que mirar puede estar en otro elemento: en `[foto, "¿qué
      // hamburguesa es esta?"]` el ancla es el texto y la imagen es el otro.
      // Solo entrantes reales del cliente; lo determinístico ya se atendió.
      const crudo = results
        .filter((r) => r.message !== null)
        .map((r) => r.message!) as readonly ProvenanceMessage[];

      // ── LA PUERTA DE COMPROBANTES ─────────────────────────────────────────
      //
      // Último punto antes del agente en el que los bytes siguen siendo
      // nuestros. Lo que la puerta retiene NO llega a `runAgentTurn`, luego no
      // llega a `resolveImage`, luego no existe un data URL, luego no se
      // construye `input_image` y luego OpenAI no ve nada. La cadena se corta
      // aquí y no más abajo justamente para que no haya un "más abajo".
      //
      // AUTORIZACIÓN POSITIVA: viaja lo que está en `allowlist`, no lo que no
      // está en una lista de prohibidos. La diferencia importa porque el modo de
      // fallo se invierte — sin veredicto, sin identidad, sin motor o sin puerto
      // cableado, la lista no contiene a nadie y no sale ni un byte.
      //
      // El texto NO se toca: el mensaje sigue entero, solo sin adjunto. Y el
      // ancla se pasa por la misma puerta porque `runAgentTurn` cae a `[message]`
      // cuando no hay burst — dejarla sin filtrar sería dejar la puerta con una
      // ventana abierta al lado.
      const { messages: burst, withheld } = withholdAttachmentsFromBurst(
        crudo,
        captura.allowlist,
      );
      if (withheld > 0) {
        // Recuento y nada más: ni WAMID, ni teléfono, ni tipo de archivo.
        log.info('agent_burst_proof_withheld', { withheld, burst_size: burst.length });
      }
      const anclaFiltrada = withholdAttachments(anchor.message, captura.allowlist);
      turn = await runAgentTurnSafely(params.agentChannel, anclaFiltrada, burst);
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
