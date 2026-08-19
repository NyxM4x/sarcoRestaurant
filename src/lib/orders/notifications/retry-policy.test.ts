import { describe, it, expect } from 'vitest';
import {
  canRetryWithoutReconciliation,
  classifyHttpStatus,
  classifySendFailure,
  requiresManualReview,
  CHECKOUT_ROUTE_MAX_DURATION_SECONDS,
  fitsInInvocationBudget,
  MAX_NETWORK_SENDS_PER_DELIVERY_DISPATCH,
  MAX_NETWORK_SENDS_PER_WORKER_RUN,
  NOTIFICATION_SEND_TIMEOUT_MS,
} from './retry-policy';

describe('classifySendFailure — resultados desconocidos', () => {
  it('timeout, network_error e invalid_response requieren reconciliación', () => {
    expect(classifySendFailure('timeout')).toBe('pending_reconciliation');
    expect(classifySendFailure('network_error')).toBe('pending_reconciliation');
    expect(classifySendFailure('invalid_response')).toBe('pending_reconciliation');
  });

});

describe('classifySendFailure — fallback seguro', () => {
  it('un código desconocido exige revisión manual, nunca reintento automático', () => {
    expect(classifySendFailure('algo_nuevo')).toBe('manual_review');
    expect(classifySendFailure('kapso_explotó')).toBe('manual_review');
  });

  it('entrada incompleta o no textual -> manual_review', () => {
    expect(classifySendFailure('')).toBe('manual_review');
    expect(classifySendFailure('   ')).toBe('manual_review');
    expect(classifySendFailure(undefined as unknown as string)).toBe('manual_review');
    expect(classifySendFailure(null as unknown as string)).toBe('manual_review');
    expect(classifySendFailure({} as unknown as string)).toBe('manual_review');
  });

  it('ningún desconocido autoriza reintento automático', () => {
    for (const code of ['algo_nuevo', '', undefined as unknown as string]) {
      expect(canRetryWithoutReconciliation(classifySendFailure(code))).toBe(false);
      expect(requiresManualReview(classifySendFailure(code))).toBe(true);
    }
  });
});

describe('classifySendFailure — permanentes', () => {
  it('errores de datos o de nuestro código no se reintentan', () => {
    expect(classifySendFailure('invalid_phone')).toBe('permanent');
    expect(classifySendFailure('invalid_text')).toBe('permanent');
    expect(classifySendFailure('invalid_body_text')).toBe('permanent');
  });
});

describe('classifySendFailure — reintentables', () => {
  it('persistence_error es reintentable: no llegó a Kapso', () => {
    expect(classifySendFailure('persistence_error')).toBe('retryable');
  });
});

describe('classifySendFailure — http_error por status', () => {
  it('5xx es reintentable', () => {
    for (const status of [500, 502, 503, 504]) {
      expect(classifySendFailure('http_error', status)).toBe('retryable');
    }
  });

  it('409 requiere reconciliación', () => {
    expect(classifySendFailure('http_error', 409)).toBe('pending_reconciliation');
  });

  it('429 es reintentable tras reconciliar o esperar', () => {
    expect(classifySendFailure('http_error', 429)).toBe(
      'retryable_after_reconciliation_or_backoff',
    );
  });

  it('4xx distinto de 409/429 es permanente', () => {
    for (const status of [400, 401, 403, 404, 422]) {
      expect(classifySendFailure('http_error', status)).toBe('permanent');
    }
  });

  it('status ausente o inválido -> manual_review', () => {
    expect(classifySendFailure('http_error')).toBe('manual_review');
    expect(classifySendFailure('http_error', null)).toBe('manual_review');
    expect(classifyHttpStatus(Number.NaN)).toBe('manual_review');
    expect(classifyHttpStatus(1.5)).toBe('manual_review');
    expect(classifyHttpStatus(Infinity)).toBe('manual_review');
    expect(classifyHttpStatus('500' as unknown as number)).toBe('manual_review');
  });

  it('status fuera de 4xx/5xx es incoherente -> manual_review', () => {
    expect(classifyHttpStatus(200)).toBe('manual_review');
    expect(classifyHttpStatus(302)).toBe('manual_review');
    expect(classifyHttpStatus(600)).toBe('manual_review');
  });
});

describe('canRetryWithoutReconciliation', () => {
  it('solo la clase retryable permite reenviar sin comprobar antes', () => {
    expect(canRetryWithoutReconciliation('retryable')).toBe(true);
    expect(canRetryWithoutReconciliation('pending_reconciliation')).toBe(false);
    expect(canRetryWithoutReconciliation('retryable_after_reconciliation_or_backoff')).toBe(false);
    expect(canRetryWithoutReconciliation('permanent')).toBe(false);
    expect(canRetryWithoutReconciliation('manual_review')).toBe(false);
  });

  it('ningún fallo ambiguo permite reenvío directo', () => {
    for (const code of ['timeout', 'network_error', 'invalid_response']) {
      expect(canRetryWithoutReconciliation(classifySendFailure(code))).toBe(false);
    }
  });
});

describe('presupuesto de tiempo por invocación', () => {
  it('declara los valores acordados', () => {
    expect(CHECKOUT_ROUTE_MAX_DURATION_SECONDS).toBe(60);
    expect(NOTIFICATION_SEND_TIMEOUT_MS).toBe(20_000);
    expect(MAX_NETWORK_SENDS_PER_DELIVERY_DISPATCH).toBe(2);
    expect(MAX_NETWORK_SENDS_PER_WORKER_RUN).toBe(1);
  });

  it('un delivery con dos envíos de 20 s cabe en la invocación', () => {
    expect(
      fitsInInvocationBudget(
        MAX_NETWORK_SENDS_PER_DELIVERY_DISPATCH,
        NOTIFICATION_SEND_TIMEOUT_MS,
      ),
    ).toBe(true);
  });

  it('dos envíos de 30 s NO caben: por eso no se sube a 30_000', () => {
    expect(fitsInInvocationBudget(2, 30_000)).toBe(false);
  });

  it('el worker se limita a un envío de red por ejecución', () => {
    expect(fitsInInvocationBudget(MAX_NETWORK_SENDS_PER_WORKER_RUN, 20_000)).toBe(true);
    // Tres envíos de 20 s desbordan el presupuesto.
    expect(fitsInInvocationBudget(3, 20_000)).toBe(false);
  });

  it('reserva margen para Supabase dentro de la misma invocación', () => {
    // Sin reserva cabrían 3 × 20 s = 60 s exactos; con reserva, no.
    expect(fitsInInvocationBudget(3, 20_000, 60, 0)).toBe(true);
    expect(fitsInInvocationBudget(3, 20_000, 60, 10_000)).toBe(false);
  });
});
