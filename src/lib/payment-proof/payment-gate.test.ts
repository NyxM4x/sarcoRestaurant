import { describe, it, expect } from 'vitest';
import { paymentGateOf, shouldCancelForExpiry, REJECTION_GRACE_MS } from './payment-gate';
import type { AttemptView, PaymentView } from '@/lib/dashboard/attempt-review';
import type { PaymentReviewStatus } from '@/types';

const AHORA = Date.parse('2026-09-01T02:00:00.000Z');
const hace = (ms: number) => new Date(AHORA - ms).toISOString();

function intento(status: PaymentReviewStatus, reviewedAt: string | null = null): AttemptView {
  return {
    id: `att-${status}-${reviewedAt ?? 'x'}`,
    status,
    statusLabel: status,
    tone: 'amber',
    openedAt: hace(60 * 60 * 1000),
    reviewedAt,
    proofCount: 1,
    proofs: [],
    canDecide: status === 'pending_review',
  };
}

function pago(attempts: AttemptView[]): PaymentView {
  return {
    attempts,
    unlinkedProofs: [],
    hasPendingReview: attempts.some((a) => a.canDecide),
  };
}

describe('la puerta del pago — cuándo se puede cocinar', () => {
  it('un pago aceptado abre la plancha', () => {
    const g = paymentGateOf('qr', pago([intento('accepted', hace(1000))]), AHORA);
    expect(g.state).toBe('accepted');
    expect(g.canStart).toBe(true);
  });

  it('un comprobante esperando revisión NO abre nada', () => {
    // El bug que esto corrige: se podía pulsar INICIAR sin mirar el comprobante.
    const g = paymentGateOf('qr', pago([intento('pending_review')]), AHORA);
    expect(g.state).toBe('awaiting_review');
    expect(g.canStart).toBe(false);
  });

  it('un comprobante RECHAZADO no abre nada', () => {
    // El caso más grave del anterior: se podía cocinar un pago ya rechazado.
    const g = paymentGateOf('qr', pago([intento('rejected', hace(1000))]), AHORA);
    expect(g.canStart).toBe(false);
  });

  it('sin ningún comprobante todavía, no se cocina', () => {
    expect(paymentGateOf('qr', pago([]), AHORA).state).toBe('no_proof');
    expect(paymentGateOf('qr', pago([]), AHORA).canStart).toBe(false);
  });

  it('efectivo y pedidos históricos entran como siempre', () => {
    // Exigirles comprobante los dejaría bloqueados para siempre.
    for (const metodo of ['cash', null] as const) {
      const g = paymentGateOf(metodo, null, AHORA);
      expect(g.state, String(metodo)).toBe('not_required');
      expect(g.canStart, String(metodo)).toBe(true);
    }
  });
});

describe('la puerta del pago — ante la duda, se cocina', () => {
  it('si no se pudo consultar el pago, se permite iniciar', () => {
    // Cerrar aquí detendría el servicio entero por un fallo de la base, sin
    // ninguna forma de saltarse la puerta desde una tablet.
    const g = paymentGateOf('qr', null, AHORA);
    expect(g.state).toBe('unknown');
    expect(g.canStart).toBe(true);
  });

  it('`unknown` NUNCA cancela un pedido', () => {
    // Abrir la puerta ante la duda y cancelar ante la duda son cosas opuestas.
    expect(shouldCancelForExpiry('qr', null, AHORA)).toBe(false);
  });
});

describe('la ventana de gracia tras un rechazo', () => {
  it('dentro de los 15 minutos el pedido sigue vivo, sin poder cocinarse', () => {
    const g = paymentGateOf('qr', pago([intento('rejected', hace(5 * 60 * 1000))]), AHORA);
    expect(g.state).toBe('rejected_grace');
    expect(g.canStart).toBe(false);
    expect(g.graceEndsAtMs).toBe(AHORA - 5 * 60 * 1000 + REJECTION_GRACE_MS);
  });

  it('pasados los 15 minutos sin reenvío, expira', () => {
    const g = paymentGateOf('qr', pago([intento('rejected', hace(16 * 60 * 1000))]), AHORA);
    expect(g.state).toBe('expired');
    expect(g.canStart).toBe(false);
    expect(shouldCancelForExpiry('qr', pago([intento('rejected', hace(16 * 60 * 1000))]), AHORA))
      .toBe(true);
  });

  it('justo en el minuto 15 ya venció: el plazo prometido es el plazo', () => {
    const g = paymentGateOf('qr', pago([intento('rejected', hace(REJECTION_GRACE_MS))]), AHORA);
    expect(g.state).toBe('expired');
  });

  it('EL REENVÍO PARA EL RELOJ aunque nadie lo haya mirado', () => {
    // El cliente reenvió en el minuto 14. Aunque la cocina tarde otros diez en
    // abrirlo, el pedido no puede morir: cumplió su parte.
    const p = pago([intento('rejected', hace(20 * 60 * 1000)), intento('pending_review')]);
    const g = paymentGateOf('qr', p, AHORA);
    expect(g.state).toBe('awaiting_review');
    expect(shouldCancelForExpiry('qr', p, AHORA)).toBe(false);
  });

  it('cada rechazo abre una ventana LIMPIA', () => {
    // Dos rechazos: cuenta el más reciente, porque cada uno viene con su propio
    // aviso al cliente prometiéndole quince minutos.
    const p = pago([
      intento('rejected', hace(60 * 60 * 1000)),
      intento('rejected', hace(2 * 60 * 1000)),
    ]);
    expect(paymentGateOf('qr', p, AHORA).state).toBe('rejected_grace');
  });

  it('un pago aceptado después de un rechazo manda: el pedido está pagado', () => {
    const p = pago([intento('rejected', hace(60 * 60 * 1000)), intento('accepted', hace(1000))]);
    const g = paymentGateOf('qr', p, AHORA);
    expect(g.state).toBe('accepted');
    expect(g.canStart).toBe(true);
  });

  it('un rechazo sin fecha de revisión no vence nunca solo', () => {
    // La coherencia de 0021 lo impide en la base, pero si llegara una fila así
    // no se inventa un vencimiento: cancelar por una fecha ilegible sería
    // matar un pedido por un dato roto nuestro.
    const g = paymentGateOf('qr', pago([intento('rejected', null)]), AHORA);
    expect(g.state).toBe('no_proof');
    expect(g.canStart).toBe(false);
  });
});
