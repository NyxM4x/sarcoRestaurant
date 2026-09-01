import { describe, it, expect } from 'vitest';
import { selectExpiredOrders, SWEEPABLE_STATUSES, type ExpiryCandidate } from './expiry-sweep';
import { REJECTION_GRACE_MS } from './payment-gate';
import type { AttemptView, PaymentView } from '@/lib/dashboard/attempt-review';
import type { OrderStatus, PaymentReviewStatus } from '@/types';

const AHORA = Date.parse('2026-09-01T03:00:00.000Z');
const hace = (ms: number) => new Date(AHORA - ms).toISOString();

function intento(status: PaymentReviewStatus, reviewedAt: string | null): AttemptView {
  return {
    id: `att-${status}`,
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

const pago = (attempts: AttemptView[]): PaymentView => ({
  attempts,
  unlinkedProofs: [],
  hasPendingReview: attempts.some((a) => a.canDecide),
});

/** Rechazado hace 20 minutos: fuera de plazo. */
const VENCIDO = pago([intento('rejected', hace(20 * 60 * 1000))]);

const candidato = (over: Partial<ExpiryCandidate> = {}): ExpiryCandidate => ({
  orderId: 'ord-1',
  orderNumber: 'ORD-260901-001',
  status: 'confirmed',
  paymentMethod: 'qr',
  payment: VENCIDO,
  ...over,
});

describe('barrido de vencidos — qué se cancela', () => {
  it('un pedido rechazado y fuera de plazo entra en el barrido', () => {
    expect(selectExpiredOrders([candidato()], AHORA).map((c) => c.orderId)).toEqual(['ord-1']);
  });

  it('dentro del plazo NO se cancela', () => {
    const dentro = pago([intento('rejected', hace(REJECTION_GRACE_MS - 60_000))]);
    expect(selectExpiredOrders([candidato({ payment: dentro })], AHORA)).toEqual([]);
  });

  it('si el cliente reenvió, el pedido se salva aunque nadie lo haya mirado', () => {
    const reenviado = pago([
      intento('rejected', hace(60 * 60 * 1000)),
      intento('pending_review', null),
    ]);
    expect(selectExpiredOrders([candidato({ payment: reenviado })], AHORA)).toEqual([]);
  });

  it('un pago aceptado nunca se barre', () => {
    const aceptado = pago([
      intento('rejected', hace(60 * 60 * 1000)),
      intento('accepted', hace(1000)),
    ]);
    expect(selectExpiredOrders([candidato({ payment: aceptado })], AHORA)).toEqual([]);
  });
});

describe('barrido de vencidos — qué NO se toca nunca', () => {
  it('lo que ya está en la plancha se queda', () => {
    // Cancelar algo empezado no devuelve la comida al refrigerador: solo deja a
    // quien cocina sin saber qué estaba haciendo.
    for (const status of ['preparing', 'ready', 'on_the_way', 'delivered'] as OrderStatus[]) {
      expect(selectExpiredOrders([candidato({ status })], AHORA), status).toEqual([]);
    }
  });

  it('un pedido ya cancelado no se vuelve a cancelar', () => {
    expect(selectExpiredOrders([candidato({ status: 'cancelled' })], AHORA)).toEqual([]);
  });

  it('un pago que NO se pudo leer nunca cancela', () => {
    // Abrir la puerta ante la duda y cancelar ante la duda son cosas opuestas.
    expect(selectExpiredOrders([candidato({ payment: null })], AHORA)).toEqual([]);
  });

  it('efectivo e históricos quedan fuera: no esperan ningún comprobante', () => {
    for (const metodo of ['cash', null] as const) {
      expect(selectExpiredOrders([candidato({ paymentMethod: metodo })], AHORA), String(metodo))
        .toEqual([]);
    }
  });

  it('los estados barribles son solo los dos que no entraron en cocina', () => {
    expect([...SWEEPABLE_STATUSES].sort()).toEqual(['awaiting_location', 'confirmed']);
  });
});
