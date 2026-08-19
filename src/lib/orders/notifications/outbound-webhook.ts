import { parseOutboundEvent, type OutboundEvent } from './outbound-event';
import { classifySendFailure } from './retry-policy';
import type { NotificationStatesResult, NotificationStateRow } from './retry-plan';
import type { NotificationType } from './web-notify';

/**
 * Procesamiento PURO de los eventos SALIENTES de Kapso (Fase 5.2D.5C).
 *
 * Estos eventos son la señal principal de que un mensaje salió (incluso si
 * nuestra llamada HTTP expiró). Aquí NUNCA se envía nada: solo se persiste con
 * las RPC de 0005, a través de un store inyectado.
 *
 * Autoridad de resolución (§3): el pedido se localiza SOLO por el `order_number`
 * incrustado en el texto del mensaje, y se exige que el destinatario coincida
 * con `customer_phone`. Nunca se confía en un `order_id` del payload, ni en el
 * teléfono por sí solo, ni en una coincidencia parcial.
 */

/** Resultado saneado de `mark_notification_sent_by_webhook`. */
export type WebhookSentResult =
  | 'sent'
  | 'already_sent'
  | 'conflict'
  | 'not_found'
  | 'terminal'
  | 'manual_review_required'
  | 'duplicate_message_id'
  | 'invalid_state'
  | 'unknown';

/** Pedido resuelto de forma inequívoca por su número. */
export interface ResolvedOrder {
  id: string;
  /** Teléfono del pedido, ya normalizado a dígitos. */
  customerPhoneDigits: string;
}

/**
 * Acceso a datos para el procesamiento outbound. La implementación real usa
 * Supabase (service_role); en pruebas se inyecta. Ninguna operación envía.
 */
export interface OutboundReconciliationStore {
  /** Localiza el pedido por su número (UNIQUE). `null` si no existe. */
  resolveOrder(orderNumber: string): Promise<ResolvedOrder | null>;
  /** `mark_notification_sent_by_webhook` (sin claim): cierra como enviada. */
  markSentByWebhook(
    orderId: string,
    notificationType: NotificationType,
    externalMessageId: string,
  ): Promise<WebhookSentResult>;
  /** Estado actual de las notificaciones del pedido (sin datos sensibles). */
  loadStates(orderId: string): Promise<NotificationStatesResult>;
  /**
   * `mark_notification_terminal` para una fila NO reclamada (claim_token NULL).
   * Devuelve `false` si la fila está reclamada, ya enviada o no existe.
   */
  markTerminalByType(
    orderId: string,
    notificationType: NotificationType,
    errorCode: string,
    httpStatus: number | null,
    manualReview: boolean,
  ): Promise<boolean>;
}

/** Motivo saneado por el que un evento outbound no produjo cambios. */
export type OutboundIgnoreReason =
  | 'unsupported_event'
  | 'invalid_shape'
  | 'no_order_number'
  | 'unresolved_type'
  | 'order_not_found'
  | 'recipient_mismatch'
  | 'type_not_initialized';

/** Resultado global saneado del procesamiento de un evento outbound. */
export type OutboundOutcome =
  | 'sent'
  | 'already_sent'
  | 'conflict'
  | 'terminal'
  | 'recorded_failure'
  | 'manual_review_required'
  | 'not_found'
  | 'ignored';

export interface OutboundProcessResult {
  ok: boolean;
  handled: 'outbound';
  event: OutboundEvent['eventStatus'] | null;
  outcome: OutboundOutcome;
  /** Presente solo cuando `outcome = 'ignored'`. Nunca lleva datos sensibles. */
  reason?: OutboundIgnoreReason;
}

function ignored(
  event: OutboundEvent['eventStatus'] | null,
  reason: OutboundIgnoreReason,
): OutboundProcessResult {
  // Un evento que no podemos atribuir con certeza se ignora de forma SEGURA:
  // 200 (processed), sin tocar notificaciones y sin reintento.
  return { ok: true, handled: 'outbound', event, outcome: 'ignored', reason };
}

/** El tipo de mensaje saliente debe mapear a un tipo de notificación conocido. */
function notificationTypeOf(event: OutboundEvent): NotificationType | null {
  if (event.messageType === 'order_received') return 'order_received';
  if (event.messageType === 'confirmation') return 'confirmation';
  if (event.messageType === 'location_request') return 'location_request';
  return null;
}

function findRow(
  states: NotificationStatesResult,
  type: NotificationType,
): NotificationStateRow | null {
  return states.rows.find((r) => r.notificationType === type) ?? null;
}

/** Traduce el resultado de la RPC de webhook a un outcome global. */
function outcomeFromSent(result: WebhookSentResult): OutboundOutcome {
  switch (result) {
    case 'sent':
      return 'sent';
    case 'already_sent':
      return 'already_sent';
    case 'conflict':
      return 'conflict';
    case 'manual_review_required':
      return 'manual_review_required';
    case 'terminal':
      return 'terminal';
    case 'not_found':
      return 'not_found';
    // duplicate_message_id / invalid_state / unknown: no se degrada nada; se
    // registra como no concluyente para revisión.
    default:
      return 'manual_review_required';
  }
}

/**
 * Procesa un evento outbound ya validado por el webhook (HMAC, versión,
 * idempotencia). No lanza salvo por fallos REALES de infraestructura del store
 * (que el webhook convierte en `failed` reintentable).
 */
export async function processOutboundEvent(
  parsed: ReturnType<typeof parseOutboundEvent>,
  store: OutboundReconciliationStore,
): Promise<OutboundProcessResult> {
  if (!parsed.ok) {
    // unsupported_event no debería llegar (el webhook filtra por nombre), pero
    // se trata igual que una forma inválida: ignorar con seguridad.
    return ignored(null, parsed.reason);
  }

  const event = parsed.event;

  // §3 — Resolución inequívoca del pedido y del tipo.
  if (event.orderNumber === null) return ignored(event.eventStatus, 'no_order_number');

  const type = notificationTypeOf(event);
  if (type === null) return ignored(event.eventStatus, 'unresolved_type');

  const order = await store.resolveOrder(event.orderNumber);
  if (order === null) return ignored(event.eventStatus, 'order_not_found');

  // El destinatario del saliente debe coincidir con el teléfono del pedido. Un
  // teléfono por sí solo nunca es autoridad: se exige además el order_number.
  if (event.recipient === null || event.recipient !== order.customerPhoneDigits) {
    return ignored(event.eventStatus, 'recipient_mismatch');
  }

  // sent / delivered / read: los tres confirman que el mensaje salió.
  if (event.eventStatus !== 'failed') {
    const result = await store.markSentByWebhook(order.id, type, event.externalMessageId);
    return {
      ok: true,
      handled: 'outbound',
      event: event.eventStatus,
      outcome: outcomeFromSent(result),
    };
  }

  // §5 — Evento failed. NUNCA se asume que el mensaje no salió antes, ni se
  // envía nada. Se lee el estado actual y se clasifica el código del proveedor.
  const states = await store.loadStates(order.id);
  const row = findRow(states, type);
  if (row === null) return ignored(event.eventStatus, 'type_not_initialized');

  // Una fila ya enviada NUNCA se degrada: el failed es evidencia tardía.
  if (row.status === 'sent') {
    return { ok: true, handled: 'outbound', event: 'failed', outcome: 'already_sent' };
  }
  // Cierres explícitos: no se reabren ni se modifican automáticamente.
  if (row.terminalAt !== null || row.manualReviewRequired) {
    return { ok: true, handled: 'outbound', event: 'failed', outcome: 'manual_review_required' };
  }

  // Solo un error CONFIRMADO como permanente autoriza cerrar desde el webhook.
  // El resto (retryable, ambiguo o desconocido) se deja para la reconciliación
  // o el futuro worker: aquí no hay claim, así que no se puede mover a un estado
  // recuperable sin arriesgar sobrescribir un envío en curso.
  if (classifySendFailure(event.providerErrorCode ?? '') === 'permanent') {
    const closed = await store.markTerminalByType(
      order.id,
      type,
      event.providerErrorCode ?? 'provider_failed',
      null,
      false,
    );
    // Si la fila estaba reclamada (sending en curso), la RPC devuelve false y
    // se respeta: el camino de respuesta del envío la resolverá.
    return {
      ok: true,
      handled: 'outbound',
      event: 'failed',
      outcome: closed ? 'terminal' : 'recorded_failure',
    };
  }

  // Fallo ambiguo/incompleto: se registra sin mutar estado. La fila seguirá su
  // curso normal (recuperación de 'sending' → reconciliación).
  return { ok: true, handled: 'outbound', event: 'failed', outcome: 'recorded_failure' };
}
