import { describe, it, expect } from 'vitest';
import {
  isReviewDecision,
  reviewErrorMessage,
  shouldNotifyCustomer,
  statusForDecision,
  toReviewResult,
  type RpcDecisionRow,
} from './review-result';

const won: RpcDecisionRow = {
  outcome: 'won',
  attempt_id: 'a1',
  order_id: 'o1',
  review_status: 'accepted',
  reviewed_at: '2026-08-26T21:04:00.000Z',
};

describe('solo `won` avisa al cliente', () => {
  it('gana → se notifica', () => {
    expect(shouldNotifyCustomer('won')).toBe(true);
  });

  it('repetido, conflicto, inexistente e inválido NO notifican', () => {
    for (const outcome of ['repeated', 'conflict', 'not_found', 'invalid_decision'] as const) {
      expect(shouldNotifyCustomer(outcome), outcome).toBe(false);
    }
  });
});

describe('mapeo del resultado de la RPC', () => {
  it('won devuelve éxito con estado y fecha del servidor', () => {
    expect(toReviewResult(won, 'sent')).toEqual({
      ok: true,
      reviewStatus: 'accepted',
      reviewedAt: '2026-08-26T21:04:00.000Z',
      notification: 'sent',
    });
  });

  it('repeated es ÉXITO idempotente (el doble clic no es un error)', () => {
    const res = toReviewResult({ ...won, outcome: 'repeated' });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.reviewStatus).toBe('accepted');
      // Sin notificación: no se reenvía WhatsApp.
      expect(res.notification).toBeUndefined();
    }
  });

  it('conflict devuelve el estado REAL actual', () => {
    const res = toReviewResult({ ...won, outcome: 'conflict', review_status: 'rejected' });
    expect(res).toEqual({ ok: false, reason: 'conflict', current: 'rejected' });
  });

  it('not_found e invalid_decision se distinguen', () => {
    expect(toReviewResult({ outcome: 'not_found' })).toEqual({
      ok: false,
      reason: 'not_found',
      current: null,
    });
    expect(toReviewResult({ outcome: 'invalid_decision' })).toEqual({
      ok: false,
      reason: 'invalid_decision',
      current: null,
    });
  });

  it('una respuesta ausente o incoherente no finge éxito', () => {
    expect(toReviewResult(null)).toEqual({ ok: false, reason: 'error' });
    expect(toReviewResult(undefined)).toEqual({ ok: false, reason: 'error' });
    // Ganó pero sin fecha: imposible según el CHECK de la base; no se inventa.
    expect(toReviewResult({ ...won, reviewed_at: null })).toEqual({ ok: false, reason: 'error' });
    // Ganó pero sigue pendiente: contradictorio.
    expect(toReviewResult({ ...won, review_status: 'pending_review' })).toEqual({
      ok: false,
      reason: 'error',
    });
  });

  it('la notificación fallida viaja en el resultado sin invalidar la decisión', () => {
    const res = toReviewResult(won, 'failed');
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.notification).toBe('failed');
  });
});

describe('el resultado no filtra nada sensible', () => {
  it('no expone order_id, attempt_id ni detalle interno', () => {
    const json = JSON.stringify(toReviewResult(won, 'sent'));
    expect(json).not.toContain('o1');
    expect(json).not.toContain('a1');
    expect(json).not.toContain('order_id');
    expect(json).not.toContain('attempt_id');
  });

  it('los mensajes de error son operativos, sin SQL ni internals', () => {
    for (const reason of [
      'unauthorized',
      'invalid_decision',
      'not_found',
      'already_settled',
      'conflict',
      'error',
    ] as const) {
      const msg = reviewErrorMessage(reason);
      expect(msg.length, reason).toBeGreaterThan(0);
      expect(msg).not.toMatch(/select|update|supabase|postgres|null|undefined/i);
    }
  });

  it('el conflicto se explica en lenguaje del operador', () => {
    expect(reviewErrorMessage('conflict')).toBe('Otra persona ya decidió este pago.');
  });
});

describe('validación de la decisión', () => {
  it('solo accept y reject son decisiones válidas', () => {
    expect(isReviewDecision('accept')).toBe(true);
    expect(isReviewDecision('reject')).toBe(true);
    for (const malo of ['accepted', 'ACCEPT', '', null, 42, {}]) {
      expect(isReviewDecision(malo), String(malo)).toBe(false);
    }
  });

  it('la decisión mapea a su estado final', () => {
    expect(statusForDecision('accept')).toBe('accepted');
    expect(statusForDecision('reject')).toBe('rejected');
  });
});
