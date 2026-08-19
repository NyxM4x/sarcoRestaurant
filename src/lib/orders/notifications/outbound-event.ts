import { normalizePhone } from '@/lib/phone';
import { extractOrderNumber, parseKapsoTimestamp } from '@/lib/kapso/message-history';
import { classifyOutboundType, type OutboundMessageType } from '@/lib/kapso/outbound-classify';

/**
 * Parser puro de los eventos SALIENTES de Kapso (Fase 5.2D.5A).
 *
 * Kapso confirma cuatro eventos outbound. Son la señal PRINCIPAL de que un
 * mensaje salió (incluso si nuestra llamada HTTP expiró); `GET /messages` queda
 * como respaldo.
 *
 * Este módulo solo interpreta el payload: no toca el webhook actual ni Supabase.
 */

export const OUTBOUND_EVENT_NAMES = [
  'whatsapp.message.sent',
  'whatsapp.message.delivered',
  'whatsapp.message.read',
  'whatsapp.message.failed',
] as const;

export type OutboundEventName = (typeof OUTBOUND_EVENT_NAMES)[number];
export type OutboundEventStatus = 'sent' | 'delivered' | 'read' | 'failed';

export interface OutboundEvent {
  externalMessageId: string;
  phoneNumberId: string | null;
  recipient: string | null;
  conversationId: string | null;
  eventStatus: OutboundEventStatus;
  messageType: OutboundMessageType;
  orderNumber: string | null;
  /** Código del proveedor ya saneado, o `null`. Nunca un mensaje libre. */
  providerErrorCode: string | null;
  /** ISO 8601 normalizado, o `null` si no era interpretable. */
  timestamp: string | null;
  /** Epoch en milisegundos, o `null`. */
  timestampMs: number | null;
}

export type ParseOutboundEventResult =
  | { ok: true; event: OutboundEvent }
  | { ok: false; reason: 'unsupported_event' | 'invalid_shape' };

/** Mismo charset que `order_notifications.last_error_code` (migración 0004). */
const SAFE_CODE_RE = /^[A-Za-z0-9._:-]{1,64}$/;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

export function isOutboundEventName(name: string | null): name is OutboundEventName {
  return name !== null && (OUTBOUND_EVENT_NAMES as readonly string[]).includes(name);
}

function statusFromEventName(name: OutboundEventName): OutboundEventStatus {
  return name.slice('whatsapp.message.'.length) as OutboundEventStatus;
}

/**
 * Saneado del código de error del proveedor: solo se conserva si encaja en el
 * charset corto permitido. Un mensaje técnico largo se descarta por completo.
 */
export function sanitizeProviderErrorCode(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  const raw = str(value);
  if (!raw) return null;
  const trimmed = raw.trim();
  return SAFE_CODE_RE.test(trimmed) ? trimmed : null;
}

/** Busca el objeto del mensaje sin asumir una única envoltura. */
function findMessage(payload: unknown): Record<string, unknown> | null {
  const root = record(payload);
  if (!root) return null;
  return (
    record(root.message) ??
    record(record(root.data)?.message) ??
    record(root.data) ??
    root
  );
}

/**
 * Interpreta un evento saliente. Devuelve `unsupported_event` para cualquier
 * nombre que no sea de los cuatro salientes, e `invalid_shape` si falta el id.
 */
export function parseOutboundEvent(
  eventName: string | null,
  payload: unknown,
): ParseOutboundEventResult {
  if (!isOutboundEventName(eventName)) return { ok: false, reason: 'unsupported_event' };

  const root = record(payload);
  const msg = findMessage(payload);
  if (!msg) return { ok: false, reason: 'invalid_shape' };

  const externalMessageId = str(msg.id) ?? str(msg.message_id) ?? str(root?.message_id);
  if (!externalMessageId) return { ok: false, reason: 'invalid_shape' };

  const kapso = record(msg.kapso);
  const interactive = record(msg.interactive);
  const text = record(msg.text);
  const image = record(msg.image);
  const typeData = record(kapso?.message_type_data);

  // Incluye la caption de la imagen (QR): mismo cuerpo que mira el historial.
  const bodyText =
    str(text?.body) ??
    str(record(interactive?.body)?.text) ??
    str(image?.caption) ??
    str(kapso?.content);

  const interactiveType = str(interactive?.type) ?? str(typeData?.interactive_type);
  const orderNumber = extractOrderNumber(bodyText);

  // 6D.2C: MISMA clasificación determinista que el historial (paridad).
  const messageType: OutboundMessageType = classifyOutboundType({
    messageKind: str(msg.type),
    interactiveType,
    bodyText,
    orderNumber,
  });

  const errorSource = record(msg.error) ?? record(root?.error);
  const errorsArray = Array.isArray(msg.errors) ? record(msg.errors[0]) : null;

  // Mismo criterio que el historial: Unix (s o ms) o ISO; nunca "ahora".
  const timestampMs = parseKapsoTimestamp(
    msg.timestamp ?? root?.timestamp ?? msg.created_at,
  );

  return {
    ok: true,
    event: {
      externalMessageId,
      phoneNumberId:
        str(root?.phone_number_id) ??
        str(msg.phone_number_id) ??
        str(record(root?.metadata)?.phone_number_id),
      recipient: normalizePhone(str(msg.to) ?? str(root?.to) ?? '') || null,
      conversationId:
        str(kapso?.whatsapp_conversation_id) ??
        str(msg.conversation_id) ??
        str(root?.conversation_id),
      eventStatus: statusFromEventName(eventName),
      messageType,
      orderNumber,
      providerErrorCode:
        sanitizeProviderErrorCode(errorSource?.code) ??
        sanitizeProviderErrorCode(errorsArray?.code),
      timestamp: timestampMs === null ? null : new Date(timestampMs).toISOString(),
      timestampMs,
    },
  };
}
