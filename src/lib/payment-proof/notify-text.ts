/**
 * Textos del aviso al cliente tras revisar su pago — modulo PURO.
 *
 * Viven aparte del flujo de decision para poder revisarlos de un vistazo y
 * probarlos sin red: son lo unico de todo esto que lee un cliente real.
 *
 * El texto de rechazo evita culpar al cliente y le dice exactamente que hacer
 * ("responde al mismo QR"), porque la alternativa —que cree otro pedido— nos
 * deja dos pedidos y un comprobante ambiguo.
 */
import type { ReviewDecision } from './review-result';

export const PAYMENT_ACCEPTED_TEXT =
  'Pago confirmado ✅. Tu pedido está siendo preparado.';

export const PAYMENT_REJECTED_TEXT =
  'No pudimos confirmar el pago con el comprobante enviado. ' +
  'Por favor, verifica que corresponda a este pedido y envía un nuevo comprobante ' +
  'respondiendo al mismo QR. No necesitas crear otro pedido.';

/** Texto que corresponde a la decision tomada. */
export function paymentDecisionText(decision: ReviewDecision): string {
  return decision === 'accept' ? PAYMENT_ACCEPTED_TEXT : PAYMENT_REJECTED_TEXT;
}
