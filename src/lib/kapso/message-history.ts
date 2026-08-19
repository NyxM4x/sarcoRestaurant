import { z } from 'zod';
import { normalizePhone } from '@/lib/phone';
import { classifyOutboundType, type OutboundMessageType } from './outbound-classify';

/**
 * Lectura del historial de mensajes de Kapso — módulo puro (sin `server-only`).
 *
 * SOLO hace `GET /meta/whatsapp/v24.0/{phone_number_id}/messages`. Existe para
 * reconciliar envíos ambiguos (timeout / respuesta perdida) antes de reintentar
 * y arriesgar un duplicado.
 *
 * Nunca registra nada: ni API key, ni teléfono, ni contenido. La ausencia total
 * de logs es la garantía más simple de que no se filtra nada.
 */

/** Campos que se piden explícitamente a Kapso. */
export const OUTBOUND_FIELDS =
  'kapso(direction,status,processing_status,content,message_type_data,whatsapp_conversation_id)';

/** Ventana por defecto para reconciliar (ver §6). */
export const DEFAULT_HISTORY_TIMEOUT_MS = 10_000;

export type MessageHistoryError =
  | 'http_error'
  | 'timeout'
  | 'network_error'
  | 'invalid_response'
  | 'invalid_query';

/** Mensaje crudo: solo se exige `id`; el resto lo normaliza el parser. */
export type RawOutboundMessage = { id: string } & Record<string, unknown>;

export type MessageHistoryResult =
  | { ok: true; messages: RawOutboundMessage[]; nextCursor: string | null }
  | { ok: false; error: MessageHistoryError; status?: number };

export interface MessageHistoryConfig {
  apiKey: string;
  /** phone_number_id por defecto (el del entorno). */
  phoneNumberId: string;
  /** Base de la API (misma que el transporte de envío). */
  baseUrl: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface ListOutboundQuery {
  /** ISO 8601. Obligatorio: acota la ventana y evita barridos completos. */
  since: string;
  until?: string;
  status?: string;
  conversationId?: string;
  limit?: number;
  after?: string;
  /** phone_number_id concreto; si se omite, el del config. */
  phoneNumberId?: string;
}

const rawMessageSchema = z.object({ id: z.string().min(1) }).catchall(z.unknown());

/**
 * Envoltorios aceptados. Kapso no documenta la forma exacta, así que se admiten
 * las tres habituales en vez de asumir una y romperse en producción.
 */
const envelopeSchema = z.union([
  z.object({ data: z.array(rawMessageSchema) }).catchall(z.unknown()),
  z.object({ messages: z.array(rawMessageSchema) }).catchall(z.unknown()),
  z.array(rawMessageSchema),
]);

function isIsoDate(value: string): boolean {
  if (typeof value !== 'string' || value.trim() === '') return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed);
}

/** Extrae el cursor de paginación sin asumir un único formato. */
export function extractNextCursor(body: unknown): string | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const root = body as Record<string, unknown>;

  const candidates: unknown[] = [root.next_cursor, root.after];

  const meta = root.meta;
  if (typeof meta === 'object' && meta !== null) {
    const m = meta as Record<string, unknown>;
    candidates.push(m.next_cursor, m.after, m.next);
  }

  const paging = root.paging;
  if (typeof paging === 'object' && paging !== null) {
    const p = paging as Record<string, unknown>;
    candidates.push(p.next, p.after);
    const cursors = p.cursors;
    if (typeof cursors === 'object' && cursors !== null) {
      candidates.push((cursors as Record<string, unknown>).after);
    }
  }

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate;
  }
  return null;
}

function messagesFrom(parsed: z.infer<typeof envelopeSchema>): RawOutboundMessage[] {
  if (Array.isArray(parsed)) return parsed as RawOutboundMessage[];
  if ('data' in parsed) return parsed.data as RawOutboundMessage[];
  return parsed.messages as RawOutboundMessage[];
}

export function createKapsoMessageHistory(cfg: MessageHistoryConfig) {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const defaultTimeoutMs = cfg.timeoutMs ?? DEFAULT_HISTORY_TIMEOUT_MS;

  return {
    /** Construye la URL exacta (expuesto para poder verificarla en tests). */
    buildUrl(query: ListOutboundQuery): string {
      const phoneNumberId = query.phoneNumberId || cfg.phoneNumberId;
      const params = new URLSearchParams();
      // `direction` es fijo: este módulo jamás lee entrantes.
      params.set('direction', 'outbound');
      params.set('since', query.since);
      if (query.until) params.set('until', query.until);
      if (query.status) params.set('status', query.status);
      if (query.conversationId) params.set('conversation_id', query.conversationId);
      params.set('limit', String(query.limit ?? 25));
      if (query.after) params.set('after', query.after);
      params.set('fields', OUTBOUND_FIELDS);

      return `${cfg.baseUrl}/${phoneNumberId}/messages?${params.toString()}`;
    },

    /**
     * Lista salientes en una ventana temporal. No lanza: devuelve errores
     * tipados, igual que el transporte de envío.
     */
    async listOutbound(query: ListOutboundQuery): Promise<MessageHistoryResult> {
      // Validación de la consulta ANTES de tocar la red.
      if (!isIsoDate(query.since)) return { ok: false, error: 'invalid_query' };
      if (query.until !== undefined && !isIsoDate(query.until)) {
        return { ok: false, error: 'invalid_query' };
      }
      if (query.until !== undefined && Date.parse(query.until) < Date.parse(query.since)) {
        return { ok: false, error: 'invalid_query' };
      }
      if (query.limit !== undefined) {
        if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 100) {
          return { ok: false, error: 'invalid_query' };
        }
      }
      const phoneNumberId = query.phoneNumberId || cfg.phoneNumberId;
      if (!phoneNumberId || phoneNumberId.trim() === '') {
        return { ok: false, error: 'invalid_query' };
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), defaultTimeoutMs);

      try {
        const res = await fetchImpl(this.buildUrl(query), {
          method: 'GET',
          headers: { 'x-api-key': cfg.apiKey },
          signal: controller.signal,
        });

        if (!res.ok) return { ok: false, error: 'http_error', status: res.status };

        let json: unknown;
        try {
          json = await res.json();
        } catch {
          return { ok: false, error: 'invalid_response' };
        }

        const parsed = envelopeSchema.safeParse(json);
        if (!parsed.success) return { ok: false, error: 'invalid_response' };

        return {
          ok: true,
          messages: messagesFrom(parsed.data),
          nextCursor: extractNextCursor(json),
        };
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          return { ok: false, error: 'timeout' };
        }
        return { ok: false, error: 'network_error' };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export type KapsoMessageHistory = ReturnType<typeof createKapsoMessageHistory>;

// ── Normalización de mensajes salientes ────────────────────────────────────

// El tipo y la clasificación viven en el módulo compartido (paridad con el
// webhook). Se re-exporta para no romper importadores existentes.
export type { OutboundMessageType } from './outbound-classify';

/**
 * Forma mínima con la que trabaja la reconciliación. NO debe registrarse
 * completa: `recipient` es un teléfono.
 */
export interface NormalizedOutboundMessage {
  externalMessageId: string;
  /** ISO 8601 normalizado, o `null` si el valor original no era interpretable. */
  timestamp: string | null;
  /** Epoch en milisegundos; es lo que compara el matcher. */
  timestampMs: number | null;
  recipient: string | null;
  direction: string | null;
  type: OutboundMessageType;
  orderNumber: string | null;
  status: string | null;
  conversationId: string | null;
}

/** Formato de `next_order_number()`: ORD- + al menos 6 dígitos. */
const ORDER_NUMBER_RE = /\bORD-\d{6,}\b/;

/**
 * Rango de validez razonable. Fuera de él, el valor se considera basura en vez
 * de una fecha: así un número enorme no se convierte en el año 50000.
 */
const MIN_VALID_MS = Date.UTC(2000, 0, 1);
const MAX_VALID_MS = Date.UTC(2100, 0, 1);

function inRange(ms: number): number | null {
  return ms >= MIN_VALID_MS && ms <= MAX_VALID_MS ? ms : null;
}

/** Unix por cantidad de dígitos: 10 = segundos, 13 = milisegundos. */
function fromNumeric(value: number): number | null {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) return null;
  const digits = String(value).length;
  if (digits === 10) return inRange(value * 1000);
  if (digits === 13) return inRange(value);
  return null;
}

/**
 * Normaliza un timestamp de Kapso a epoch en milisegundos.
 *
 * Kapso confirmó que `message.timestamp` puede llegar como Unix en SEGUNDOS
 * (p. ej. 1730092860), como número o como string. Depender solo de `Date.parse`
 * haría que un saliente perfectamente válido no coincidiera nunca, y el matcher
 * devolvería `not_found` → reintento → duplicado. De ahí la conversión estricta.
 *
 * Devuelve `null` ante cualquier valor dudoso: JAMÁS cae a la fecha actual.
 */
export function parseKapsoTimestamp(value: unknown): number | null {
  if (typeof value === 'number') return fromNumeric(value);
  if (typeof value !== 'string') return null;

  const trimmed = value.trim();
  if (trimmed === '') return null;

  // Solo dígitos: Unix. Se exige longitud 10 o 13 para no adivinar.
  if (/^\d+$/.test(trimmed)) return fromNumeric(Number(trimmed));

  // Resto: ISO 8601.
  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) return null;
  return inRange(parsed);
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** Extrae el primer ORD-XXXXXX como token exacto, o `null`. */
export function extractOrderNumber(text: string | null): string | null {
  if (!text) return null;
  return ORDER_NUMBER_RE.exec(text)?.[0] ?? null;
}

/**
 * Normaliza un mensaje saliente de Kapso sin confiar en campos opcionales.
 * Cualquier forma inesperada degrada a `type: 'unknown'` y campos `null`.
 */
export function normalizeOutboundMessage(raw: unknown): NormalizedOutboundMessage | null {
  const msg = record(raw);
  const id = str(msg?.id);
  if (!msg || !id) return null;

  const kapso = record(msg.kapso);
  const typeData = record(kapso?.message_type_data);
  const interactive = record(msg.interactive);
  const text = record(msg.text);
  const image = record(msg.image);
  // Caption de una imagen (6D.1: confirmación con QR). Puede venir en
  // `image.caption` o, según la forma de Kapso, en `kapso.content`.
  const imageCaption = str(image?.caption);

  // Texto del cuerpo, buscando en las ubicaciones posibles (incluida la caption).
  const bodyText =
    str(text?.body) ??
    str(record(interactive?.body)?.text) ??
    imageCaption ??
    str(kapso?.content);

  const interactiveType = str(interactive?.type) ?? str(typeData?.interactive_type);
  // El número de pedido es el token de emparejamiento; se extrae del cuerpo/caption.
  const orderNumber = extractOrderNumber(bodyText);

  // 6D.2C: clasificación DETERMINISTA compartida con el webhook. Distingue
  // order_received (texto de recepción) de confirmation (texto/imagen con montos
  // o «¡Recibí…» legacy), evitando la colisión "todo texto → confirmation".
  const type: OutboundMessageType = classifyOutboundType({
    messageKind: str(msg.type),
    interactiveType,
    bodyText,
    orderNumber,
  });

  // El timestamp puede llegar como Unix (segundos o ms) o como ISO.
  const timestampMs = parseKapsoTimestamp(msg.timestamp ?? msg.created_at);

  return {
    externalMessageId: id,
    timestamp: timestampMs === null ? null : new Date(timestampMs).toISOString(),
    timestampMs,
    recipient: normalizePhone(str(msg.to) ?? '') || null,
    direction: str(kapso?.direction) ?? str(msg.direction),
    type,
    orderNumber,
    status: str(kapso?.status) ?? str(msg.status),
    conversationId: str(kapso?.whatsapp_conversation_id) ?? str(msg.conversation_id),
  };
}
