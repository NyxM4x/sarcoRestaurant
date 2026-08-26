import { describe, it, expect } from 'vitest';
import { toPaymentView } from './attempt-review';
import type { ProofUiRow } from './proofs-data-source';
import type { PaymentAttempt } from '@/types';

const T = (min: number) => new Date(Date.parse('2026-08-26T20:00:00.000Z') + min * 60_000).toISOString();

function attempt(id: string, over: Partial<PaymentAttempt> = {}): PaymentAttempt {
  return {
    id,
    order_id: 'order-1',
    review_status: 'pending_review',
    opened_at: T(0),
    reviewed_at: null,
    created_at: T(0),
    updated_at: T(0),
    ...over,
  };
}

function proof(id: string, over: Partial<ProofUiRow> = {}): ProofUiRow {
  return {
    id,
    source_message_id: `wamid-${id}`,
    order_id: 'order-1',
    attempt_id: 'a1',
    association_method: 'reply_to_qr',
    routing_exception: null,
    declared_mime_type: 'image/jpeg',
    verified_mime_type: 'image/jpeg',
    safe_filename: `comprobante-${id}.jpg`,
    duplicate_of_id: null,
    capture_status: 'stored',
    received_at: T(1),
    analysis_status: 'pending',
    ...over,
  };
}

describe('historial completo — nada se reemplaza', () => {
  it('un rechazo anterior se conserva junto al aceptado posterior', () => {
    const v = toPaymentView(
      [
        attempt('a1', { review_status: 'rejected', opened_at: T(0), reviewed_at: T(1) }),
        attempt('a2', { review_status: 'accepted', opened_at: T(4), reviewed_at: T(5) }),
      ],
      [proof('p1', { attempt_id: 'a1' }), proof('p2', { attempt_id: 'a2' })],
    );
    expect(v.attempts).toHaveLength(2);
    // Más reciente primero, pero el anterior sigue ahí.
    expect(v.attempts.map((a) => a.id)).toEqual(['a2', 'a1']);
    expect(v.attempts[1].statusLabel).toBe('Pago rechazado');
    expect(v.attempts[0].statusLabel).toBe('Pago confirmado');
  });

  it('cada intento lleva sus propios comprobantes y su cuenta', () => {
    const v = toPaymentView(
      [attempt('a1')],
      [proof('p1'), proof('p2'), proof('p3', { attempt_id: 'otro' })],
    );
    expect(v.attempts[0].proofCount).toBe(2);
    expect(v.attempts[0].proofs.map((p) => p.id)).toEqual(['p1', 'p2']);
  });

  it('soporta uno y varios comprobantes por intento', () => {
    expect(toPaymentView([attempt('a1')], [proof('p1')]).attempts[0].proofCount).toBe(1);
    expect(
      toPaymentView([attempt('a1')], [proof('p1'), proof('p2'), proof('p3')]).attempts[0].proofCount,
    ).toBe(3);
  });
});

describe('solo un intento pendiente admite decisión', () => {
  it('pendiente sí, decidido no', () => {
    const v = toPaymentView(
      [
        attempt('a1', { review_status: 'pending_review' }),
        attempt('a2', { review_status: 'accepted', reviewed_at: T(2), opened_at: T(-5) }),
        attempt('a3', { review_status: 'rejected', reviewed_at: T(3), opened_at: T(-9) }),
      ],
      [],
    );
    const porId = Object.fromEntries(v.attempts.map((a) => [a.id, a.canDecide]));
    expect(porId).toEqual({ a1: true, a2: false, a3: false });
    expect(v.hasPendingReview).toBe(true);
  });

  it('sin pendientes, el indicador se apaga', () => {
    const v = toPaymentView([attempt('a1', { review_status: 'accepted', reviewed_at: T(1) })], []);
    expect(v.hasPendingReview).toBe(false);
  });

  it('un pedido sin intentos no rompe nada', () => {
    expect(toPaymentView([], [])).toEqual({
      attempts: [],
      unlinkedProofs: [],
      hasPendingReview: false,
    });
  });
});

describe('presentación del comprobante', () => {
  it('el MIME REAL decide si se pinta como imagen', () => {
    const v = toPaymentView(
      [attempt('a1')],
      [
        proof('img', { verified_mime_type: 'image/png' }),
        proof('pdf', { verified_mime_type: 'application/pdf' }),
      ],
    );
    const [img, pdf] = v.attempts[0].proofs;
    expect(img.isImage).toBe(true);
    expect(pdf.isImage).toBe(false);
  });

  it('un archivo declarado imagen pero verificado PDF NO se pinta como imagen', () => {
    const v = toPaymentView(
      [attempt('a1')],
      [proof('x', { declared_mime_type: 'image/jpeg', verified_mime_type: 'application/pdf' })],
    );
    expect(v.attempts[0].proofs[0].isImage).toBe(false);
  });

  it('un comprobante no almacenado se marca como no disponible', () => {
    const v = toPaymentView(
      [attempt('a1')],
      [proof('x', { capture_status: 'pending' }), proof('y', { capture_status: 'failed' })],
    );
    expect(v.attempts[0].proofs.every((p) => p.isAvailable === false)).toBe(true);
  });

  it('el duplicado se marca por método o por referencia al original', () => {
    const v = toPaymentView(
      [attempt('a1')],
      [
        proof('d1', { association_method: 'duplicate' }),
        proof('d2', { duplicate_of_id: 'p-original' }),
        proof('n1'),
      ],
    );
    const [d1, d2, n1] = v.attempts[0].proofs;
    expect(d1.isDuplicate).toBe(true);
    expect(d2.isDuplicate).toBe(true);
    expect(n1.isDuplicate).toBe(false);
  });

  it('traduce método y excepción a lenguaje humano', () => {
    const v = toPaymentView(
      [attempt('a1')],
      [proof('p1', { association_method: 'single_open_qr_order' })],
    );
    expect(v.attempts[0].proofs[0].associationLabel).toBe('Vinculado por pedido único abierto');
  });
});

describe('comprobantes sin intento', () => {
  it('los que tienen excepción viven fuera de los intentos, no se pierden', () => {
    const v = toPaymentView(
      [attempt('a1')],
      [
        proof('suelto', {
          attempt_id: null,
          association_method: 'unresolved',
          routing_exception: 'closed_order',
        }),
      ],
    );
    expect(v.attempts[0].proofCount).toBe(0);
    expect(v.unlinkedProofs).toHaveLength(1);
    expect(v.unlinkedProofs[0].exceptionLabel).toBe('El pedido ya estaba cerrado');
  });
});

describe('la vista no filtra datos internos', () => {
  it('no viaja el WAMID, ni el order_id, ni ninguna storage key', () => {
    const v = toPaymentView([attempt('a1')], [proof('p1')]);
    const json = JSON.stringify(v);
    expect(json).not.toContain('wamid');
    expect(json).not.toContain('order-1');
    expect(json).not.toContain('storage');
    expect(json).not.toContain('source_message_id');
  });
});
