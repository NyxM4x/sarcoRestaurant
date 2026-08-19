/**
 * Construcción del texto de alerta Telegram — módulo PURO (Fase 5.2D.5E.2).
 *
 * Solo produce texto SANITIZADO: número de pedido, tipo de notificación,
 * categoría del error y estado. NUNCA incluye teléfono, nombre, dirección,
 * coordenadas, wamid, external_message_id, claim_token, order_id, payloads ni SQL.
 */

export type AlertNotificationType = 'order_received' | 'confirmation' | 'location_request';
export type AlertReviewKind = 'manual_review' | 'terminal';

export interface AlertMessageInput {
  orderNumber: string;
  notificationType: AlertNotificationType | (string & {});
  /** Código de error corto y ya sanitizado (last_error_code). */
  reasonCode: string;
  reviewKind: AlertReviewKind | (string & {});
  /** Epoch ms del momento de construcción. */
  now: number;
}

/** Longitud máxima del texto final (defensa: Telegram admite 4096). */
export const MAX_ALERT_TEXT_LENGTH = 600;

const TYPE_LABEL: Record<string, string> = {
  order_received: 'Recepción de pedido',
  confirmation: 'Confirmación',
  location_request: 'Solicitud de ubicación',
};

const REVIEW_LABEL: Record<string, string> = {
  manual_review: 'Revisión manual',
  terminal: 'Cerrado (requiere revisión)',
};

/**
 * Traduce un código de error interno a una CATEGORÍA legible y sanitizada.
 * Cualquier código desconocido cae en una categoría genérica: nunca se filtra
 * el código crudo si no está en la tabla.
 */
const REASON_CATEGORY: Record<string, string> = {
  provider_failed: 'El proveedor reportó un envío fallido',
  reconciliation_attempts_exhausted: 'No se pudo reconciliar tras varios intentos',
  reconciliation_unresolved: 'Reconciliación no concluyente',
  reconciled_not_found: 'El mensaje no se encontró al reconciliar',
  stale_sending_unknown: 'Envío en estado desconocido',
  max_attempts_reached: 'Se agotaron los reintentos',
};

export function categorizeReason(reasonCode: string): string {
  const key = (reasonCode ?? '').trim();
  if (key in REASON_CATEGORY) return REASON_CATEGORY[key];
  // Códigos http_* u otros: categoría genérica, sin exponer el código crudo.
  return 'Requiere revisión manual';
}

/** Escapa los caracteres que Telegram (modo por defecto) podría malinterpretar. */
function sanitizeLine(value: string): string {
  return value
    .replace(/[\r\n]+/g, ' ')
    .replace(/[<>]/g, '')
    .trim();
}

/** Formatea la hora en es-BO (zona America/La_Paz) de forma estable. */
function formatTime(now: number): string {
  try {
    return new Intl.DateTimeFormat('es-BO', {
      timeZone: 'America/La_Paz',
      dateStyle: 'short',
      timeStyle: 'short',
    }).format(new Date(now));
  } catch {
    return new Date(now).toISOString();
  }
}

/**
 * Construye el texto de la alerta. Recorta a `MAX_ALERT_TEXT_LENGTH`. El
 * `orderNumber` se sanea; si viniera vacío se usa un marcador neutro.
 */
export function buildAlertMessage(input: AlertMessageInput): string {
  const order = sanitizeLine(input.orderNumber) || '(sin número)';
  const typeLabel = TYPE_LABEL[input.notificationType] ?? 'Notificación';
  const reviewLabel = REVIEW_LABEL[input.reviewKind] ?? 'Revisión manual';
  const reason = sanitizeLine(categorizeReason(input.reasonCode));
  const when = formatTime(input.now);

  const text = [
    '⚠️ Revisión requerida',
    '',
    `Pedido: ${order}`,
    `Tipo: ${typeLabel}`,
    `Motivo: ${reason}`,
    `Estado: ${reviewLabel}`,
    `Hora: ${when}`,
    '',
    'Acción: revisar el pedido en el sistema.',
  ].join('\n');

  return text.length > MAX_ALERT_TEXT_LENGTH ? text.slice(0, MAX_ALERT_TEXT_LENGTH) : text;
}
