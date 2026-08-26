import { describe, it, expect } from 'vitest';
import {
  ASSOCIATION_METHOD_LABELS,
  REVIEW_STATUS_LABELS,
  ROUTING_EXCEPTION_LABELS,
  associationMethodLabel,
  reviewStatusLabel,
  routingExceptionLabel,
} from './labels';
import {
  PAYMENT_REVIEW_STATUSES,
  PROOF_ASSOCIATION_METHODS,
  PROOF_ROUTING_EXCEPTIONS,
} from '@/types';

describe('etiquetas humanas — cobertura completa', () => {
  it('todo estado, método y excepción tiene su etiqueta', () => {
    for (const s of PAYMENT_REVIEW_STATUSES) expect(REVIEW_STATUS_LABELS[s], s).toBeTruthy();
    for (const m of PROOF_ASSOCIATION_METHODS) expect(ASSOCIATION_METHOD_LABELS[m], m).toBeTruthy();
    for (const e of PROOF_ROUTING_EXCEPTIONS) expect(ROUTING_EXCEPTION_LABELS[e], e).toBeTruthy();
  });

  it('ninguna etiqueta filtra el valor técnico crudo', () => {
    const crudos = [...PROOF_ASSOCIATION_METHODS, ...PROOF_ROUTING_EXCEPTIONS];
    const etiquetas = [
      ...Object.values(ASSOCIATION_METHOD_LABELS),
      ...Object.values(ROUTING_EXCEPTION_LABELS),
    ];
    for (const etiqueta of etiquetas) {
      for (const crudo of crudos) expect(etiqueta, etiqueta).not.toContain(crudo);
    }
  });

  it('usa el texto del contrato §3.3', () => {
    expect(ASSOCIATION_METHOD_LABELS.reply_to_qr).toBe('Vinculado por respuesta al QR');
    expect(ASSOCIATION_METHOD_LABELS.single_open_qr_order).toBe('Vinculado por pedido único abierto');
    expect(ASSOCIATION_METHOD_LABELS.duplicate).toBe('Comprobante duplicado');
    expect(REVIEW_STATUS_LABELS.pending_review).toBe('Pendiente de revisión');
    expect(REVIEW_STATUS_LABELS.accepted).toBe('Pago confirmado');
    expect(REVIEW_STATUS_LABELS.rejected).toBe('Pago rechazado');
  });
});

describe('etiquetas — valores ausentes', () => {
  it('null devuelve null, no una cadena rara', () => {
    expect(associationMethodLabel(null)).toBeNull();
    expect(routingExceptionLabel(null)).toBeNull();
  });

  it('un estado desconocido no rompe el panel', () => {
    expect(reviewStatusLabel('inventado' as never)).toBe('Estado desconocido');
  });
});
