/**
 * Modelo puro de la máquina de estados de recuperación de notificaciones
 * (Fase 5.2D.5B.1). Espeja las reglas de `0005_order_notification_recovery.sql`.
 *
 * NO está conectado al servicio de producción: solo define estados,
 * transiciones y elegibilidad para que el futuro worker las respete. No hace
 * E/S, no toca Supabase y no envía nada.
 *
 * TRES INVARIANTES ANTI-DUPLICACIÓN:
 *  I1. Una fila solo es trabajo si tiene una fecha EXPLÍCITA y vencida. Las
 *      filas históricas (fechas null) jamás son elegibles.
 *  I2. Un fallo AMBIGUO (el mensaje pudo entregarse) nunca vuelve a la cola de
 *      envío: solo avanza reconciliándose.
 *  I3. Un 'sending' NUNCA se reenvía, ni siquiera vencido: se recupera a
 *      'pending_reconciliation' y debe reconciliarse.
 */

/** Estados persistidos en `order_notifications.status`. */
export type RecoveryStatus =
  | 'pending'
  | 'sending'
  | 'pending_reconciliation'
  | 'reconciling'
  | 'sent'
  | 'failed';

export const RECOVERY_STATUSES: readonly RecoveryStatus[] = [
  'pending',
  'sending',
  'pending_reconciliation',
  'reconciling',
  'sent',
  'failed',
] as const;

export type NotificationType = 'order_received' | 'confirmation' | 'location_request';

/** Origen de la certeza al cerrar como enviada. */
export type ReconciliationSource = 'webhook' | 'history' | 'send_response' | 'manual';

export const RECONCILIATION_SOURCES: readonly ReconciliationSource[] = [
  'webhook',
  'history',
  'send_response',
  'manual',
] as const;

/** Techo por defecto de intentos (coincide con el default de la columna). */
export const DEFAULT_MAX_ATTEMPTS = 5;

/**
 * Suelo de la ventana stale, en segundos. Debe superar con holgura el timeout
 * de envío de notificaciones (20 s) para no tocar algo que aún corre.
 */
export const MIN_STALE_SECONDS = 120;

/** Código que queda en una fila recuperada desde un 'sending' abandonado. */
export const STALE_SENDING_ERROR_CODE = 'stale_sending_unknown';

/**
 * Códigos AMBIGUOS: el mensaje pudo haberse entregado pese al fallo. Espeja
 * `public.is_ambiguous_notification_error`. Cualquier `http_*` también lo es
 * porque la petición llegó a salir a la red.
 *
 * NO ambiguos: invalid_phone, invalid_text, invalid_body_text — el transport
 * los devuelve sin llegar a llamar a fetch.
 */
export const AMBIGUOUS_ERROR_CODES: readonly string[] = [
  'timeout',
  'network_error',
  'invalid_response',
  'http_error',
  'persistence_error',
  STALE_SENDING_ERROR_CODE,
] as const;

export function isAmbiguousError(code: string | null): boolean {
  if (code === null) return false;
  const trimmed = code.trim();
  if (trimmed === '') return false;
  return AMBIGUOUS_ERROR_CODES.includes(trimmed) || trimmed.startsWith('http_');
}

/**
 * Resultados posibles de una reconciliación. SOLO `not_found` prueba que el
 * mensaje no se envió y por tanto autoriza un reenvío.
 */
export type ReconciliationOutcome =
  | 'not_found'
  | 'ambiguous'
  | 'multiple_matches'
  | 'provider_failed'
  | 'history_error'
  | 'history_timeout'
  | 'invalid_response'
  | 'webhook_pending';

/** Único resultado que autoriza programar un reenvío tras reconciliar. */
export const RETRY_AUTHORIZING_OUTCOME: ReconciliationOutcome = 'not_found';

/**
 * ¿Este resultado de reconciliación autoriza programar un reenvío? Cualquier
 * cosa distinta de `not_found` —incluido un código desconocido— NO.
 */
export function canScheduleRetryAfterReconciliation(outcome: string | null): boolean {
  return outcome === RETRY_AUTHORIZING_OUTCOME;
}

/** Vista mínima de una fila para decidir recuperación. Sin datos sensibles. */
export interface NotificationRecoveryRow {
  notificationType: NotificationType;
  status: RecoveryStatus;
  attemptCount: number;
  reconciliationAttemptCount: number;
  maxAttempts: number;
  /** Reintento de ENVÍO programado. `null` = sin trabajo (fila histórica). */
  nextAttemptAt: string | null;
  /** RECONCILIACIÓN programada. `null` = sin trabajo (fila histórica). */
  reconciliationDueAt: string | null;
  /** Cuándo se reclamó (para detectar 'sending'/'reconciling' abandonados). */
  claimedAt: string | null;
  /** Cierre definitivo: nunca vuelve a ser trabajo automático. */
  terminalAt: string | null;
  manualReviewRequired: boolean;
  lastErrorCode: string | null;
  lastHttpStatus: number | null;
}

/**
 * Transiciones permitidas. Cada arista corresponde a exactamente una RPC de
 * 0004/0005; no existe otra vía legítima de cambio de estado.
 */
export const ALLOWED_TRANSITIONS: Readonly<Record<RecoveryStatus, readonly RecoveryStatus[]>> = {
  // claim_order_notification
  pending: ['sending'],
  // mark_*_sent | mark_order_notification_failed (clasifica) |
  // recover_stale_sending_notification | schedule_notification_retry |
  // mark_notification_terminal | mark_notification_sent_by_webhook
  // NOTA: 'sending' -> 'sending' NO existe. I3.
  sending: ['sent', 'pending_reconciliation', 'failed'],
  // claim_notification_reconciliation | mark_notification_sent_by_webhook |
  // mark_notification_terminal
  pending_reconciliation: ['reconciling', 'sent', 'failed'],
  // mark_reconciliation_sent | mark_notification_sent_by_webhook |
  // reschedule_notification_reconciliation |
  // schedule_notification_retry (SOLO con outcome 'not_found') |
  // mark_notification_terminal
  reconciling: ['sent', 'pending_reconciliation', 'failed'],
  // Estado final: una notificación enviada nunca se degrada.
  sent: [],
  // claim_order_notification (solo NO ambiguo y programado) |
  // mark_notification_sent_by_webhook (webhook tardío cancela el retry)
  failed: ['sending', 'sent'],
} as const;

export function isAllowedTransition(from: RecoveryStatus, to: RecoveryStatus): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}

/** Parsea una fecha ISO a epoch ms; `null` si es ausente o ilegible. */
function toEpoch(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** ¿La fecha existe y ya venció respecto de `now`? Un `null` nunca vence. */
function isDue(value: string | null, now: number): boolean {
  const at = toEpoch(value);
  return at !== null && at <= now;
}

/** `sent` es terminal por definición; `terminal_at` lo es explícitamente. */
export function isTerminal(row: NotificationRecoveryRow): boolean {
  return row.status === 'sent' || row.terminalAt !== null;
}

/** Requiere intervención humana; nunca elegible para trabajo automático. */
export function requiresManualReview(row: NotificationRecoveryRow): boolean {
  return row.manualReviewRequired;
}

/** Base común: ni cerrada ni marcada para revisión manual. */
function isOpenForAutomation(row: NotificationRecoveryRow): boolean {
  return !isTerminal(row) && !requiresManualReview(row);
}

/** ¿Es un 'sending' abandonado (reclamado hace más de `staleSeconds`)? */
export function isStaleSending(
  row: NotificationRecoveryRow,
  now: number,
  staleSeconds: number = MIN_STALE_SECONDS,
): boolean {
  if (row.status !== 'sending') return false;
  const claimed = toEpoch(row.claimedAt);
  if (claimed === null) return false;
  return claimed < now - staleSeconds * 1000;
}

/**
 * I3 — ¿Puede reclamarse para ENVIAR?
 *  - 'pending' : sí (fila nueva que aún no salió).
 *  - 'failed'  : solo con next_attempt_at explícito y vencido, y error NO
 *                ambiguo.
 *  - 'sending' : NUNCA, ni fresco ni vencido.
 *  - resto     : no.
 */
export function canClaimForSend(row: NotificationRecoveryRow, now: number): boolean {
  if (!isOpenForAutomation(row)) return false;
  if (isAmbiguousError(row.lastErrorCode)) return false;
  if (row.attemptCount >= row.maxAttempts) return false;

  if (row.status === 'pending') return true;
  if (row.status === 'failed') return isDue(row.nextAttemptAt, now);
  // 'sending' (fresco o vencido), 'pending_reconciliation', 'reconciling', 'sent'.
  return false;
}

/** Alias histórico de `canClaimForSend`, con la misma semántica. */
export function canRetrySend(row: NotificationRecoveryRow, now: number): boolean {
  return canClaimForSend(row, now);
}

/** I3 — un 'sending' vencido necesita recuperación, no reenvío. */
export function needsStaleSendingRecovery(
  row: NotificationRecoveryRow,
  now: number,
  staleSeconds: number = MIN_STALE_SECONDS,
): boolean {
  return isOpenForAutomation(row) && isStaleSending(row, now, staleSeconds);
}

/**
 * Estado resultante de recuperar un 'sending' abandonado. `attemptCount` NO
 * cambia: el intento ya se contó al reclamar.
 */
export function describeStaleSendingRecovery(
  row: NotificationRecoveryRow,
  nowIso: string,
): NotificationRecoveryRow {
  return {
    ...row,
    status: 'pending_reconciliation',
    lastErrorCode: STALE_SENDING_ERROR_CODE,
    reconciliationDueAt: nowIso,
    nextAttemptAt: null,
    claimedAt: null,
    attemptCount: row.attemptCount,
  };
}

/**
 * ¿Puede entrar a reconciliación? Exige `pending_reconciliation` con fecha
 * explícita vencida y margen de intentos.
 */
export function canEnterReconciliation(row: NotificationRecoveryRow, now: number): boolean {
  if (!isOpenForAutomation(row)) return false;
  if (row.status !== 'pending_reconciliation') return false;
  if (!isDue(row.reconciliationDueAt, now)) return false;
  return row.reconciliationAttemptCount < row.maxAttempts;
}

/**
 * ¿Un 'reconciling' abandonado puede re-reclamarse? Repetir una CONSULTA de
 * historial es seguro; nunca habilita un envío.
 */
export function canReclaimStaleReconciling(
  row: NotificationRecoveryRow,
  now: number,
  staleSeconds: number = 300,
): boolean {
  if (!isOpenForAutomation(row)) return false;
  if (row.status !== 'reconciling') return false;
  if (row.reconciliationAttemptCount >= row.maxAttempts) return false;
  const claimed = toEpoch(row.claimedAt);
  if (claimed === null) return false;
  return claimed < now - staleSeconds * 1000;
}

/** ¿Se agotaron los intentos de envío? */
export function hasExhaustedSendAttempts(row: NotificationRecoveryRow): boolean {
  return row.attemptCount >= row.maxAttempts;
}

/** ¿Se agotaron los intentos de reconciliación? */
export function hasExhaustedReconciliationAttempts(row: NotificationRecoveryRow): boolean {
  return row.reconciliationAttemptCount >= row.maxAttempts;
}

/**
 * Al agotarse los intentos de reconciliación la fila va a revisión manual,
 * NUNCA a un reintento automático.
 */
export function mustGoToManualReview(row: NotificationRecoveryRow): boolean {
  return (
    row.status === 'pending_reconciliation' && hasExhaustedReconciliationAttempts(row)
  );
}

/**
 * Elegibilidad total para el futuro worker. Espeja
 * `select_due_notification_orders`: reintento de envío, reconciliación o
 * recuperación de un 'sending' abandonado.
 */
export function isEligibleForWork(row: NotificationRecoveryRow, now: number): boolean {
  return (
    canClaimForSend(row, now) ||
    canEnterReconciliation(row, now) ||
    needsStaleSendingRecovery(row, now)
  );
}

/**
 * Dependencia de orden: una solicitud de ubicación nunca se adelanta a su
 * confirmación.
 */
export function isLocationRequestUnblocked(confirmationStatus: RecoveryStatus | null): boolean {
  return confirmationStatus === 'sent';
}

export function isEligibleForWorkWithDependency(
  row: NotificationRecoveryRow,
  confirmationStatus: RecoveryStatus | null,
  now: number,
): boolean {
  if (!isEligibleForWork(row, now)) return false;
  if (row.notificationType !== 'location_request') return true;
  return isLocationRequestUnblocked(confirmationStatus);
}

/** ¿Es válida una ventana stale? Debe superar el timeout de envío. */
export function isSafeStaleSeconds(seconds: number): boolean {
  return Number.isFinite(seconds) && seconds >= MIN_STALE_SECONDS && seconds <= 3600;
}

/** Estados desde los que el webhook outbound puede cerrar como enviada. */
export const WEBHOOK_SENT_ORIGINS: readonly RecoveryStatus[] = [
  'sending',
  'pending_reconciliation',
  'reconciling',
  'failed',
] as const;

/**
 * ¿El webhook outbound puede cerrar esta fila como enviada?
 *
 * Acepta un 'failed' recuperable (el webhook tardío CANCELA el retry pendiente)
 * pero nunca un cierre explícito: terminal o revisión manual exigen decisión
 * humana. Una fila 'sent' se resuelve aparte por idempotencia/conflicto.
 */
export function canWebhookMarkSent(row: NotificationRecoveryRow): boolean {
  if (row.status === 'sent') return false; // se trata como idempotencia/conflicto
  if (row.terminalAt !== null) return false;
  if (row.manualReviewRequired) return false;
  return WEBHOOK_SENT_ORIGINS.includes(row.status);
}

/** Resolución de una señal de webhook sobre una fila ya 'sent'. */
export type SentConflictResolution = 'already_sent' | 'conflict';

/**
 * `sent` + mismo wamid → idempotente. `sent` + wamid distinto → conflicto (que
 * NUNCA modifica el wamid original y marca revisión manual).
 */
export function resolveSentSignal(
  row: NotificationRecoveryRow,
  storedExternalMessageId: string | null,
  incomingExternalMessageId: string,
): SentConflictResolution {
  return storedExternalMessageId === incomingExternalMessageId ? 'already_sent' : 'conflict';
}

/**
 * Estado final esperado de una fila enviada: sin programación pendiente, sin
 * error y sin reclamo. Espeja `order_notifications_sent_not_scheduled`.
 *
 * Es la comprobación explícita de que `next_attempt_at` (puesto por
 * `initialize_order_notifications` o por un retry programado) NO sobrevive.
 */
export function isCleanSentRow(row: NotificationRecoveryRow): boolean {
  return (
    row.status === 'sent' &&
    row.nextAttemptAt === null &&
    row.reconciliationDueAt === null &&
    row.terminalAt === null &&
    row.claimedAt === null &&
    row.lastErrorCode === null &&
    row.lastHttpStatus === null
  );
}
