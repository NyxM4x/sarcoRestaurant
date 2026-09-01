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
import type { ProofAmountLabel, ProofAnalysisReason, ProofVerdict } from './analysis';

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

// ── Análisis automático del comprobante (0025) ──────────────────────────────

/**
 * Por qué saltó la alerta, dicho para quien tiene la plancha encendida.
 *
 * Cada texto nombra el HECHO concreto, no una categoría: "la cuenta que recibe
 * no es la nuestra" se puede comprobar abriendo el comprobante; "comprobante
 * sospechoso" no se puede comprobar de ninguna manera, y una alerta que no se
 * puede comprobar acaba pulsándose igual.
 */
export const ANALYSIS_REASON_LABELS: Record<ProofAnalysisReason, string> = {
  account_mismatch: 'La cuenta que recibe el dinero NO es la nuestra',
  holder_mismatch: 'El titular que cobra NO es el nuestro',
  bank_mismatch: 'El dinero entró en OTRO banco, no en el nuestro',
  reference_reused: 'Ese número de transacción ya se usó en otro comprobante',
  stale_receipt: 'El comprobante es de otro momento, no de este pedido',
  not_a_receipt: 'La imagen no parece un comprobante de pago',
  unreadable: 'No se pudo leer el comprobante',
  amount_mismatch: 'El monto no coincide ni con los productos ni con el total',
};

export function analysisReasonLabel(reason: ProofAnalysisReason): string {
  return ANALYSIS_REASON_LABELS[reason] ?? 'Revisar el comprobante';
}

// ── Qué pagó: la etiqueta que responde al repartidor (0028) ─────────────────

/**
 * Las tres respuestas posibles a "¿este ya me pagó la carrera?".
 *
 * En MAYÚSCULAS y cortas porque se leen de lejos, en una tablet, mientras
 * alguien espera en la puerta. Es la única etiqueta del ticket que no la lee
 * quien cocina sino quien reparte, a través de quien cocina.
 */
export const AMOUNT_LABEL_TEXTS: Record<ProofAmountLabel, string> = {
  pago_total: 'PAGO TOTAL',
  pago_productos: 'PAGO PRODUCTOS',
  revisar_monto: 'REVISAR MONTO',
};

/**
 * Qué significa cada una, para quien no la conoce todavía.
 *
 * El texto de `pago_productos` nombra la acción, no el estado: "falta cobrar el
 * envío" es lo que hay que hacer al llegar, y "pagó solo los productos" obliga
 * a deducirlo. En la puerta de una casa, con el pedido en la mano, no se deduce.
 */
export const AMOUNT_LABEL_HINTS: Record<ProofAmountLabel, string> = {
  pago_total: 'Ya pagó el envío: no cobrar nada al entregar',
  pago_productos: 'Falta cobrar el envío al entregar',
  revisar_monto: 'El monto no cuadra: abrir el comprobante antes de cocinar',
};

export function amountLabelText(label: ProofAmountLabel | null): string | null {
  return label === null ? null : (AMOUNT_LABEL_TEXTS[label] ?? null);
}

export function amountLabelHint(label: ProofAmountLabel | null): string | null {
  return label === null ? null : (AMOUNT_LABEL_HINTS[label] ?? null);
}

/**
 * Tono de la etiqueta. `pago_total` es verde porque no hay nada que hacer;
 * `pago_productos` NO es una alerta —es el caso normal en delivery— así que va
 * en azul, no en ámbar: teñir de aviso el comportamiento esperado gasta la
 * atención que necesita el rojo.
 */
export const AMOUNT_LABEL_TONES: Record<ProofAmountLabel, 'green' | 'blue' | 'red'> = {
  pago_total: 'green',
  pago_productos: 'blue',
  revisar_monto: 'red',
};

/**
 * Título del aviso según el veredicto.
 *
 * `ok` NO tiene título: un comprobante que cuadra no merece un cartel. La
 * pantalla del KDS es pequeña y cada aviso que no dice nada le quita sitio a
 * uno que sí. Solo se habla cuando hay algo que mirar.
 */
export const VERDICT_HEADLINES: Record<ProofVerdict, string | null> = {
  ok: null,
  suspicious: 'Revisar este comprobante',
  unreadable: 'No se pudo leer el comprobante',
};

export function verdictHeadline(verdict: ProofVerdict): string | null {
  return VERDICT_HEADLINES[verdict] ?? null;
}
