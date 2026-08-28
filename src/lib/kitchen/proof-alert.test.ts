import { describe, it, expect } from 'vitest';
import { proofAlertOf } from './proof-alert';
import type { PaymentView, ProofView } from '@/lib/dashboard/attempt-review';

function proof(id: string, analysis: ProofView['analysis'] = null): ProofView {
  return {
    id,
    receivedAt: '2026-08-27T20:05:00.000Z',
    associationLabel: null,
    exceptionLabel: null,
    isDuplicate: false,
    isImage: true,
    isAvailable: true,
    mimeType: 'image/jpeg',
    filename: `comprobante-${id}.jpg`,
    declaredLabel: null,
    analysis,
  };
}

const SOSPECHOSO: ProofView['analysis'] = {
  verdict: 'suspicious',
  headline: 'Revisar este comprobante',
  reasons: ['Pagó menos de lo que debía'],
};

const ILEGIBLE: ProofView['analysis'] = {
  verdict: 'unreadable',
  headline: 'No se pudo leer el comprobante',
  reasons: ['No se pudo leer el comprobante'],
};

function pago(proofs: ProofView[], over: Partial<PaymentView['attempts'][0]> = {}): PaymentView {
  return {
    attempts: [
      {
        id: 'a1',
        status: 'pending_review',
        statusLabel: 'Pendiente de revisión',
        tone: 'amber',
        openedAt: '2026-08-27T20:05:00.000Z',
        reviewedAt: null,
        proofCount: proofs.length,
        proofs,
        canDecide: true,
        ...over,
      },
    ],
    unlinkedProofs: [],
    hasPendingReview: true,
  };
}

describe('aviso del análisis en el ticket', () => {
  it('sin pago o sin análisis no dice nada', () => {
    expect(proofAlertOf(null)).toBeNull();
    expect(proofAlertOf(pago([proof('p1')]))).toBeNull();
  });

  it('un comprobante sospechoso saca el aviso rojo con sus motivos', () => {
    expect(proofAlertOf(pago([proof('p1', SOSPECHOSO)]))).toEqual({
      headline: 'Revisar este comprobante',
      reasons: ['Pagó menos de lo que debía'],
      tone: 'red',
    });
  });

  it('uno ilegible avisa en ámbar: no es lo mismo que uno que no cuadra', () => {
    // Acusar a una foto borrosa de lo mismo que a un monto cambiado gastaría la
    // única alerta que de verdad importa.
    expect(proofAlertOf(pago([proof('p1', ILEGIBLE)]))?.tone).toBe('amber');
  });

  it('con varios, gana el peor', () => {
    const alerta = proofAlertOf(pago([proof('p1', ILEGIBLE), proof('p2', SOSPECHOSO)]));
    expect(alerta?.tone).toBe('red');
    // Y solo se cuentan los motivos del que manda: mezclar "no se pudo leer" con
    // "pagó de menos" haría dudar de las dos cosas.
    expect(alerta?.reasons).toEqual(['Pagó menos de lo que debía']);
  });

  it('no repite un motivo que aparece en dos comprobantes', () => {
    const alerta = proofAlertOf(pago([proof('p1', SOSPECHOSO), proof('p2', SOSPECHOSO)]));
    expect(alerta?.reasons).toEqual(['Pagó menos de lo que debía']);
  });

  it('se retira en cuanto el pago está decidido', () => {
    // El aviso existe para ayudar a decidir. Decidido, ya cumplió: dejarlo
    // puesto convierte la tarjeta en un cartel rojo que no pide nada, y en
    // cocina eso enseña a ignorar los avisos.
    for (const status of ['accepted', 'rejected'] as const) {
      const decidido = pago([proof('p1', SOSPECHOSO)], {
        status,
        canDecide: false,
        reviewedAt: '2026-08-27T20:10:00.000Z',
      });
      expect(proofAlertOf(decidido), status).toBeNull();
    }
  });

  it('un comprobante sin asociar avisa igual, aunque no haya intento', () => {
    // Llegó algo que nadie ha podido enlazar y que además no cuadra: es
    // exactamente lo que no puede pasar desapercibido.
    const suelto: PaymentView = {
      attempts: [],
      unlinkedProofs: [proof('p9', SOSPECHOSO)],
      hasPendingReview: false,
    };
    expect(proofAlertOf(suelto)?.tone).toBe('red');
  });
});
