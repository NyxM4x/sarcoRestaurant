import { normalizePhone } from '@/lib/phone';
import { parseKapsoTimestamp } from '@/lib/kapso/message-history';
import { isReactionMessage, reactionMetadata } from './reaction';
import { isImageMessage, imageMetadata, parseImage, type ImageAttachment } from './image';
import { parseDocument } from './document';

/**
 * Clasificación de PROCEDENCIA de un evento de Kapso — módulo PURO (Fase 6D.2F.2B).
 *
 * Contrato oficial confirmado por Kapso Support para WhatsApp Coexistence: un
 * mensaje enviado a mano desde WhatsApp Business App llega como
 * `whatsapp.message.sent` con `kapso.direction='outbound'` y
 * `kapso.origin='business_app'`. Nuestros propios envíos por API llegan con
 * `origin='cloud_api'`.
 *
 * Este módulo clasifica por PROCEDENCIA (quién originó el mensaje), nunca por
 * CONTENIDO. La clasificación por contenido ya existe y vive aparte
 * (`outbound-classify.ts`, que reconoce el copy de las notificaciones de pedido);
 * mezclarlas acoplaría el takeover humano al subsistema de pedidos.
 *
 * Regla dura: NO hay heurísticas. Solo hay takeover humano cuando los tres
 * campos coinciden exactamente. Ante la duda se devuelve `unknown` y el webhook
 * sigue su camino de siempre.
 */

export const KAPSO_EVENT_RECEIVED = 'whatsapp.message.received';
export const KAPSO_EVENT_SENT = 'whatsapp.message.sent';

/** Enviado a mano por un trabajador desde WhatsApp Business App. */
export const KAPSO_ORIGIN_BUSINESS_APP = 'business_app';
/** Enviado por nuestra API (notificaciones, CTA del menú, QR, ubicación). */
export const KAPSO_ORIGIN_CLOUD_API = 'cloud_api';

/**
 * Eventos de ciclo de vida de un saliente ya emitido. NUNCA son un mensaje
 * humano nuevo, ni siquiera con `origin='business_app'`: se refieren al MISMO
 * wamid que ya llegó en `whatsapp.message.sent`.
 */
export const KAPSO_LIFECYCLE_EVENTS = [
  'whatsapp.message.delivered',
  'whatsapp.message.read',
  'whatsapp.message.failed',
] as const;

/** Dominio de `agent_messages.content_type` (migración 0014). */
export type ProvenanceContentType =
  | 'text'
  | 'image'
  | 'audio'
  | 'video'
  | 'document'
  | 'sticker'
  | 'location'
  | 'interactive'
  | 'unknown';

const CONTENT_TYPES: ReadonlySet<string> = new Set([
  'text',
  'image',
  'audio',
  'video',
  'document',
  'sticker',
  'location',
  'interactive',
]);

/** Tipos de media que pueden traer `caption`. */
const CAPTIONABLE: ReadonlySet<ProvenanceContentType> = new Set([
  'image',
  'audio',
  'video',
  'document',
]);

/**
 * Media que el cliente manda como ARCHIVO y este canal todavía no sabe parsear.
 *
 * Existe para que un archivo sin parser no se evapore: es lo que llega cuando
 * alguien manda su comprobante en PDF —lo habitual si lo descargó de la app del
 * banco en vez de hacer una captura— o cuando explica el pago en un audio.
 *
 * `sticker` queda FUERA a propósito: nadie paga con un sticker, y admitirlo solo
 * añadiría ruido al panel. La lista es de cosas que plausiblemente son un pago,
 * no de todo lo que no sabemos leer.
 */
export const INCAPTURABLE_MEDIA: ReadonlySet<ProvenanceContentType> = new Set([
  'document',
  'audio',
  'video',
]);

/** Datos del mensaje ya normalizados, listos para persistir en `agent_messages`. */
export interface ProvenanceMessage {
  /** wamid (`message.id`). Sin él no hay idempotencia semántica posible. */
  providerMessageId: string | null;
  /** `conversation.id` — referencia técnica volátil, NUNCA identidad. */
  providerConversationId: string | null;
  /** Identidad durable: `conversation.phone_number` normalizado a dígitos. */
  customerPhone: string;
  providerPhoneNumberId: string | null;
  /** ISO 8601, o `null` si el proveedor no mandó un instante interpretable. */
  messageTimestamp: string | null;
  direction: string | null;
  origin: string | null;
  status: string | null;
  content: string | null;
  contentType: ProvenanceContentType;
  metadata: Record<string, unknown> | null;
  /**
   * Adjunto de imagen del evento ACTUAL (Fase 6D.2F.5C.5), con sus referencias
   * TRANSITORIAS de acceso.
   *
   * Viaja aparte de `metadata` a propósito: `metadata` es lo que se escribe en
   * la base, y aquí dentro hay URLs con acceso al contenido del cliente que no
   * pueden persistirse. Vive solo mientras se procesa esta entrega, que es
   * exactamente el tiempo durante el que esas URLs sirven.
   */
  image?: ImageAttachment | null;
  /**
   * Adjunto de DOCUMENTO del evento actual (hoy solo PDF), con sus referencias
   * transitorias de acceso.
   *
   * Viaja aparte de `image` a propósito, aunque comparta forma: el destino de
   * los bytes es distinto. Una imagen puede acabar en la entrada de Vision del
   * agente; un documento NO, y solo se captura como comprobante. Mezclarlos en
   * un campo obligaría a distinguirlos otra vez en cada consumidor, y bastaría
   * olvidarlo una sola vez para mandarle un PDF al modelo.
   */
  document?: ImageAttachment | null;
  /**
   * Tipo que el proveedor DECLARA para la media adjunta, sin descargar nada.
   *
   * Es lo único que se puede contar de un archivo que no sabemos parsear, y sirve
   * para que el panel diga «llegó un PDF» en vez de un «no disponible» mudo. Es
   * una afirmación del proveedor, NO un hecho verificado: cuando el archivo se
   * descarga manda siempre el tipo deducido de los bytes.
   */
  declaredMediaMimeType?: string | null;
}

export type KapsoProvenance =
  /** Mensaje real del cliente. */
  | { kind: 'customer_inbound'; message: ProvenanceMessage }
  /** Saliente HUMANO desde WhatsApp Business App → dispara el takeover. */
  | { kind: 'human_outbound'; message: ProvenanceMessage }
  /** Saliente propio (`cloud_api`): notificaciones, CTA, QR, ubicación. */
  | { kind: 'system_outbound'; message: ProvenanceMessage }
  /** delivered / read / failed del MISMO wamid: nunca un mensaje nuevo. */
  | { kind: 'lifecycle'; providerMessageId: string | null; status: string | null; origin: string | null }
  /** Cualquier otra cosa: el webhook sigue su camino de siempre. */
  | { kind: 'unknown' };

// ── Helpers de acceso seguro sobre `unknown` ─────────────────────────────────

function rec(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** `message.type` → dominio cerrado de `content_type`; nunca inventa un tipo. */
export function toContentType(messageType: string | null): ProvenanceContentType {
  if (messageType !== null && CONTENT_TYPES.has(messageType)) {
    return messageType as ProvenanceContentType;
  }
  return 'unknown';
}

/**
 * Texto REAL del mensaje, o `null`. Jamás se fabrica un marcador tipo
 * `[LOCATION]`: si no hay texto, la columna queda NULL (la migración 0014 lo
 * permite para todo `content_type` que no sea `text`).
 */
function extractContent(
  message: Record<string, unknown>,
  contentType: ProvenanceContentType,
): string | null {
  if (contentType === 'text') return str(rec(message.text)?.body);

  if (CAPTIONABLE.has(contentType)) {
    return str(rec(message[contentType])?.caption);
  }

  if (contentType === 'interactive') {
    return str(rec(rec(message.interactive)?.body)?.text);
  }

  // location y sticker no tienen texto propio.
  if (contentType === 'location' || contentType === 'sticker') return null;

  // Tipo desconocido: se acepta un cuerpo textual si el proveedor lo trae.
  return str(rec(message.text)?.body) ?? str(rec(message.kapso)?.content);
}

/**
 * Metadatos ESTRUCTURALES mínimos. Nunca el payload completo del webhook, nunca
 * secretos, nunca tokens. Solo lo que se perdería si no se guardara aquí.
 */
function extractMetadata(
  message: Record<string, unknown>,
  contentType: ProvenanceContentType,
): Record<string, unknown> | null {
  if (contentType === 'location') {
    const location = rec(message.location);
    const latitude = num(location?.latitude);
    const longitude = num(location?.longitude);
    if (latitude === null || longitude === null) return null;
    return { latitude, longitude };
  }

  if (contentType === 'interactive') {
    const interactiveType = str(rec(message.interactive)?.type);
    return interactiveType === null ? null : { interactive_type: interactiveType };
  }

  return null;
}

/**
 * Tipo declarado de la media, leído de `kapso.media_data.content_type`.
 *
 * Ese bloque es el descriptor genérico de adjunto de Kapso —trae `filename`,
 * `byte_size` y `content_type`— y es el único sitio observado en un payload REAL
 * (18-08-2026 y 27-08-2026, ambos de imagen) donde el tipo viaja de forma
 * uniforme.
 *
 * Si para un documento Kapso lo pusiera en otro campo, esto devuelve `null` y el
 * panel muestra el archivo sin decir de qué tipo era. Se degrada, no se rompe:
 * adivinar la ruta del dato sería inventar un contrato que no hemos visto.
 */
function declaredMediaMime(kapso: Record<string, unknown> | undefined): string | null {
  return str(rec(kapso?.media_data)?.content_type);
}

/** Instante del proveedor en ISO, o `null`. Nunca cae a "ahora" en silencio. */
function extractTimestamp(message: Record<string, unknown>, root: Record<string, unknown>): string | null {
  const ms = parseKapsoTimestamp(message.timestamp ?? root.timestamp ?? message.created_at);
  return ms === null ? null : new Date(ms).toISOString();
}

/**
 * Construye la vista normalizada del mensaje.
 *
 * `customerPhone` sale SIEMPRE de `conversation.phone_number` (§4): en un
 * saliente, `message.from` es el número del NEGOCIO, así que usarlo como
 * identidad crearía una conversación por número de negocio en vez de por
 * cliente. Solo en entrantes se admite `message.from` como respaldo.
 */
function buildMessage(
  root: Record<string, unknown>,
  message: Record<string, unknown>,
  kapso: Record<string, unknown> | undefined,
  conversation: Record<string, unknown> | undefined,
  inbound: boolean,
): ProvenanceMessage {
  const declaredType = toContentType(str(message.type));

  // ── Reacción: evento de canal, no algo que el cliente dijo ────────────────
  //
  // Es la ÚNICA excepción a la extracción normal de contenido, y existe por una
  // razón concreta: para `content_type='unknown'`, `extractContent` acepta
  // `kapso.content` como cuerpo textual. En una reacción ese campo trae una
  // frase redactada por Kapso —"Reacted with ❤️ to message wamid…"— que ningún
  // cliente escribió, en un idioma que no es el de la conversación.
  //
  // Guardarla como `content` la convertiría en palabras del cliente para
  // siempre: el contexto del modelo se construye leyendo `content`, así que la
  // frase reaparecería en un turno POSTERIOR como si el cliente la hubiera
  // tecleado. La reacción se guarda entera, pero por `metadata`, que es donde
  // vive lo que pasó en el canal.
  const esReaccion = isReactionMessage(message);
  const esImagen = isImageMessage(message);

  // La imagen usa su propio extractor de caption (5C.5): `extractContent` solo
  // mira `image.caption`, y el contrato real trae además un respaldo
  // estructural en `kapso.message_type_data.caption`. Lo que NUNCA se toca es
  // `kapso.content`, que mezcla el caption del cliente con filename, tamaño y
  // una URL de acceso a su foto.
  const content = esReaccion
    ? null
    : esImagen
      ? (parseImage(message)?.caption ?? null)
      : extractContent(message, declaredType);

  // El CHECK `agent_messages_content_coherence` de 0014 exige texto real cuando
  // `content_type='text'`. Un `type:'text'` sin body utilizable no puede, por
  // tanto, anunciarse como texto: se degrada a `unknown` con `content = NULL`.
  // Inventar contenido para salvar el CHECK sería peor que admitir que no se
  // pudo leer, y sin esta degradación el mensaje quedaría irreconciliable con la
  // base y se reintentaría para siempre.
  const contentType = declaredType === 'text' && content === null ? 'unknown' : declaredType;

  const phoneSource =
    str(conversation?.phone_number) ?? (inbound ? str(message.from) : str(message.to));

  return {
    providerMessageId: str(message.id),
    providerConversationId: str(conversation?.id),
    customerPhone: normalizePhone(phoneSource ?? ''),
    providerPhoneNumberId:
      str(root.phone_number_id) ?? str(conversation?.phone_number_id),
    messageTimestamp: extractTimestamp(message, root),
    direction: str(kapso?.direction),
    origin: str(kapso?.origin),
    status: str(kapso?.status),
    content,
    contentType,
    metadata: esReaccion
      ? reactionMetadata(message)
      : esImagen
        ? imageMetadata(message)
        : extractMetadata(message, contentType),
    // Solo en entrantes con imagen. Las URLs de `transient` no se persisten:
    // `imageMetadata` decide qué se guarda, y ahí no entra ninguna.
    image: esImagen && inbound ? parseImage(message) : null,
    // Solo en entrantes: el PDF que mandamos NOSOTROS no es un comprobante.
    document: inbound ? parseDocument(message) : null,
    declaredMediaMimeType: declaredMediaMime(kapso),
  };
}

/** ¿El nombre del evento es uno de los tres de ciclo de vida? */
export function isLifecycleEventName(eventName: string | null): boolean {
  return eventName !== null && (KAPSO_LIFECYCLE_EVENTS as readonly string[]).includes(eventName);
}

/**
 * Clasifica un evento de Kapso por procedencia.
 *
 * Solo devuelve `human_outbound` cuando se cumplen EXACTAMENTE las tres
 * condiciones del contrato:
 *
 *     event  === 'whatsapp.message.sent'
 *     kapso.direction === 'outbound'
 *     kapso.origin    === 'business_app'
 *
 * `delivered` / `read` / `failed` nunca lo son, aunque lleven `business_app`:
 * describen el mismo wamid que ya llegó en `sent`. Y en Coexistence esos
 * callbacks pueden no llegar nunca, así que esperar a `delivered` para pausar
 * dejaría al agente hablando por encima de una persona.
 */
export function parseKapsoProvenance(
  eventName: string | null,
  payload: unknown,
): KapsoProvenance {
  const root = rec(payload);
  if (!root) return { kind: 'unknown' };

  const message = rec(root.message);
  const conversation = rec(root.conversation);
  const kapso = rec(message?.kapso);

  // Ciclo de vida: se resuelve ANTES que nada para que ni un `business_app`
  // tardío pueda confundirse con un mensaje humano nuevo.
  if (isLifecycleEventName(eventName)) {
    return {
      kind: 'lifecycle',
      providerMessageId: str(message?.id) ?? str(root.message_id),
      status: str(kapso?.status),
      origin: str(kapso?.origin),
    };
  }

  if (!message) return { kind: 'unknown' };

  if (eventName === KAPSO_EVENT_RECEIVED) {
    return {
      kind: 'customer_inbound',
      message: buildMessage(root, message, kapso, conversation, true),
    };
  }

  if (eventName === KAPSO_EVENT_SENT) {
    const direction = str(kapso?.direction);
    const origin = str(kapso?.origin);
    const built = buildMessage(root, message, kapso, conversation, false);

    if (direction === 'outbound' && origin === KAPSO_ORIGIN_BUSINESS_APP) {
      return { kind: 'human_outbound', message: built };
    }
    // cloud_api (y cualquier otro origen conocido) = envío nuestro: sigue por
    // la reconciliación de notificaciones existente, sin tocar el agente.
    return { kind: 'system_outbound', message: built };
  }

  return { kind: 'unknown' };
}
