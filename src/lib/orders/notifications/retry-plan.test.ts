import { describe, it, expect } from 'vitest';
import {
  classifyFailedRow,
  planNotificationRetry,
  planOrderRetry,
  type NotificationStateRow,
} from './retry-plan';

const NOW = Date.parse('2026-07-22T18:00:00.000Z');
const PAST = '2026-07-22T17:59:00.000Z';
const FUTURE = '2026-07-22T18:30:00.000Z';

function row(overrides: Partial<NotificationStateRow> = {}): NotificationStateRow {
  return {
    notificationType: 'confirmation',
    status: 'pending',
    attemptCount: 0,
    maxAttempts: 5,
    nextAttemptAt: null,
    terminalAt: null,
    manualReviewRequired: false,
    lastErrorCode: null,
    lastHttpStatus: null,
    ...overrides,
  };
}

describe('classifyFailedRow — un failed NO ambiguo no es, por sí solo, retryable', () => {
  it('los errores de datos son PERMANENTES, no retryables', () => {
    for (const code of ['invalid_phone', 'invalid_text', 'invalid_body_text']) {
      expect(classifyFailedRow(row({ lastErrorCode: code }))).toBe('permanent');
    }
  });

  it('los ambiguos de 0005 exigen reconciliar', () => {
    for (const code of [
      'timeout',
      'network_error',
      'invalid_response',
      'persistence_error',
      'stale_sending_unknown',
    ]) {
      expect(classifyFailedRow(row({ lastErrorCode: code }))).toBe('reconcile');
    }
  });

  it('http_error sin status es ambiguo: no se adivina 4xx ni 5xx', () => {
    expect(classifyFailedRow(row({ lastErrorCode: 'http_error', lastHttpStatus: null }))).toBe(
      'reconcile',
    );
  });

  it('usa el status persistido cuando existe', () => {
    expect(classifyFailedRow(row({ lastErrorCode: 'http_error', lastHttpStatus: 503 }))).toBe(
      'retryable',
    );
    expect(classifyFailedRow(row({ lastErrorCode: 'http_error', lastHttpStatus: 429 }))).toBe(
      'retryable',
    );
    expect(classifyFailedRow(row({ lastErrorCode: 'http_error', lastHttpStatus: 404 }))).toBe(
      'permanent',
    );
    expect(classifyFailedRow(row({ lastErrorCode: 'http_error', lastHttpStatus: 409 }))).toBe(
      'reconcile',
    );
  });

  it('deriva el status del propio código http_NNN', () => {
    expect(classifyFailedRow(row({ lastErrorCode: 'http_500' }))).toBe('retryable');
    expect(classifyFailedRow(row({ lastErrorCode: 'http_403' }))).toBe('permanent');
    expect(classifyFailedRow(row({ lastErrorCode: 'http_409' }))).toBe('reconcile');
  });

  it('un status fuera de rango no se usa para adivinar', () => {
    expect(classifyFailedRow(row({ lastErrorCode: 'http_error', lastHttpStatus: 99 }))).toBe(
      'reconcile',
    );
  });

  it('código desconocido o vacío -> manual_review, jamás retryable', () => {
    for (const code of ['algo_nuevo', '', '   ', null]) {
      expect(classifyFailedRow(row({ lastErrorCode: code }))).toBe('manual_review');
    }
  });
});

describe('planNotificationRetry — estados que SÍ despachan', () => {
  it('pending -> dispatch', () => {
    expect(planNotificationRetry(row({ status: 'pending' }), NOW)).toEqual({ action: 'dispatch' });
  });

  it('failed RETRYABLE (HTTP 5xx) sin programar -> schedule_then_dispatch', () => {
    const plan = planNotificationRetry(
      row({ status: 'failed', lastErrorCode: 'http_error', lastHttpStatus: 503 }),
      NOW,
    );
    expect(plan).toEqual({ action: 'schedule_then_dispatch' });
  });

  it('failed RETRYABLE ya programado y vencido -> dispatch directo', () => {
    const plan = planNotificationRetry(
      row({
        status: 'failed',
        lastErrorCode: 'http_error',
        lastHttpStatus: 500,
        nextAttemptAt: PAST,
      }),
      NOW,
    );
    expect(plan).toEqual({ action: 'dispatch' });
  });

  it('failed RETRYABLE programado a futuro -> se reprograma para ahora', () => {
    const plan = planNotificationRetry(
      row({
        status: 'failed',
        lastErrorCode: 'http_error',
        lastHttpStatus: 500,
        nextAttemptAt: FUTURE,
      }),
      NOW,
    );
    expect(plan).toEqual({ action: 'schedule_then_dispatch' });
  });
});

describe('planNotificationRetry — estados que NUNCA despachan', () => {
  it('sent -> already_sent', () => {
    expect(planNotificationRetry(row({ status: 'sent' }), NOW)).toEqual({
      action: 'reject',
      reason: 'already_sent',
    });
  });

  it('sending -> in_flight, incluso si estuviera vencido', () => {
    expect(planNotificationRetry(row({ status: 'sending' }), NOW)).toEqual({
      action: 'reject',
      reason: 'in_flight',
    });
  });

  it('pending_reconciliation -> requires_reconciliation', () => {
    expect(
      planNotificationRetry(
        row({ status: 'pending_reconciliation', lastErrorCode: 'timeout' }),
        NOW,
      ),
    ).toEqual({ action: 'reject', reason: 'requires_reconciliation' });
  });

  it('reconciling -> reconciliation_in_progress', () => {
    expect(planNotificationRetry(row({ status: 'reconciling' }), NOW)).toEqual({
      action: 'reject',
      reason: 'reconciliation_in_progress',
    });
  });

  it('failed AMBIGUO -> requires_reconciliation, nunca reenvío', () => {
    for (const code of [
      'timeout',
      'network_error',
      'invalid_response',
      'persistence_error',
      'http_error',
      'http_409',
    ]) {
      const plan = planNotificationRetry(
        row({ status: 'failed', lastErrorCode: code, nextAttemptAt: PAST }),
        NOW,
      );
      expect(plan).toEqual({ action: 'reject', reason: 'requires_reconciliation' });
    }
  });

  it('failed PERMANENTE -> permanent_failure, nunca se programa', () => {
    for (const code of ['invalid_phone', 'invalid_text', 'invalid_body_text']) {
      expect(
        planNotificationRetry(row({ status: 'failed', lastErrorCode: code }), NOW),
      ).toEqual({ action: 'reject', reason: 'permanent_failure' });
    }
  });

  it('failed con código desconocido o vacío -> manual_review_required', () => {
    for (const code of ['no_se_que_es', '', null]) {
      expect(
        planNotificationRetry(row({ status: 'failed', lastErrorCode: code }), NOW),
      ).toEqual({ action: 'reject', reason: 'manual_review_required' });
    }
  });

  it('terminal -> terminal, por delante de cualquier otro estado', () => {
    expect(
      planNotificationRetry(
        row({ status: 'failed', lastErrorCode: 'invalid_text', terminalAt: PAST }),
        NOW,
      ),
    ).toEqual({ action: 'reject', reason: 'terminal' });
  });

  it('manual_review_required -> manual_review_required', () => {
    expect(
      planNotificationRetry(
        row({ status: 'pending', manualReviewRequired: true }),
        NOW,
      ),
    ).toEqual({ action: 'reject', reason: 'manual_review_required' });
  });

  it('intentos agotados -> max_attempts_reached', () => {
    expect(
      planNotificationRetry(
        row({
          status: 'failed',
          lastErrorCode: 'http_error',
          lastHttpStatus: 500,
          attemptCount: 5,
          maxAttempts: 5,
        }),
        NOW,
      ),
    ).toEqual({ action: 'reject', reason: 'max_attempts_reached' });
  });

  it('fila inexistente -> not_found (nunca se inicializa)', () => {
    expect(planNotificationRetry(null, NOW)).toEqual({ action: 'reject', reason: 'not_found' });
  });

  it('estado desconocido -> unknown', () => {
    const weird = { ...row(), status: 'algo_raro' } as unknown as NotificationStateRow;
    expect(planNotificationRetry(weird, NOW)).toEqual({ action: 'reject', reason: 'unknown' });
  });
});

describe('planOrderRetry — pedido completo', () => {
  it('pickup: solo confirmación, sin fila de ubicación', () => {
    const plan = planOrderRetry([row({ status: 'pending' })], NOW);
    expect(plan.confirmation).toEqual({ action: 'dispatch' });
    expect(plan.locationRequest).toBeNull();
    expect(plan.willDispatch).toBe(true);
    expect(plan.toSchedule).toEqual([]);
  });

  it('delivery: ambas pendientes -> despacha sin programar', () => {
    const plan = planOrderRetry(
      [row({ status: 'pending' }), row({ notificationType: 'location_request', status: 'pending' })],
      NOW,
    );
    expect(plan.willDispatch).toBe(true);
    expect(plan.toSchedule).toEqual([]);
  });

  it('recoge los tipos que necesitan programación previa', () => {
    const plan = planOrderRetry(
      [
        row({ status: 'failed', lastErrorCode: 'http_error', lastHttpStatus: 503 }),
        row({
          notificationType: 'location_request',
          status: 'failed',
          lastErrorCode: 'http_error',
          lastHttpStatus: 500,
        }),
      ],
      NOW,
    );
    expect(plan.toSchedule).toEqual(['confirmation', 'location_request']);
    expect(plan.willDispatch).toBe(true);
  });

  it('todo bloqueado -> willDispatch false', () => {
    const plan = planOrderRetry(
      [
        row({ status: 'pending_reconciliation', lastErrorCode: 'timeout' }),
        row({ notificationType: 'location_request', status: 'pending' , manualReviewRequired: true }),
      ],
      NOW,
    );
    expect(plan.willDispatch).toBe(false);
    expect(plan.confirmation.reason).toBe('requires_reconciliation');
  });

  it('sin filas -> ambas rechazadas por not_found', () => {
    const plan = planOrderRetry([], NOW);
    expect(plan.confirmation).toEqual({ action: 'reject', reason: 'not_found' });
    expect(plan.locationRequest).toBeNull();
    expect(plan.willDispatch).toBe(false);
  });

  it('un ambiguo nunca aparece en toSchedule', () => {
    const plan = planOrderRetry([row({ status: 'failed', lastErrorCode: 'timeout' })], NOW);
    expect(plan.toSchedule).toEqual([]);
    expect(plan.willDispatch).toBe(false);
  });
});
