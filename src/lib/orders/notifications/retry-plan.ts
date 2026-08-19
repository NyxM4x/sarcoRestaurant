/**
 * Plan de reintento MANUAL de notificaciones (Fase 5.2D.5B.2) — módulo puro.
 *
 * Decide, a partir del estado persistido de las filas de `order_notifications`,
 * qué acción es segura para un reintento explícito de una persona autorizada.
 * No hace E/S, no envía nada y no toca Supabase.
 *
 * Principio: el reintento manual NUNCA puede provocar un duplicado. Solo dos
 * estados autorizan un envío —`pending` y `failed` NO ambiguo ya programable—;
 * todo lo demás se rechaza con un motivo explícito.
 *
 * Tampoco puede reactivar pedidos históricos: este plan opera exclusivamente
 * sobre filas que YA existen, nunca inicializa.
 */

import { isAmbiguousError, type RecoveryStatus } from './recovery-state';
import { classifyHttpStatus, classifySendFailure } from './retry-policy';
import type { NotificationType } from './web-notify';

/** Estado mínimo de una fila para planificar. Sin datos sensibles. */
export interface NotificationStateRow {
  notificationType: NotificationType;
  status: RecoveryStatus;
  attemptCount: number;
  maxAttempts: number;
  nextAttemptAt: string | null;
  terminalAt: string | null;
  manualReviewRequired: boolean;
  lastErrorCode: string | null;
  lastHttpStatus: number | null;
}

/**
 * Resultado de leer las filas de un pedido. Distingue "no hay filas" de "hay
 * filas que no sabemos interpretar": lo segundo NUNCA debe parecer un pedido
 * inexistente ni autorizar un envío.
 */
export interface NotificationStatesResult {
  rows: NotificationStateRow[];
  /** Filas existentes cuyo `status` no pertenece al dominio conocido. */
  unknownStateCount: number;
}

/** Clasificación de un `failed` a efectos del reintento MANUAL. */
export type FailedDisposition =
  /** Pudo entregarse: reconciliar antes de nada. */
  | 'reconcile'
  /** Con certeza no se entregó y reintentar tiene sentido. */
  | 'retryable'
  /** No se entregó y reintentar no ayuda: corregir datos o código. */
  | 'permanent'
  /** No hay información suficiente para decidir. */
  | 'manual_review';

/** ¿El código corresponde a una respuesta HTTP del proveedor? */
function isHttpErrorCode(code: string): boolean {
  return code === 'http_error' || code.startsWith('http_');
}

/**
 * Extrae el status HTTP con certeza: primero la columna persistida y, si falta,
 * un código con la forma `http_<3 dígitos>`. Devuelve `null` cuando no puede
 * determinarse — y entonces NO se adivina.
 */
function resolveHttpStatus(code: string, lastHttpStatus: number | null): number | null {
  if (typeof lastHttpStatus === 'number' && Number.isInteger(lastHttpStatus)) {
    if (lastHttpStatus >= 100 && lastHttpStatus <= 599) return lastHttpStatus;
  }
  const match = /^http_(\d{3})$/.exec(code);
  if (match) {
    const parsed = Number(match[1]);
    if (parsed >= 100 && parsed <= 599) return parsed;
  }
  return null;
}

/**
 * Clasifica una fila `failed` para decidir si un reintento MANUAL puede
 * programar un envío.
 *
 * Orden deliberado:
 *  1. HTTP — si no hay status con certeza, se trata como AMBIGUO. Nunca se
 *     asume 4xx ni 5xx a partir de un `http_error` pelado.
 *  2. Ambiguos de 0005 (timeout, network_error, invalid_response,
 *     persistence_error, stale_sending_unknown) -> reconciliar.
 *  3. Resto: `classifySendFailure` distingue permanente, retryable y
 *     revisión manual.
 *  4. Código ausente o vacío -> revisión manual, nunca retryable.
 */
export function classifyFailedRow(row: NotificationStateRow): FailedDisposition {
  const code = (row.lastErrorCode ?? '').trim();
  if (code === '') return 'manual_review';

  if (isHttpErrorCode(code)) {
    const status = resolveHttpStatus(code, row.lastHttpStatus);
    // Sin certeza sobre el status: ambiguo. La petición salió a la red.
    if (status === null) return 'reconcile';

    switch (classifyHttpStatus(status)) {
      case 'pending_reconciliation':
        return 'reconcile';
      case 'retryable':
      case 'retryable_after_reconciliation_or_backoff':
        return 'retryable';
      case 'permanent':
        return 'permanent';
      default:
        return 'manual_review';
    }
  }

  // Ambiguos de 0005: el mensaje pudo entregarse.
  if (isAmbiguousError(code)) return 'reconcile';

  switch (classifySendFailure(code)) {
    case 'permanent':
      return 'permanent';
    case 'retryable':
      return 'retryable';
    case 'pending_reconciliation':
    case 'retryable_after_reconciliation_or_backoff':
      return 'reconcile';
    default:
      // Desconocido o incompleto: nunca se asume retryable.
      return 'manual_review';
  }
}

/** Acción segura para una fila concreta. */
export type RetryAction =
  /** Reclamar y enviar directamente (fila `pending`). */
  | 'dispatch'
  /** Programar el envío con `schedule_notification_send` y luego despachar. */
  | 'schedule_then_dispatch'
  /** No hacer nada: se informa el motivo. */
  | 'reject';

/** Motivo sanitizado por el que no se reintenta. Nunca expone datos internos. */
export type RetryRejectionReason =
  | 'already_sent'
  | 'in_flight'
  | 'requires_reconciliation'
  | 'reconciliation_in_progress'
  | 'terminal'
  | 'manual_review_required'
  | 'max_attempts_reached'
  /** Fallo sin ambigüedad de entrega que reintentar no arregla. */
  | 'permanent_failure'
  | 'not_found'
  /** Existe la fila pero su `status` no pertenece al dominio conocido. */
  | 'unknown_state'
  | 'unknown';

export interface RetryPlan {
  action: RetryAction;
  /** Presente solo cuando `action = 'reject'`. */
  reason?: RetryRejectionReason;
}

function reject(reason: RetryRejectionReason): RetryPlan {
  return { action: 'reject', reason };
}

/**
 * Planifica el reintento de UNA fila.
 *
 * Tabla de decisión (ninguna otra rama envía):
 *   sent                    -> reject already_sent
 *   sending                 -> reject in_flight   (stale incluido: no se
 *                              recupera aquí, y jamás se reenvía)
 *   pending_reconciliation  -> reject requires_reconciliation
 *   reconciling             -> reject reconciliation_in_progress
 *   failed AMBIGUO          -> reject requires_reconciliation
 *   failed no ambiguo       -> schedule_then_dispatch (o dispatch si ya está
 *                              programado y vencido)
 *   pending                 -> dispatch
 */
export function planNotificationRetry(
  row: NotificationStateRow | null,
  now: number,
): RetryPlan {
  if (row === null) return reject('not_found');

  // Cierres explícitos: exigen decisión humana, por delante de todo lo demás.
  if (row.terminalAt !== null) return reject('terminal');
  if (row.manualReviewRequired) return reject('manual_review_required');

  switch (row.status) {
    case 'sent':
      return reject('already_sent');

    // Un 'sending' nunca se reenvía, ni siquiera vencido (invariante I3 de
    // 0005). Su recuperación es competencia de la RPC dedicada, que además no
    // envía nada de inmediato: aquí solo se informa.
    case 'sending':
      return reject('in_flight');

    case 'pending_reconciliation':
      return reject('requires_reconciliation');

    case 'reconciling':
      return reject('reconciliation_in_progress');

    case 'pending':
      if (row.attemptCount >= row.maxAttempts) return reject('max_attempts_reached');
      return { action: 'dispatch' };

    case 'failed': {
      // SOLO un fallo clasificado como retryable con certeza puede programar un
      // envío manual. Un `failed` NO ambiguo no es, por sí solo, reintentable:
      // los más comunes (invalid_phone/text/body_text) son permanentes.
      const disposition = classifyFailedRow(row);

      if (disposition === 'reconcile') return reject('requires_reconciliation');
      if (disposition === 'permanent') return reject('permanent_failure');
      if (disposition === 'manual_review') return reject('manual_review_required');

      if (row.attemptCount >= row.maxAttempts) return reject('max_attempts_reached');

      // Si ya tiene programación vencida, el claim la aceptará tal cual.
      const scheduled = row.nextAttemptAt !== null ? Date.parse(row.nextAttemptAt) : null;
      const isDue = scheduled !== null && Number.isFinite(scheduled) && scheduled <= now;
      return { action: isDue ? 'dispatch' : 'schedule_then_dispatch' };
    }

    default:
      // Estado que este código no conoce: nunca se envía.
      return reject('unknown');
  }
}

/**
 * Planifica el reintento de un pedido completo a partir de sus filas.
 *
 * La confirmación manda: si no puede enviarse ni está ya enviada, la solicitud
 * de ubicación queda bloqueada (misma dependencia que impone 0005 DB-side).
 */
export interface OrderRetryPlan {
  /** 6D.2C: `null` salvo en delivery dinámico (mensaje de recepción). */
  orderReceived: RetryPlan | null;
  confirmation: RetryPlan;
  /** `null` cuando el pedido no tiene fila de ubicación (pickup). */
  locationRequest: RetryPlan | null;
  /** `true` si alguna fila autoriza un envío. */
  willDispatch: boolean;
  /** Tipos que necesitan `schedule_notification_send` antes del dispatch. */
  toSchedule: NotificationType[];
}

export function planOrderRetry(
  states: NotificationStatesResult | NotificationStateRow[],
  now: number,
): OrderRetryPlan {
  const result: NotificationStatesResult = Array.isArray(states)
    ? { rows: states, unknownStateCount: 0 }
    : states;

  // Si alguna fila tiene un status que no sabemos interpretar, no se envía ni
  // se programa NADA: el cuadro completo del pedido es incierto.
  if (result.unknownStateCount > 0) {
    const rejected = reject('unknown_state');
    return {
      orderReceived: null,
      confirmation: rejected,
      locationRequest: null,
      willDispatch: false,
      toSchedule: [],
    };
  }

  const rows = result.rows;
  const orderReceivedRow = rows.find((r) => r.notificationType === 'order_received') ?? null;
  const confirmationRow = rows.find((r) => r.notificationType === 'confirmation') ?? null;
  const locationRow = rows.find((r) => r.notificationType === 'location_request') ?? null;

  const orderReceived = orderReceivedRow === null ? null : planNotificationRetry(orderReceivedRow, now);
  const confirmation = planNotificationRetry(confirmationRow, now);
  const locationRequest = locationRow === null ? null : planNotificationRetry(locationRow, now);

  // Orden de programación: recepción → confirmación → ubicación.
  const toSchedule: NotificationType[] = [];
  if (orderReceived?.action === 'schedule_then_dispatch') toSchedule.push('order_received');
  if (confirmation.action === 'schedule_then_dispatch') toSchedule.push('confirmation');
  if (locationRequest?.action === 'schedule_then_dispatch') toSchedule.push('location_request');

  const dispatches = (plan: RetryPlan | null): boolean =>
    plan?.action === 'dispatch' || plan?.action === 'schedule_then_dispatch';

  return {
    orderReceived,
    confirmation,
    locationRequest,
    willDispatch: dispatches(orderReceived) || dispatches(confirmation) || dispatches(locationRequest),
    toSchedule,
  };
}
