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
import type { DeliveryType } from '@/types';
import type { ReviewDecision } from './review-result';

/**
 * La parte que no cambia. Se conserva como constante porque es la marca por la
 * que este aviso se reconoce, y porque las dos variantes tienen que empezar
 * igual: lo primero que el cliente necesita leer es que su pago entró.
 */
export const PAYMENT_ACCEPTED_TEXT =
  'Pago confirmado ✅. Tu pedido está siendo preparado.';

/**
 * Y la parte que sí cambia: qué pasa AHORA, que es distinto según cómo lo
 * reciba.
 *
 * Sin esto, a quien va a recoger se le dejaba esperando en casa una moto que
 * nunca iba a salir, y a quien pidió delivery sin saber que el repartidor lo va
 * a llamar. Es la misma frase para dos situaciones que no se parecen.
 *
 * `pickup` no promete una hora: la cocina acaba de empezar y darle un plazo
 * sería inventarlo.
 */
const PAYMENT_ACCEPTED_NEXT: Record<DeliveryType, string> = {
  delivery: 'El delivery tiene tu número y te llamará cuando llegue con tu pedido.',
  pickup: 'Te esperamos con el chat en mano cuando vengas a recogerlo.',
};

export const PAYMENT_REJECTED_TEXT =
  'No pudimos confirmar el pago con el comprobante enviado. ' +
  'Por favor, verifica que corresponda a este pedido y envía un nuevo comprobante ' +
  'respondiendo al mismo QR. No necesitas crear otro pedido.';

/**
 * Texto que corresponde a la decision tomada.
 *
 * `deliveryType` es opcional y su ausencia NO se rellena: sin saber cómo lo
 * recibe, se manda el aviso a secas antes que arriesgar decirle que lo espere
 * en la puerta cuando iba a pasar a buscarlo.
 */
export function paymentDecisionText(
  decision: ReviewDecision,
  deliveryType: DeliveryType | null = null,
): string {
  if (decision !== 'accept') return PAYMENT_REJECTED_TEXT;
  if (deliveryType === null) return PAYMENT_ACCEPTED_TEXT;
  return `${PAYMENT_ACCEPTED_TEXT} ${PAYMENT_ACCEPTED_NEXT[deliveryType]}`;
}
