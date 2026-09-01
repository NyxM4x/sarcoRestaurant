import { describe, it, expect } from 'vitest';
import {
  PROOF_TARGET_TTL_MS,
  decideAssociation,
  type ProofCandidateOrder,
} from './association';
import type { OrderStatus } from '@/types';

const NOW = Date.parse('2026-08-26T18:00:00.000Z');
const hace = (ms: number) => new Date(NOW - ms).toISOString();

function order(
  orderId: string,
  over: Partial<ProofCandidateOrder> = {},
): ProofCandidateOrder {
  return {
    orderId,
    status: 'confirmed' as OrderStatus,
    paymentMethod: 'qr',
    openedAt: hace(10 * 60_000),
    hasAcceptedPayment: false,
    // Sin ventana de gracia corriendo: el caso normal.
    rejectionGraceEndsAtMs: null,
    ...over,
  };
}

const base = { replyToOrderId: null, duplicateOfProofId: null, nowMs: NOW };

describe('asociación — respuesta directa al QR', () => {
  it('el pedido señalado por el cliente gana y habilita el intento', () => {
    const d = decideAssociation({
      ...base,
      replyToOrderId: 'A',
      candidates: [order('A'), order('B')],
    });
    expect(d).toEqual({
      orderId: 'A',
      method: 'reply_to_qr',
      routingException: null,
      duplicateOfProofId: null,
      attemptEligible: true,
    });
  });

  it('la respuesta manda aunque haya otros pedidos abiertos (no es ambiguo)', () => {
    const d = decideAssociation({
      ...base,
      replyToOrderId: 'B',
      candidates: [order('A'), order('B'), order('C')],
    });
    expect(d.orderId).toBe('B');
    expect(d.method).toBe('reply_to_qr');
  });
});

describe('asociación — pedido único abierto', () => {
  it('sin señal, un solo pedido QR abierto es inequívoco', () => {
    const d = decideAssociation({ ...base, candidates: [order('A')] });
    expect(d.method).toBe('single_open_qr_order');
    expect(d.orderId).toBe('A');
    expect(d.attemptEligible).toBe(true);
  });

  it('los pedidos que no son QR no cuentan como candidatos', () => {
    const d = decideAssociation({
      ...base,
      candidates: [order('A'), order('B', { paymentMethod: 'cash' }), order('C', { paymentMethod: null })],
    });
    expect(d.method).toBe('single_open_qr_order');
    expect(d.orderId).toBe('A');
  });
});

describe('asociación — ambigua y sin resolver', () => {
  it('dos pedidos abiertos sin señal es ambiguo y NO se asocia', () => {
    const d = decideAssociation({ ...base, candidates: [order('A'), order('B')] });
    expect(d).toEqual({
      orderId: null,
      method: 'ambiguous',
      routingException: null,
      duplicateOfProofId: null,
      attemptEligible: false,
    });
  });

  it('sin ningún candidato queda sin resolver', () => {
    const d = decideAssociation({ ...base, candidates: [] });
    expect(d.method).toBe('unresolved');
    expect(d.orderId).toBeNull();
    expect(d.attemptEligible).toBe(false);
  });
});

describe('excepciones de enrutamiento', () => {
  it('señal conflictiva: responde a un pedido que no reconocemos', () => {
    const d = decideAssociation({
      ...base,
      replyToOrderId: 'DESCONOCIDO',
      candidates: [order('A')],
    });
    expect(d.routingException).toBe('signal_conflict');
    expect(d.attemptEligible).toBe(false);
    // No se fuerza el único abierto: eso pagaría otro pedido.
    expect(d.orderId).toBeNull();
  });

  it('pedido cerrado (entregado o cancelado)', () => {
    for (const status of ['delivered', 'cancelled'] as const) {
      const d = decideAssociation({
        ...base,
        replyToOrderId: 'A',
        candidates: [order('A', { status })],
      });
      expect(d.routingException, status).toBe('closed_order');
      expect(d.attemptEligible).toBe(false);
    }
  });

  it('pago ya aceptado tiene prioridad sobre "cerrado"', () => {
    const d = decideAssociation({
      ...base,
      replyToOrderId: 'A',
      candidates: [order('A', { status: 'delivered', hasAcceptedPayment: true })],
    });
    expect(d.routingException).toBe('payment_already_accepted');
  });

  it('objetivo vencido pasado el plazo', () => {
    const d = decideAssociation({
      ...base,
      replyToOrderId: 'A',
      candidates: [order('A', { openedAt: hace(PROOF_TARGET_TTL_MS + 60_000) })],
    });
    expect(d.routingException).toBe('expired_target');
  });

  it('justo dentro del plazo todavía vale', () => {
    const d = decideAssociation({
      ...base,
      replyToOrderId: 'A',
      candidates: [order('A', { openedAt: hace(PROOF_TARGET_TTL_MS - 1_000) })],
    });
    expect(d.routingException).toBeNull();
    expect(d.attemptEligible).toBe(true);
  });

  it('una fecha ilegible no inventa un vencimiento', () => {
    const d = decideAssociation({
      ...base,
      replyToOrderId: 'A',
      candidates: [order('A', { openedAt: 'no-es-fecha' })],
    });
    expect(d.routingException).toBeNull();
  });

  it('sin señal y con un único candidato bloqueado, se informa la razón', () => {
    const d = decideAssociation({
      ...base,
      candidates: [order('A', { hasAcceptedPayment: true })],
    });
    expect(d.method).toBe('unresolved');
    expect(d.routingException).toBe('payment_already_accepted');
    expect(d.orderId).toBe('A');
    expect(d.attemptEligible).toBe(false);
  });
});

describe('duplicados', () => {
  it('el mismo contenido se marca como duplicado y no alimenta un intento', () => {
    const d = decideAssociation({
      ...base,
      replyToOrderId: 'A',
      candidates: [order('A')],
      duplicateOfProofId: 'proof-original',
    });
    expect(d).toEqual({
      orderId: 'A',
      method: 'duplicate',
      routingException: null,
      duplicateOfProofId: 'proof-original',
      attemptEligible: false,
    });
  });

  it('el duplicado gana sobre cualquier otra señal', () => {
    const d = decideAssociation({
      ...base,
      candidates: [order('A'), order('B')], // sería ambiguo
      duplicateOfProofId: 'proof-original',
    });
    expect(d.method).toBe('duplicate');
  });
});

describe('invariante del contrato §3.4', () => {
  it('NUNCA se habilita un intento cuando hay excepción de enrutamiento', () => {
    // Recorre todas las combinaciones que producen excepción.
    const casos = [
      { replyToOrderId: 'X', candidates: [order('A')] },
      { replyToOrderId: 'A', candidates: [order('A', { status: 'cancelled' as OrderStatus })] },
      { replyToOrderId: 'A', candidates: [order('A', { hasAcceptedPayment: true })] },
      { replyToOrderId: 'A', candidates: [order('A', { openedAt: hace(PROOF_TARGET_TTL_MS * 2) })] },
      { replyToOrderId: null, candidates: [order('A', { hasAcceptedPayment: true })] },
    ];
    for (const caso of casos) {
      const d = decideAssociation({ ...base, ...caso });
      expect(d.routingException, JSON.stringify(caso)).not.toBeNull();
      // Ésta es la regla que la base protege con un CHECK.
      expect(d.attemptEligible).toBe(false);
    }
  });

  it('un duplicado siempre lleva su duplicate_of_id y nunca al revés', () => {
    const dup = decideAssociation({ ...base, candidates: [order('A')], duplicateOfProofId: 'p1' });
    expect(dup.method).toBe('duplicate');
    expect(dup.duplicateOfProofId).toBe('p1');

    const normal = decideAssociation({ ...base, candidates: [order('A')] });
    expect(normal.method).not.toBe('duplicate');
    expect(normal.duplicateOfProofId).toBeNull();
  });
});

// ── La ventana de gracia y el comprobante tardío (0028) ─────────────────────
//
// La cancelación por vencimiento se DERIVA al leer, así que `orders.status`
// sigue siendo `confirmed` hasta que alguien pulsa "Limpiar expirados". Si el
// enrutado no mirara el mismo reloj, un comprobante que llega tarde encontraría
// el pedido vivo y abriría un intento — y el desenlace dependería de quién leyó
// primero. Ese es el error que no se puede depurar ni explicar a un cliente.

describe('asociación — ventana de gracia vencida', () => {
  it('un comprobante que llega DESPUÉS del plazo no abre intento', () => {
    const d = decideAssociation({
      ...base,
      candidates: [order('A', { rejectionGraceEndsAtMs: NOW - 1 })],
    });
    expect(d.routingException).toBe('expired_target');
    expect(d.attemptEligible).toBe(false);
  });

  it('pero SÍ se registra: un comprobante nunca se pierde', () => {
    // `orderId` sigue apuntando al pedido, así que la fila es visible en el
    // panel y una persona decide. Lo único que no ocurre es el intento nuevo.
    const d = decideAssociation({
      ...base,
      candidates: [order('A', { rejectionGraceEndsAtMs: NOW - 1 })],
    });
    expect(d.orderId).toBe('A');
  });

  it('dentro del plazo, el comprobante entra con normalidad', () => {
    const d = decideAssociation({
      ...base,
      candidates: [order('A', { rejectionGraceEndsAtMs: NOW + 60_000 })],
    });
    expect(d.routingException).toBeNull();
    expect(d.attemptEligible).toBe(true);
  });

  it('justo al vencer ya está fuera: el plazo prometido es el plazo', () => {
    const d = decideAssociation({
      ...base,
      candidates: [order('A', { rejectionGraceEndsAtMs: NOW })],
    });
    expect(d.routingException).toBe('expired_target');
  });

  it('un pago ya aceptado explica mejor que el vencimiento', () => {
    // El orden de las excepciones importa: se informa la razón MÁS específica.
    const d = decideAssociation({
      ...base,
      candidates: [order('A', { hasAcceptedPayment: true, rejectionGraceEndsAtMs: NOW - 1 })],
    });
    expect(d.routingException).toBe('payment_already_accepted');
  });
});
