import type { DeliveryType } from '@/types';
import { formatBs } from '@/lib/orders/calculate';
// La MISMA promesa que recibe quien paga por QR al aceptarse su comprobante,
// importada y no recopiada. Ver `cashOrderConfirmedText`.
import { PAYMENT_ACCEPTED_NEXT } from '@/lib/payment-proof/notify-text';
import {
  CONFIRMATION_DELIVERY_LABEL,
  CONFIRMATION_FOOD_LABEL,
  CONFIRMATION_TOTAL_LABEL,
  DYNAMIC_CONFIRMATION_PREFIX,
  ORDER_RECEIVED_PREFIX,
} from '@/lib/kapso/outbound-classify';
/**
 * El cliente ve el número CORTO ("#7"), no el interno (`ORD-260828-007`).
 *
 * Es el número que oirá gritar cuando recoja, el que dirá por teléfono y el
 * único que le sirve para algo esta noche. Los prefijos canónicos NO se tocan:
 * siguen siendo la marca con la que el clasificador reconoce cada mensaje.
 */
import { shortOrderNumber } from '@/lib/orders/order-number';

/**
 * Construcción de los textos de confirmación del checkout web — módulo puro.
 *
 * Solo usa datos NO sensibles del pedido: número, nombres snapshot y montos.
 * Nunca teléfono, phone_number_id, session token, IDs internos ni wamid. Los
 * montos se formatean con `formatBs` (única fuente de formato de dinero).
 */

/** Línea de producto tal como se muestra en el resumen. */
export interface NotifyItem {
  product_name_snapshot: string;
  quantity: number;
  subtotal: number;
}

export interface ConfirmationTextInput {
  order_number: string;
  delivery_type: DeliveryType;
  subtotal_amount: number;
  total_amount: number;
  items: NotifyItem[];
}

/** Resultado tipado: un pedido sin ítems no produce texto (no lanza). */
export type ConfirmationTextResult =
  | { ok: true; text: string }
  | { ok: false; reason: 'missing_items' };

/**
 * Orden determinístico e independiente del orden de entrada: por nombre
 * snapshot, luego cantidad, luego subtotal. Así el mismo pedido siempre genera
 * exactamente el mismo texto.
 */
function sortItems(items: NotifyItem[]): NotifyItem[] {
  return [...items].sort((a, b) => {
    if (a.product_name_snapshot < b.product_name_snapshot) return -1;
    if (a.product_name_snapshot > b.product_name_snapshot) return 1;
    if (a.quantity !== b.quantity) return a.quantity - b.quantity;
    return a.subtotal - b.subtotal;
  });
}

function itemLines(items: NotifyItem[]): string[] {
  return sortItems(items).map(
    (it) => `• ${it.quantity}x ${it.product_name_snapshot} — ${formatBs(it.subtotal)}`,
  );
}

/**
 * Texto de confirmación según el tipo de entrega.
 *
 * - pickup: confirma la recogida en el local, sin pedir ubicación.
 * - delivery: muestra el subtotal, deja el envío por confirmar y pide compartir
 *   la ubicación (el `location_request_message` nativo va aparte, por Kapso).
 */
export function buildConfirmationText(input: ConfirmationTextInput): ConfirmationTextResult {
  if (input.items.length === 0) return { ok: false, reason: 'missing_items' };

  const lines = itemLines(input.items);

  if (input.delivery_type === 'pickup') {
    return {
      ok: true,
      text: [
        `📦 ¡Recibí tu pedido ${shortOrderNumber(input.order_number)}!`,
        '',
        'Tu pedido quedó confirmado para recoger en el local.',
        '',
        'Resumen:',
        ...lines,
        '',
        `Total: ${formatBs(input.total_amount)}`,
      ].join('\n'),
    };
  }

  return {
    ok: true,
    text: [
      `📦 ¡Recibí tu pedido ${shortOrderNumber(input.order_number)}!`,
      '',
      'Resumen:',
      ...lines,
      '',
      `Subtotal: ${formatBs(input.subtotal_amount)}`,
      'Envío: por confirmar',
      '',
      '📍 Ahora comparte tu ubicación para calcular el costo del envío.',
    ].join('\n'),
  };
}

/**
 * Mensaje de RECEPCIÓN del pedido (Fase 6D.2C) — el PRIMERO del flujo dinámico.
 *
 * Se envía antes de la solicitud de ubicación y NO significa que el pedido esté
 * confirmado (sigue `awaiting_location`). NO lleva QR, ni delivery, ni total: aún
 * no se conoce el costo del envío. El prefijo `ORDER_RECEIVED_PREFIX` es la marca
 * canónica que el clasificador usa para distinguirlo de la confirmación final.
 */
export function buildOrderReceivedText(orderNumber: string): string {
  return [
    `${ORDER_RECEIVED_PREFIX}${shortOrderNumber(orderNumber)}.`,
    '',
    'Ahora necesitamos tu ubicación para calcular el costo de delivery.',
  ].join('\n');
}

/**
 * Confirmación de un delivery DINÁMICO ya cotizado (Fase 6D.2C).
 *
 * Se envía SOLO después de que `apply_delivery_quote` dejó el pedido `quoted`,
 * así que ya hay montos reales: comida (subtotal), delivery (cotizado) y total.
 * NO muestra kilómetros, tarifa por km, fórmula ni nada de Mapbox: el cliente
 * solo ve dinero. No lista ítems (el resumen del carrito ya se mostró en el
 * checkout web); este mensaje es el cierre con el costo final del envío.
 */
export interface DynamicDeliveryConfirmationInput {
  order_number: string;
  subtotal_amount: number;
  delivery_amount: number;
  total_amount: number;
}

export function buildDynamicDeliveryConfirmationText(
  input: DynamicDeliveryConfirmationInput,
): string {
  return [
    `${DYNAMIC_CONFIRMATION_PREFIX}${shortOrderNumber(input.order_number)}`,
    '',
    `${CONFIRMATION_FOOD_LABEL} ${formatBs(input.subtotal_amount)}`,
    `${CONFIRMATION_DELIVERY_LABEL} ${formatBs(input.delivery_amount)}`,
    `${CONFIRMATION_TOTAL_LABEL} ${formatBs(input.total_amount)}`,
  ].join('\n');
}

/**
 * La confirmación de un pedido EN EFECTIVO (04-09-2026).
 *
 * La otra mitad de `buildQrPaymentCaption`. Hasta hoy el efectivo caía en la
 * rama de texto pelado y salía sin una sola palabra sobre el pago: el cliente
 * leía su pedido y su total, y no sabía si tenía que hacer algo o no.
 *
 * Dice la cifra ENTERA y con qué se compone, porque es lo que va a tener que
 * dar en la puerta —y lo que el repartidor va a pedirle—; el QR cobra solo la
 * comida, así que ahí la suma se parte y aquí no.
 *
 * Sin envío cotizado todavía (`deliveryAmount` en 0, o recojo) no se inventa un
 * total: se dice lo único cierto, que se paga al recibir.
 */
export function buildCashPaymentText(
  confirmationText: string,
  amounts?: { subtotal: number; deliveryAmount: number },
  deliveryType: DeliveryType | null = null,
): string {
  const confirmado = cashOrderConfirmedText(deliveryType);

  if (!amounts || amounts.deliveryAmount <= 0) {
    return `${confirmationText}\n\n💵 Pagas en efectivo al recibir tu pedido.\n\n${confirmado}`;
  }

  const total = amounts.subtotal + amounts.deliveryAmount;
  return [
    confirmationText,
    '',
    `💵 Pagas en EFECTIVO al recibir: ${formatBs(total)}`,
    `   (comida ${formatBs(amounts.subtotal)} + delivery ${formatBs(amounts.deliveryAmount)})`,
    'Ten el monto listo, por favor 🙌',
    '',
    confirmado,
  ].join('\n');
}

/**
 * "Tu pedido ya está confirmado" — lo que el de EFECTIVO no oía (05-09-2026).
 *
 * ── El agujero que tapa ─────────────────────────────────────────────────────
 *
 * Quien paga por QR recibe, en cuanto alguien acepta su comprobante: "Pago
 * confirmado ✅. Tu pedido está siendo preparado. El delivery tiene tu número y
 * te llamará cuando llegue". Ese aviso lo dispara la REVISIÓN DEL COMPROBANTE, y
 * un pedido en efectivo no tiene ninguno que revisar — así que no salía nunca.
 *
 * El cliente leía su total y se quedaba ahí, sin saber si su pedido había
 * quedado anotado. Y el que duda vuelve a escribir, o arma otro pedido: es
 * exactamente lo que pasó la madrugada del 05-09 con el #26, que terminó en dos
 * pedidos y dos envíos cobrados.
 *
 * ── Por qué NO dice "pago confirmado" ───────────────────────────────────────
 *
 * Porque no ha pagado nada. Lo que está confirmado es el PEDIDO, y decirle que
 * su pago está confirmado a alguien que va a pagar en la puerta es prometerle
 * algo que no ha ocurrido — y, peor, sembrar la duda de si tendrá que pagar.
 *
 * Lo que afirma sí es cierto: en efectivo la puerta del pago vale
 * `not_required`, así que la cocina puede arrancarlo ya, y el aviso al grupo de
 * reparto sale en ese mismo instante (`quote-service`, `cash_confirmed`).
 *
 * Sin saber cómo lo recibe (`null`) se calla la segunda frase, con el mismo
 * criterio que `paymentDecisionText`: antes eso que decirle que espere en la
 * puerta a quien iba a pasar a buscarlo.
 */
function cashOrderConfirmedText(deliveryType: DeliveryType | null): string {
  const confirmado = '✅ Tu pedido ya está confirmado y pasa a cocina.';
  return deliveryType === null
    ? confirmado
    : `${confirmado}\n${PAYMENT_ACCEPTED_NEXT[deliveryType]}`;
}

/**
 * Caption de la confirmación cuando el pago es por QR (Fase 6D.1). Reutiliza el
 * texto de confirmación completo (que YA incluye el número de pedido, clave para
 * reconciliar) y añade la indicación de pago. La imagen del QR viaja aparte (es
 * el propio mensaje); esto solo es su pie.
 *
 * ── Por QR se cobra la comida; el envío se paga al recibir ──────────────────
 *
 * El desglose ya se muestra arriba, y ahí conviven tres cifras. Decir solo
 * "escanea para pagar tu pedido" junto a un "Total: Bs 64" es pedirle al cliente
 * que transfiera 64 — y es lo que hacía. Por eso el importe a transferir se dice
 * EXPLÍCITO y con su número, en vez de dejarlo deducir del desglose.
 *
 * Que quede escrito en el mismo mensaje que el QR no es un detalle de redacción:
 * es lo que permite responder "se te avisó, y aquí está" cuando alguien discute
 * el cobro del envío en la puerta. Un segundo mensaje aparte podría no llegar, y
 * entonces el cliente tendría el QR y el total delante sin la advertencia.
 *
 * `deliveryAmount` en 0 —o un recojo— vuelve al texto simple: sin envío que
 * cobrar aparte, el cliente paga todo por QR y no hay nada que explicar.
 */
export function buildQrPaymentCaption(
  confirmationText: string,
  amounts?: { dueByQr: number; deliveryAmount: number },
): string {
  if (!amounts || amounts.deliveryAmount <= 0) {
    return `${confirmationText}\n\n💳 Escanea este QR para pagar tu pedido.`;
  }

  return [
    confirmationText,
    '',
    `💳 Escanea el QR y paga SOLO la comida: ${formatBs(amounts.dueByQr)}`,
    `🛵 Los ${formatBs(amounts.deliveryAmount)} del delivery los pagas al recibir tu pedido.`,
  ].join('\n');
}
