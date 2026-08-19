import { describe, it, expect } from 'vitest';
import {
  ALLOWED_TRANSITIONS,
  AMBIGUOUS_ERROR_CODES,
  DEFAULT_MAX_ATTEMPTS,
  MIN_STALE_SECONDS,
  RECONCILIATION_SOURCES,
  RECOVERY_STATUSES,
  RETRY_AUTHORIZING_OUTCOME,
  STALE_SENDING_ERROR_CODE,
  WEBHOOK_SENT_ORIGINS,
  canClaimForSend,
  canEnterReconciliation,
  canReclaimStaleReconciling,
  canScheduleRetryAfterReconciliation,
  canWebhookMarkSent,
  describeStaleSendingRecovery,
  hasExhaustedReconciliationAttempts,
  hasExhaustedSendAttempts,
  isAllowedTransition,
  isAmbiguousError,
  isCleanSentRow,
  isEligibleForWork,
  isEligibleForWorkWithDependency,
  isLocationRequestUnblocked,
  isSafeStaleSeconds,
  isStaleSending,
  isTerminal,
  mustGoToManualReview,
  needsStaleSendingRecovery,
  requiresManualReview,
  resolveSentSignal,
  type NotificationRecoveryRow,
  type ReconciliationOutcome,
} from './recovery-state';

const NOW = Date.parse('2026-07-22T18:00:00.000Z');
const PAST = '2026-07-22T17:59:00.000Z';
const FUTURE = '2026-07-22T18:30:00.000Z';
/** Reclamado hace 10 minutos: muy por encima del suelo stale de 120 s. */
const LONG_AGO = '2026-07-22T17:50:00.000Z';
/** Reclamado hace 5 segundos: claramente en vuelo. */
const JUST_NOW = '2026-07-22T17:59:55.000Z';

function row(overrides: Partial<NotificationRecoveryRow> = {}): NotificationRecoveryRow {
  return {
    notificationType: 'confirmation',
    status: 'pending',
    attemptCount: 0,
    reconciliationAttemptCount: 0,
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
    nextAttemptAt: null,
    reconciliationDueAt: null,
    claimedAt: null,
    terminalAt: null,
    manualReviewRequired: false,
    lastErrorCode: null,
    lastHttpStatus: null,
    ...overrides,
  };
}

describe('recovery-state — dominios', () => {
  it('expone los seis estados de la máquina', () => {
    expect([...RECOVERY_STATUSES].sort()).toEqual([
      'failed',
      'pending',
      'pending_reconciliation',
      'reconciling',
      'sending',
      'sent',
    ]);
  });

  it('expone las cuatro fuentes de reconciliación', () => {
    expect([...RECONCILIATION_SOURCES].sort()).toEqual([
      'history',
      'manual',
      'send_response',
      'webhook',
    ]);
  });

  it('la ventana stale mínima supera el timeout de envío de 20 s', () => {
    expect(MIN_STALE_SECONDS).toBe(120);
    expect(isSafeStaleSeconds(120)).toBe(true);
    expect(isSafeStaleSeconds(30)).toBe(false);
    expect(isSafeStaleSeconds(20)).toBe(false);
    expect(isSafeStaleSeconds(7200)).toBe(false);
  });
});

describe('recovery-state — clasificación de errores ambiguos (I2)', () => {
  it('los errores de red/proveedor son ambiguos', () => {
    for (const code of ['timeout', 'network_error', 'invalid_response', 'http_error']) {
      expect(isAmbiguousError(code)).toBe(true);
      expect(AMBIGUOUS_ERROR_CODES).toContain(code);
    }
  });

  it('persistence_error y stale_sending_unknown son ambiguos', () => {
    expect(isAmbiguousError('persistence_error')).toBe(true);
    expect(isAmbiguousError(STALE_SENDING_ERROR_CODE)).toBe(true);
  });

  it('cualquier http_* es ambiguo, incluido el 409', () => {
    expect(isAmbiguousError('http_409')).toBe(true);
    expect(isAmbiguousError('http_500')).toBe(true);
  });

  it('los errores que nunca salieron a la red NO son ambiguos', () => {
    for (const code of ['invalid_phone', 'invalid_text', 'invalid_body_text']) {
      expect(isAmbiguousError(code)).toBe(false);
    }
  });

  it('ausente o vacío no es ambiguo', () => {
    expect(isAmbiguousError(null)).toBe(false);
    expect(isAmbiguousError('   ')).toBe(false);
  });
});

describe('recovery-state — I3: un sending nunca se reenvía', () => {
  it('sending reciente NO es reclamable para envío', () => {
    const fresh = row({ status: 'sending', claimedAt: JUST_NOW });
    expect(canClaimForSend(fresh, NOW)).toBe(false);
    expect(isStaleSending(fresh, NOW)).toBe(false);
    expect(needsStaleSendingRecovery(fresh, NOW)).toBe(false);
  });

  it('sending STALE tampoco es reenviable', () => {
    const stale = row({ status: 'sending', claimedAt: LONG_AGO });
    expect(isStaleSending(stale, NOW)).toBe(true);
    // Lo decisivo: vencido o no, jamás vuelve a 'sending'.
    expect(canClaimForSend(stale, NOW)).toBe(false);
  });

  it('sending stale requiere RECUPERACIÓN, no envío', () => {
    const stale = row({ status: 'sending', claimedAt: LONG_AGO });
    expect(needsStaleSendingRecovery(stale, NOW)).toBe(true);
    // Sigue siendo trabajo para el worker, pero de otra naturaleza.
    expect(isEligibleForWork(stale, NOW)).toBe(true);
  });

  it('la recuperación NO incrementa attempt_count y deja sin next_attempt_at', () => {
    const stale = row({ status: 'sending', claimedAt: LONG_AGO, attemptCount: 3 });
    const recovered = describeStaleSendingRecovery(stale, '2026-07-22T18:00:00.000Z');

    expect(recovered.status).toBe('pending_reconciliation');
    expect(recovered.lastErrorCode).toBe(STALE_SENDING_ERROR_CODE);
    expect(recovered.reconciliationDueAt).toBe('2026-07-22T18:00:00.000Z');
    expect(recovered.nextAttemptAt).toBeNull();
    expect(recovered.claimedAt).toBeNull();
    // El intento ya se contó al reclamar: no se cuenta dos veces.
    expect(recovered.attemptCount).toBe(3);
  });

  it('la fila recuperada NO puede reenviarse: su error es ambiguo', () => {
    const stale = row({ status: 'sending', claimedAt: LONG_AGO, attemptCount: 1 });
    const recovered = describeStaleSendingRecovery(stale, '2026-07-22T18:00:00.000Z');

    expect(isAmbiguousError(recovered.lastErrorCode)).toBe(true);
    expect(canClaimForSend(recovered, NOW)).toBe(false);
    // Solo puede avanzar reconciliándose.
    expect(canEnterReconciliation(recovered, NOW)).toBe(true);
  });

  it('no existe la transición sending -> sending', () => {
    expect(isAllowedTransition('sending', 'sending')).toBe(false);
    expect(ALLOWED_TRANSITIONS.sending).not.toContain('sending');
  });
});

describe('recovery-state — transiciones', () => {
  it('sending puede ir a sent, pending_reconciliation o failed', () => {
    expect([...ALLOWED_TRANSITIONS.sending].sort()).toEqual([
      'failed',
      'pending_reconciliation',
      'sent',
    ]);
  });

  it('failed puede reclamarse o cerrarse por un webhook tardío', () => {
    expect([...ALLOWED_TRANSITIONS.failed].sort()).toEqual(['sending', 'sent']);
  });

  it('sent es terminal: no sale a ningún estado', () => {
    expect(ALLOWED_TRANSITIONS.sent).toEqual([]);
    for (const to of RECOVERY_STATUSES) {
      expect(isAllowedTransition('sent', to)).toBe(false);
    }
  });

  it('rechaza saltos ilegales', () => {
    expect(isAllowedTransition('pending', 'sent')).toBe(false);
    expect(isAllowedTransition('pending', 'reconciling')).toBe(false);
    expect(isAllowedTransition('sending', 'reconciling')).toBe(false);
  });
});

describe('recovery-state — evidencia obligatoria para reintentar tras reconciliar', () => {
  it('solo not_found autoriza programar un reenvío', () => {
    expect(RETRY_AUTHORIZING_OUTCOME).toBe('not_found');
    expect(canScheduleRetryAfterReconciliation('not_found')).toBe(true);
  });

  it('ningún otro resultado autoriza reenvío', () => {
    const forbidden: ReconciliationOutcome[] = [
      'ambiguous',
      'multiple_matches',
      'provider_failed',
      'history_error',
      'history_timeout',
      'invalid_response',
      'webhook_pending',
    ];
    for (const outcome of forbidden) {
      expect(canScheduleRetryAfterReconciliation(outcome)).toBe(false);
    }
  });

  it('un código desconocido o ausente nunca autoriza reenvío', () => {
    expect(canScheduleRetryAfterReconciliation('algo_raro')).toBe(false);
    expect(canScheduleRetryAfterReconciliation(null)).toBe(false);
    expect(canScheduleRetryAfterReconciliation('')).toBe(false);
  });
});

describe('recovery-state — webhook: estados aceptados', () => {
  it('acepta sending, pending_reconciliation, reconciling y failed recuperable', () => {
    expect([...WEBHOOK_SENT_ORIGINS].sort()).toEqual([
      'failed',
      'pending_reconciliation',
      'reconciling',
      'sending',
    ]);
    for (const status of WEBHOOK_SENT_ORIGINS) {
      expect(canWebhookMarkSent(row({ status, lastErrorCode: 'timeout' }))).toBe(true);
    }
  });

  it('no acepta un failed TERMINAL', () => {
    const terminal = row({ status: 'failed', lastErrorCode: 'invalid_text', terminalAt: PAST });
    expect(canWebhookMarkSent(terminal)).toBe(false);
  });

  it('no acepta una fila en revisión manual', () => {
    const manual = row({ status: 'failed', lastErrorCode: 'x', manualReviewRequired: true });
    expect(canWebhookMarkSent(manual)).toBe(false);
  });

  it('no degrada una fila ya sent', () => {
    expect(canWebhookMarkSent(row({ status: 'sent' }))).toBe(false);
  });
});

describe('recovery-state — sent: idempotencia y conflicto', () => {
  it('mismo wamid -> idempotente', () => {
    expect(resolveSentSignal(row({ status: 'sent' }), 'wamid.A', 'wamid.A')).toBe('already_sent');
  });

  it('wamid distinto -> conflicto', () => {
    expect(resolveSentSignal(row({ status: 'sent' }), 'wamid.A', 'wamid.B')).toBe('conflict');
  });

  it('una fila sent en conflicto sigue sin ser elegible para el worker', () => {
    const conflicted = row({ status: 'sent', manualReviewRequired: true });
    expect(isEligibleForWork(conflicted, NOW)).toBe(false);
    expect(isTerminal(conflicted)).toBe(true);
  });
});

describe('recovery-state — protección de filas históricas (I1)', () => {
  it('fila histórica con ambas fechas null NO es elegible', () => {
    const historic = row({ status: 'pending', nextAttemptAt: null, reconciliationDueAt: null });
    // 'pending' sí es reclamable por el camino inmediato, pero no por fecha.
    expect(canEnterReconciliation(historic, NOW)).toBe(false);
  });

  it('failed histórico sin next_attempt_at NO es reclamable', () => {
    const historic = row({ status: 'failed', nextAttemptAt: null, lastErrorCode: 'invalid_phone' });
    expect(canClaimForSend(historic, NOW)).toBe(false);
    expect(isEligibleForWork(historic, NOW)).toBe(false);
  });

  it('una fecha ilegible se trata como ausente, nunca como vencida', () => {
    const broken = row({ status: 'failed', nextAttemptAt: 'ayer', lastErrorCode: 'invalid_text' });
    expect(canClaimForSend(broken, NOW)).toBe(false);
  });
});

describe('recovery-state — un timeout nunca se reenvía directamente (I2)', () => {
  it('failed con error ambiguo y fecha vencida NO es reintentable', () => {
    for (const code of ['timeout', 'network_error', 'invalid_response', 'http_error']) {
      const ambiguous = row({ status: 'failed', nextAttemptAt: PAST, lastErrorCode: code });
      expect(canClaimForSend(ambiguous, NOW)).toBe(false);
      expect(isEligibleForWork(ambiguous, NOW)).toBe(false);
    }
  });

  it('el mismo caso SÍ avanza si está en pending_reconciliation', () => {
    const reconcilable = row({
      status: 'pending_reconciliation',
      reconciliationDueAt: PAST,
      lastErrorCode: 'timeout',
    });
    expect(canEnterReconciliation(reconcilable, NOW)).toBe(true);
  });

  it('un error NO ambiguo sí puede reintentarse cuando está programado', () => {
    const permanent = row({ status: 'failed', nextAttemptAt: PAST, lastErrorCode: 'invalid_text' });
    expect(canClaimForSend(permanent, NOW)).toBe(true);
  });
});

describe('recovery-state — reclamo para envío', () => {
  it('pending nueva es reclamable', () => {
    expect(canClaimForSend(row({ status: 'pending' }), NOW)).toBe(true);
  });

  it('failed con fecha futura NO es reclamable todavía', () => {
    const later = row({ status: 'failed', nextAttemptAt: FUTURE, lastErrorCode: 'invalid_text' });
    expect(canClaimForSend(later, NOW)).toBe(false);
  });

  it('max_attempts alcanzado NO es reclamable', () => {
    const exhausted = row({
      status: 'failed',
      nextAttemptAt: PAST,
      lastErrorCode: 'invalid_text',
      attemptCount: DEFAULT_MAX_ATTEMPTS,
    });
    expect(hasExhaustedSendAttempts(exhausted)).toBe(true);
    expect(canClaimForSend(exhausted, NOW)).toBe(false);
  });

  it('los estados de reconciliación no se reclaman para envío', () => {
    for (const status of ['pending_reconciliation', 'reconciling'] as const) {
      expect(canClaimForSend(row({ status, lastErrorCode: 'timeout' }), NOW)).toBe(false);
    }
  });
});

describe('recovery-state — reconciliación y stale reconciling', () => {
  it('pending_reconciliation vencida puede entrar a reconciliación', () => {
    const due = row({
      status: 'pending_reconciliation',
      reconciliationDueAt: PAST,
      lastErrorCode: 'timeout',
    });
    expect(canEnterReconciliation(due, NOW)).toBe(true);
  });

  it('reconciling abandonado puede re-reclamarse para otra CONSULTA', () => {
    const stale = row({ status: 'reconciling', claimedAt: LONG_AGO });
    expect(canReclaimStaleReconciling(stale, NOW)).toBe(true);
    // Pero jamás habilita un envío.
    expect(canClaimForSend(stale, NOW)).toBe(false);
  });

  it('reconciling reciente no se re-reclama', () => {
    const fresh = row({ status: 'reconciling', claimedAt: JUST_NOW });
    expect(canReclaimStaleReconciling(fresh, NOW)).toBe(false);
  });

  it('reconciling stale respeta max_attempts', () => {
    const exhausted = row({
      status: 'reconciling',
      claimedAt: LONG_AGO,
      reconciliationAttemptCount: DEFAULT_MAX_ATTEMPTS,
    });
    expect(canReclaimStaleReconciling(exhausted, NOW)).toBe(false);
  });

  it('al agotarse la reconciliación va a revisión manual, no a retry', () => {
    const exhausted = row({
      status: 'pending_reconciliation',
      reconciliationDueAt: PAST,
      lastErrorCode: 'timeout',
      reconciliationAttemptCount: DEFAULT_MAX_ATTEMPTS,
    });
    expect(hasExhaustedReconciliationAttempts(exhausted)).toBe(true);
    expect(mustGoToManualReview(exhausted)).toBe(true);
    expect(canEnterReconciliation(exhausted, NOW)).toBe(false);
    expect(canClaimForSend(exhausted, NOW)).toBe(false);
    expect(isEligibleForWork(exhausted, NOW)).toBe(false);
  });
});

describe('recovery-state — cierres', () => {
  it('terminal_at no null NO es elegible por ninguna vía', () => {
    const terminal = row({
      status: 'failed',
      nextAttemptAt: PAST,
      lastErrorCode: 'invalid_text',
      terminalAt: PAST,
    });
    expect(isTerminal(terminal)).toBe(true);
    expect(isEligibleForWork(terminal, NOW)).toBe(false);
  });

  it('manual_review_required NO es elegible por ninguna vía', () => {
    const manual = row({
      status: 'failed',
      nextAttemptAt: PAST,
      lastErrorCode: 'invalid_text',
      manualReviewRequired: true,
    });
    expect(requiresManualReview(manual)).toBe(true);
    expect(isEligibleForWork(manual, NOW)).toBe(false);
  });

  it('un sending stale terminal o en revisión manual no se recupera solo', () => {
    expect(
      needsStaleSendingRecovery(
        row({ status: 'sending', claimedAt: LONG_AGO, manualReviewRequired: true }),
        NOW,
      ),
    ).toBe(false);
  });
});

describe('recovery-state — metadatos de una fila enviada', () => {
  it('una fila sent limpia cumple el invariante completo', () => {
    expect(isCleanSentRow(row({ status: 'sent' }))).toBe(true);
  });

  it('una fila sent NO puede conservar next_attempt_at', () => {
    const dirty = row({ status: 'sent', nextAttemptAt: PAST });
    expect(isCleanSentRow(dirty)).toBe(false);
    expect(isEligibleForWork(dirty, NOW)).toBe(false);
  });

  it('una fila sent no conserva reconciliación, error, HTTP status ni claim', () => {
    expect(isCleanSentRow(row({ status: 'sent', reconciliationDueAt: PAST }))).toBe(false);
    expect(isCleanSentRow(row({ status: 'sent', lastErrorCode: 'timeout' }))).toBe(false);
    expect(isCleanSentRow(row({ status: 'sent', lastHttpStatus: 500 }))).toBe(false);
    expect(isCleanSentRow(row({ status: 'sent', claimedAt: PAST }))).toBe(false);
    expect(isCleanSentRow(row({ status: 'sent', terminalAt: PAST }))).toBe(false);
  });
});

describe('recovery-state — contrato: webhook tardío cancela un retry programado', () => {
  it('recorre timeout -> reconciliación -> retry -> webhook -> sent sin 2º envío', () => {
    // 1. Timeout durante el envío -> pending_reconciliation (nunca 'failed' reenviable).
    let current = row({
      status: 'pending_reconciliation',
      attemptCount: 1,
      reconciliationDueAt: PAST,
      lastErrorCode: 'timeout',
    });
    expect(canClaimForSend(current, NOW)).toBe(false);
    expect(canEnterReconciliation(current, NOW)).toBe(true);

    // 2. El worker reclama la reconciliación.
    current = {
      ...current,
      status: 'reconciling',
      claimedAt: JUST_NOW,
      reconciliationAttemptCount: 1,
    };
    expect(isAllowedTransition('pending_reconciliation', 'reconciling')).toBe(true);

    // 3. El historial responde not_found: es la ÚNICA evidencia que autoriza reenvío.
    const outcome: ReconciliationOutcome = 'not_found';
    expect(canScheduleRetryAfterReconciliation(outcome)).toBe(true);

    // 4. Se programa el retry -> failed con next_attempt_at futuro.
    current = {
      ...current,
      status: 'failed',
      claimedAt: null,
      lastErrorCode: 'reconciliation_not_found',
      nextAttemptAt: FUTURE,
      reconciliationDueAt: null,
    };
    expect(isAllowedTransition('reconciling', 'failed')).toBe(true);
    // Aún no vencido: el worker todavía no lo tomaría.
    expect(canClaimForSend(current, NOW)).toBe(false);

    // 5. ANTES del retry llega whatsapp.message.sent.
    expect(canWebhookMarkSent(current)).toBe(true);

    // 6. El webhook cierra la fila como enviada.
    current = {
      ...current,
      status: 'sent',
      nextAttemptAt: null,
      reconciliationDueAt: null,
      claimedAt: null,
      lastErrorCode: null,
      lastHttpStatus: null,
      terminalAt: null,
      manualReviewRequired: false,
    };
    expect(isAllowedTransition('failed', 'sent')).toBe(true);

    // 7. next_attempt_at quedó null: el retry está cancelado.
    expect(current.nextAttemptAt).toBeNull();
    expect(isCleanSentRow(current)).toBe(true);

    // 8. El worker ya no puede descubrirla por ninguna vía.
    expect(canClaimForSend(current, NOW)).toBe(false);
    expect(canEnterReconciliation(current, NOW)).toBe(false);
    expect(needsStaleSendingRecovery(current, NOW)).toBe(false);
    expect(isEligibleForWork(current, NOW)).toBe(false);

    // 9. Y sigue sin ser elegible aunque el reloj avance mucho.
    const muchLater = Date.parse('2026-07-30T00:00:00.000Z');
    expect(isEligibleForWork(current, muchLater)).toBe(false);
  });
});

describe('recovery-state — dependencia confirmation -> location_request', () => {
  it('location_request no se adelanta si la confirmación no está sent', () => {
    const location = row({ notificationType: 'location_request', status: 'pending' });
    expect(isEligibleForWork(location, NOW)).toBe(true);

    for (const confirmation of ['pending', 'sending', 'failed', 'pending_reconciliation'] as const) {
      expect(isLocationRequestUnblocked(confirmation)).toBe(false);
      expect(isEligibleForWorkWithDependency(location, confirmation, NOW)).toBe(false);
    }
    expect(isEligibleForWorkWithDependency(location, null, NOW)).toBe(false);
  });

  it('location_request se libera cuando la confirmación está sent', () => {
    const location = row({ notificationType: 'location_request', status: 'pending' });
    expect(isEligibleForWorkWithDependency(location, 'sent', NOW)).toBe(true);
  });

  it('la dependencia aplica también a la reconciliación', () => {
    const location = row({
      notificationType: 'location_request',
      status: 'pending_reconciliation',
      reconciliationDueAt: PAST,
      lastErrorCode: 'timeout',
    });
    expect(isEligibleForWorkWithDependency(location, 'pending', NOW)).toBe(false);
    expect(isEligibleForWorkWithDependency(location, 'sent', NOW)).toBe(true);
  });

  it('la confirmación nunca depende de nadie', () => {
    expect(isEligibleForWorkWithDependency(row({ status: 'pending' }), null, NOW)).toBe(true);
  });
});
