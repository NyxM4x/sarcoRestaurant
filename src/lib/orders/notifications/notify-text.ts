import type { DeliveryType } from '@/types';
import { formatBs } from '@/lib/orders/calculate';
import {
  CONFIRMATION_DELIVERY_LABEL,
  CONFIRMATION_FOOD_LABEL,
  CONFIRMATION_TOTAL_LABEL,
  DYNAMIC_CONFIRMATION_PREFIX,
  ORDER_RECEIVED_PREFIX,
} from '@/lib/kapso/outbound-classify';

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
        `📦 ¡Recibí tu pedido ${input.order_number}!`,
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
      `📦 ¡Recibí tu pedido ${input.order_number}!`,
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
    `${ORDER_RECEIVED_PREFIX}${orderNumber}.`,
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
    `${DYNAMIC_CONFIRMATION_PREFIX}${input.order_number}`,
    '',
    `${CONFIRMATION_FOOD_LABEL} ${formatBs(input.subtotal_amount)}`,
    `${CONFIRMATION_DELIVERY_LABEL} ${formatBs(input.delivery_amount)}`,
    `${CONFIRMATION_TOTAL_LABEL} ${formatBs(input.total_amount)}`,
  ].join('\n');
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
