/**
 * Traduccion al lenguaje del operador — modulo PURO.
 *
 * El panel NUNCA muestra el valor tecnico crudo (`single_open_qr_order`,
 * `payment_already_accepted`) si existe una etiqueta humana. Quien revisa un
 * pago a las nueve de la noche no tiene por que descifrar un enum.
 */
import type {
  PaymentReviewStatus,
  ProofAssociationMethod,
  ProofRoutingException,
} from '@/types';

/** Estado de revision del intento, tal como se titula en el panel. */
export const REVIEW_STATUS_LABELS: Record<PaymentReviewStatus, string> = {
  pending_review: 'Pendiente de revisión',
  accepted: 'Pago confirmado',
  rejected: 'Pago rechazado',
};

/** Como se asocio el comprobante con el pedido. */
export const ASSOCIATION_METHOD_LABELS: Record<ProofAssociationMethod, string> = {
  reply_to_qr: 'Vinculado por respuesta al QR',
  single_open_qr_order: 'Vinculado por pedido único abierto',
  duplicate: 'Comprobante duplicado',
  ambiguous: 'Asociación ambigua; requiere revisión',
  unresolved: 'No se pudo asociar automáticamente',
};

/** Por que no se pudo enrutar a un intento. */
export const ROUTING_EXCEPTION_LABELS: Record<ProofRoutingException, string> = {
  signal_conflict: 'Señal conflictiva: responde a un pedido que no coincide',
  expired_target: 'El pedido señalado está fuera de plazo',
  payment_already_accepted: 'Ese pedido ya tiene un pago confirmado',
  closed_order: 'El pedido ya estaba cerrado',
};

export function reviewStatusLabel(status: PaymentReviewStatus): string {
  return REVIEW_STATUS_LABELS[status] ?? 'Estado desconocido';
}

export function associationMethodLabel(method: ProofAssociationMethod | null): string | null {
  return method === null ? null : (ASSOCIATION_METHOD_LABELS[method] ?? null);
}

export function routingExceptionLabel(exception: ProofRoutingException | null): string | null {
  return exception === null ? null : (ROUTING_EXCEPTION_LABELS[exception] ?? null);
}

/** Tono visual del estado. Nunca comunica solo con color: va con su etiqueta. */
export type ReviewTone = 'amber' | 'green' | 'red';

export const REVIEW_STATUS_TONES: Record<PaymentReviewStatus, ReviewTone> = {
  pending_review: 'amber',
  accepted: 'green',
  rejected: 'red',
};
