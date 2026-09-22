import type { DeliveryType } from '@/types';
import { formatBs } from '@/lib/orders/calculate';
// La MISMA promesa que recibe quien paga por QR al aceptarse su comprobante,
// importada y no recopiada. Ver `orderConfirmedByCashText`.
import { PAYMENT_ACCEPTED_NEXT } from '@/lib/payment-proof/notify-text';
import {
  CONFIRMATION_DELIVERY_LABEL,
  CONFIRMATION_FOOD_LABEL,
  CONFIRMATION_TOTAL_LABEL,
  DYNAMIC_CONFIRMATION_PREFIX,
  ORDER_RECEIVED_PREFIX,
  QR_TRANSFER_NOW_LABEL,
} from '@/lib/kapso/outbound-classify';
/**
 * El cliente ve el número CORTO ("#7"), no el interno (`ORD-260828-007`).
 *
 * Es el número que oirá gritar cuando recoja, el que dirá por teléfono y el
 * único que le sirve para algo esta noche. Los prefijos canónicos NO se tocan:
 * siguen siendo la marca con la que el clasificador reconoce cada mensaje.
 */
import { shortOrderNumber } from '@/lib/orders/order-number';
import { RING_PROMO_AMOUNT, ringPromoText } from '@/lib/delivery/ring-promo';

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
  /**
   * ¿El mensaje va a salir con los DOS BOTONES pegados? (13-09-2026)
   *
   * Cambia solo el cierre: con botones no se le pide que escriba nada, porque
   * lo que tiene que tocar está debajo del texto. Por defecto `false`, que es
   * el mensaje de palabras de siempre — y es el que sale si el transporte no
   * puede mandar botones, para que nunca quede un cliente con una pregunta y
   * sin ninguna forma de contestarla.
   */
  withButtons = false,
): string {
  const pregunta = withButtons ? cashOrderPendingWithButtonsText() : cashOrderPendingText();

  if (!amounts || amounts.deliveryAmount <= 0) {
    return `${confirmationText}\n\n💵 Pagas en efectivo al recibir tu pedido.\n\n${pregunta}`;
  }

  const total = amounts.subtotal + amounts.deliveryAmount;
  return [
    confirmationText,
    '',
    `💵 Pagas en EFECTIVO al recibir: ${formatBs(total)}`,
    `   (comida ${formatBs(amounts.subtotal)} + delivery ${formatBs(amounts.deliveryAmount)})`,
    'Ten el monto listo, por favor 🙌',
    '',
    pregunta,
  ].join('\n');
}

/**
 * "Escribí CONFIRMO o CANCELAR" — el pedido en efectivo espera (05-09-2026).
 *
 * ── Los dos clientes que lo motivan ─────────────────────────────────────────
 *
 * En efectivo el aviso al grupo de reparto salía al COTIZAR, porque no hay pago
 * que esperar y ese era el único momento disponible. Pero el cliente ve el
 * precio del envío en ese mismo mensaje, y a veces no le gusta:
 *
 *   #40  "Delivery: Bs. 27"  →  "Muy caro su moto"  →  no volvió a escribir
 *   #39  "Delivery: Bs. 30"  →  "Cancelar pedido"   →  acabó pidiendo una persona
 *
 * Los dos pedidos ya estaban en el teléfono de quien reparte, y nadie sabía si
 * el cliente los quería. Por eso este mensaje ya no anuncia que el pedido está
 * confirmado: PREGUNTA. Hasta que conteste, el pedido no entra a cocina ni sale
 * al grupo.
 *
 * ── Por qué se le pide una palabra entera ───────────────────────────────────
 *
 * "CONFIRMO" y "CANCELAR" no se teclean por accidente, y aquí el error no manda
 * un mensaje de más: agenda —o tira— un pedido. La otra pregunta del flujo, la
 * de agregar algo, sí usa 1 y 2 porque ahí lo que está en juego es un botón.
 *
 * ── Lo que NO se le dice ────────────────────────────────────────────────────
 *
 * Ni "pago confirmado" —no ha pagado— ni "está siendo preparado", que era lo
 * que decía hasta hace unas horas y ahora sería falso: nadie lo cocina todavía.
 * Eso llega cuando confirme, y lo manda `orderConfirmedByCashText`.
 *
 * ── Lo que cuesta decir que sí y después no recibir (05-09-2026) ────────────
 *
 * En efectivo el negocio pone la comida y el viaje ANTES de cobrar nada: si el
 * cliente no abre la puerta se pierden las dos cosas, y no hay comprobante ni
 * pago que reclamar. Por eso la advertencia va PEGADA a la pregunta y no en un
 * mensaje aparte: es la letra pequeña de la palabra que se le está pidiendo, y
 * quien escribe CONFIRMO tiene que haberla leído ANTES de escribirla.
 */
function cashOrderPendingText(): string {
  return [
    '¿Confirmás tu pedido?',
    '  Escribí *CONFIRMO* y lo mandamos a cocina',
    '  Escribí *CANCELAR* si ya no lo querés',
    '',
    '⚠️ *ADVERTENCIA:* si el delivery llega con tu pedido y no lo recibís, tu ' +
      'número queda BLOQUEADO y no vas a poder volver a pedir en Don Zarco.',
  ].join('\n');
}

/**
 * El mismo cierre, cuando el mensaje lleva los DOS BOTONES (13-09-2026).
 *
 * ── Qué cambia y qué no ─────────────────────────────────────────────────────
 *
 * Desaparecen las dos líneas que pedían escribir una palabra: con los botones
 * debajo, decir "escribí CONFIRMO" es darle dos formas de hacer lo mismo y
 * empujarlo hacia la peor. Lo que NO cambia es la advertencia — sigue aquí, y
 * sigue pegada a la pregunta por el mismo motivo del 05-09: es la letra pequeña
 * de lo que se le está pidiendo, y tiene que haberla leído ANTES de decidir.
 *
 * ── Por qué la advertencia va ANTES de la pregunta ──────────────────────────
 *
 * Porque WhatsApp pinta los botones al final del mensaje, siempre. Lo último
 * que se lee antes de tocar es la última línea del cuerpo, así que la pregunta
 * baja ahí y la advertencia queda justo encima: en el orden en que se leen.
 */
function cashOrderPendingWithButtonsText(): string {
  return [
    '⚠️ *ADVERTENCIA:* si el delivery llega con tu pedido y no lo recibís, tu ' +
      'número queda BLOQUEADO y no vas a poder volver a pedir en Don Zarco.',
    '',
    '¿Confirmás tu pedido? 👇',
  ].join('\n');
}

/**
 * "Listo, tu pedido está en cocina" — la respuesta al que escribió CONFIRMO.
 *
 * Es el mensaje que el cliente en efectivo no recibía nunca, movido al momento
 * en que por fin es verdad. Antes se mandaba junto a la cotización, y desde el
 * 05-09 eso sería mentira: hasta que no confirma, nadie cocina nada.
 *
 * La frase de qué pasa ahora se importa de `PAYMENT_ACCEPTED_NEXT`, la misma
 * que recibe quien paga por QR al aceptarse su comprobante: es la misma promesa
 * por dos caminos, y dos copias se desincronizan.
 */
export function orderConfirmedByCashText(
  orderNumber: string,
  totalAmount: number,
  deliveryType: DeliveryType | null = null,
): string {
  const cabeza =
    `✅ Listo, tu pedido ${shortOrderNumber(orderNumber)} ya está en cocina. ` +
    `Pagás ${formatBs(totalAmount)} en efectivo al recibirlo.`;

  return deliveryType === null ? cabeza : `${cabeza}\n${PAYMENT_ACCEPTED_NEXT[deliveryType]}`;
}

/**
 * El aviso de que un pedido caducó sin confirmarse.
 *
 * Dice POR QUÉ se canceló —para que no parezca que se perdió— y deja abierta la
 * puerta en la misma frase. Quien no contestó suele estar ocupado, no molesto.
 */
export function orderExpiredWithoutConfirmText(orderNumber: string): string {
  return (
    `Cancelamos tu pedido ${shortOrderNumber(orderNumber)} porque no recibimos tu ` +
    'confirmación 🙌 Si todavía lo querés, escribinos y lo armamos de nuevo en un minuto.'
  );
}

/** El acuse de quien decidió no seguir. Sin reproche y sin puerta cerrada. */
export function orderCancelledByCustomerText(orderNumber: string): string {
  return (
    `Listo, cancelamos tu pedido ${shortOrderNumber(orderNumber)}. ` +
    'Cuando quieras pedir de nuevo, escribinos y te mandamos el menú 🙌'
  );
}

/**
 * Caption de la confirmación cuando el pago es por QR (Fase 6D.1). La imagen del
 * QR viaja aparte (es el propio mensaje); esto solo es su pie.
 *
 * ── Por QR se cobra la comida; el envío se paga al repartidor ──────────────
 *
 * El QR es ESTÁTICO: no trae el importe dentro, lo escribe el cliente. Así que
 * la cifra que teclee es la que lea en este mensaje, y hasta ahora leía tres.
 *
 * ── Por qué ya no va el desglose (16-09-2026) ───────────────────────────────
 *
 * Antes el pie repetía "Comida / Delivery / Total" y DEBAJO decía "paga SOLO la
 * comida". La gente no llegaba a esa línea: veía "Total: Bs 61", transfería 61,
 * y en la puerta volvía a pagar el envío. Ninguna advertencia debajo de un total
 * gana a ese total.
 *
 * Por eso ahora la única cifra que se presenta como TOTAL es la que se
 * transfiere, y va en la segunda línea. El envío sale con su propio número, pero
 * aparte, con otro emoji y con a quién se le paga. La suma de los dos no aparece
 * en ninguna parte: es el número que no queremos que nadie teclee.
 *
 * Que todo quede escrito en el mismo mensaje que el QR no es un detalle de
 * redacción: es lo que permite responder "se te avisó, y aquí está" cuando
 * alguien discute el cobro del envío en la puerta. Un segundo mensaje aparte
 * podría no llegar.
 *
 * Es el texto provisional hasta tener la API del banco, con un QR por pedido que
 * ya lleve el importe y deje de depender de que se lea.
 *
 * `deliveryAmount` en 0 es SOLO el recojo: un delivery cotizado nunca baja de
 * la tarifa mínima (`DELIVERY_BASE_AMOUNT`, Bs 10) y la base rechaza cualquier
 * importe fuera del tarifario. Ahí vuelve el texto de siempre, que no nombra el
 * envío: sin envío que cobrar, mencionarlo solo haría dudar al cliente.
 *
 * ── La promo del 4to anillo va pegada al envío (21-09-2026) ────────────────
 *
 * Justo debajo de la cifra del envío, porque es la que desmiente: quien vive
 * dentro del 4to anillo lee "Bs. 19" y el repartidor le cobra 12. Y antes de la
 * línea del 🛑, que sigue siendo la última: lo que se lee justo antes de
 * transferir tiene que ser que se transfiere solo la comida. Ver
 * `delivery/ring-promo`.
 */
export function buildQrPaymentCaption(
  confirmationText: string,
  payment?: { orderNumber: string; dueByQr: number; deliveryAmount: number },
): string {
  if (!payment || payment.deliveryAmount <= 0) {
    return `${confirmationText}\n\n💳 Escanea este QR para pagar tu pedido.`;
  }

  return [
    `📦 ¡Hola! Tu pedido ${shortOrderNumber(payment.orderNumber)} está casi listo.`,
    `✅ ${QR_TRANSFER_NOW_LABEL} ${formatBs(payment.dueByQr)} (*Solo Necesitamos el pago de la comida*).`,
    '*Envíanos tu comprobante* para enviar la orden a cocina.',
    '',
    `🛵 *ENVÍO TE SALDRÁ (${formatBs(payment.deliveryAmount)})* lo pagas *directamente al repartidor* cuando te entregue el pedido.`,
    ringPromoText(formatBs(RING_PROMO_AMOUNT)),
    '🛑 *Por favor, asegúrate de transferir únicamente el valor de la comida.*',
  ].join('\n');
}
