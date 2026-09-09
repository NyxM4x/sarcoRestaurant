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
  // Abierto hace cinco minutos: los casos de arriba van del RECHAZO, no de la
  // ventana del comprobante, que tiene los suyos al final.
  openedAt: hace(5 * 60 * 1000),
  createdAt: hace(5 * 60 * 1000),
  // Ya cotizado: estos casos van del pago, no del carrito abandonado.
  deliveryQuoteStatus: 'quoted',
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

describe('barrido de vencidos — el comprobante que nunca llegó (09-09-2026)', () => {
  /** Sin ningún intento: el pedido al que no le llegó nada. */
  const SIN_NADA = pago([]);

  it('un pedido de hace doce horas sin comprobante entra en el barrido', () => {
    const c = candidato({ payment: SIN_NADA, openedAt: hace(12 * 60 * 60 * 1000) });
    expect(selectExpiredOrders([c], AHORA).map((x) => x.orderId)).toEqual(['ord-1']);
  });

  it('dentro de las dos horas NO se toca: el cliente aún puede pagar', () => {
    const c = candidato({ payment: SIN_NADA, openedAt: hace(90 * 60 * 1000) });
    expect(selectExpiredOrders([c], AHORA)).toEqual([]);
  });

  it('al que nunca mandó su ubicación NO lo barre esta regla, sino la del carrito', () => {
    // La frontera entre las dos reglas. Sin `confirmed_at` no se le pidió pagar
    // nada, así que no hay comprobante que exigirle: la ventana del pago se
    // abstiene. Ese pedido lo cierra `isAbandonedCart`, y a los 45 minutos —ver
    // el describe del carrito abandonado, más abajo.
    const c = candidato({
      status: 'awaiting_location',
      payment: SIN_NADA,
      openedAt: null,
      createdAt: hace(5 * 60 * 60 * 1000),
      // Ya cotizado: aísla esta comprobación de la regla del carrito, que de
      // otro modo lo barrería y el test pasaría sin comprobar lo suyo.
      deliveryQuoteStatus: 'quoted',
    });
    expect(selectExpiredOrders([c], AHORA)).toEqual([]);
  });

  it('sin fecha de apertura no se cancela nada', () => {
    const c = candidato({ payment: SIN_NADA, openedAt: null });
    expect(selectExpiredOrders([c], AHORA)).toEqual([]);
  });

  it('lo que ya está en la plancha sigue intocable, por viejo que sea', () => {
    for (const status of ['preparing', 'ready', 'on_the_way'] as OrderStatus[]) {
      const c = candidato({ status, payment: SIN_NADA, openedAt: hace(12 * 60 * 60 * 1000) });
      expect(selectExpiredOrders([c], AHORA), status).toEqual([]);
    }
  });
});

describe('barrido de vencidos — el carrito que nunca se cotizó (09-09-2026)', () => {
  /** Un carrito esperando la ubicación, sin pago ninguno de por medio. */
  const carrito = (over: Partial<ExpiryCandidate> = {}) =>
    candidato({
      status: 'awaiting_location',
      payment: pago([]),
      openedAt: null,
      createdAt: hace(2 * 60 * 60 * 1000),
      deliveryQuoteStatus: 'pending',
      ...over,
    });

  it('el carrito en EFECTIVO entra: es el que nada podía cancelar', () => {
    // La puerta del pago le responde `not_required` y nunca puede vencerlo. Lo
    // alcanza la regla del pedido, que no mira el método de pago.
    const c = carrito({ paymentMethod: 'cash' });
    expect(selectExpiredOrders([c], AHORA).map((x) => x.orderId)).toEqual(['ord-1']);
  });

  it('y el carrito por QR también, por la misma regla', () => {
    const c = carrito({ paymentMethod: 'qr' });
    expect(selectExpiredOrders([c], AHORA).map((x) => x.orderId)).toEqual(['ord-1']);
  });

  it('fuera de cobertura en efectivo: dos había en producción', () => {
    const c = carrito({ paymentMethod: 'cash', deliveryQuoteStatus: 'out_of_coverage' });
    expect(selectExpiredOrders([c], AHORA).map((x) => x.orderId)).toEqual(['ord-1']);
  });

  it('el fallo de Mapbox NO se barre, ni en efectivo ni por QR', () => {
    for (const metodo of ['cash', 'qr'] as const) {
      const c = carrito({ paymentMethod: metodo, deliveryQuoteStatus: 'failed' });
      expect(selectExpiredOrders([c], AHORA), String(metodo)).toEqual([]);
    }
  });

  it('dentro de los 45 minutos no se toca, aunque sea en efectivo', () => {
    const c = carrito({ paymentMethod: 'cash', createdAt: hace(20 * 60 * 1000) });
    expect(selectExpiredOrders([c], AHORA)).toEqual([]);
  });

  it('un pedido en efectivo YA COTIZADO nunca se barre, por viejo que sea', () => {
    // Tiene su total y está en el tablero de cocina: cancelarlo por debajo
    // dejaría a quien cocina sin saber qué pasó con su comanda.
    const c = carrito({
      paymentMethod: 'cash',
      status: 'confirmed',
      deliveryQuoteStatus: 'quoted',
      openedAt: hace(12 * 60 * 60 * 1000),
      createdAt: hace(12 * 60 * 60 * 1000),
    });
    expect(selectExpiredOrders([c], AHORA)).toEqual([]);
  });
});
