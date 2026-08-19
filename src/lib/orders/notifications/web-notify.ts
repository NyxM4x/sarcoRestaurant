import type {
  DeliveryPricing,
  DeliveryQuoteStatus,
  DeliveryType,
  OrderStatus,
  PaymentMethod,
} from '@/types';
import { PAYMENT_QR_URL } from '@/lib/kapso/messages';
import {
  buildConfirmationText,
  buildDynamicDeliveryConfirmationText,
  buildOrderReceivedText,
  buildQrPaymentCaption,
  type ConfirmationTextResult,
  type NotifyItem,
} from './notify-text';
import { classifySendFailure } from './retry-policy';
import { isAmbiguousError, type RecoveryStatus } from './recovery-state';

/**
 * Orquestador de notificaciones del checkout web (Fase 5.2D.2) — módulo puro.
 *
 * No importa Supabase ni Kapso: depende de `NotificationStore` y
 * `NotificationSender` inyectados (la implementación real vive en `service.ts`).
 * Toda la información del pedido —incluidos teléfono y phone_number_id— proviene
 * del store (la base de datos), nunca de parámetros externos.
 *
 * Garantía central: NUNCA lanza hacia el caller. Cualquier error inesperado del
 * store o del sender se traduce a un resultado tipado y seguro.
 */

export type NotificationType = 'order_received' | 'confirmation' | 'location_request';

/**
 * Estados persistidos. Se reexporta el tipo canónico de `recovery-state` para
 * no mantener dos listas que puedan divergir de 0005.
 */
export type NotificationStatus = RecoveryStatus;

/**
 * Razones de rechazo que devuelve `claim_order_notification` (0005). Se
 * enumeran para que el orquestador NUNCA las trate como un fallo genérico
 * reintentable: un claim rechazado jamás autoriza un envío.
 */
export type ClaimDenialReason =
  | 'not_initialized'
  | 'in_flight'
  | 'requires_reconciliation'
  | 'not_scheduled'
  | 'confirmation_not_sent'
  /** 6D.2C: la ubicación dinámica espera a que order_received esté enviado. */
  | 'order_received_not_sent'
  /** 6D.2C: confirmación de delivery dinámico aún sin cotización aplicada. */
  | 'quote_not_applied'
  | 'max_attempts_reached'
  | 'terminal'
  | 'manual_review_required'
  | (string & {});

/** Vista del pedido necesaria para notificar, ya resuelta desde la base. */
export interface LoadedOrder {
  id: string;
  order_number: string;
  customer_phone: string;
  customer_name: string | null;
  delivery_type: DeliveryType;
  status: OrderStatus;
  subtotal_amount: number;
  delivery_amount: number;
  total_amount: number;
  /**
   * Método de pago (6D.1). `'qr'` → la confirmación se envía como imagen del QR
   * con caption; cualquier otro valor (incluido `null` en históricos y pedidos
   * del WhatsApp Flow) → confirmación de texto, exactamente como antes.
   */
  payment_method: PaymentMethod | null;
  /**
   * Modo de tarificación (6D.2C). `'dynamic'` invierte el orden confirmation ↔
   * location y difiere la confirmación hasta que la cotización esté aplicada.
   * `null` (legacy / pickup / Flow) conserva el comportamiento actual exacto.
   */
  delivery_pricing: DeliveryPricing | null;
  /** Estado de la cotización dinámica (6D.2C). `'quoted'` habilita la confirmación. */
  delivery_quote_status: DeliveryQuoteStatus | null;
  /** Proviene de menu_sessions vía orders.menu_session_id. */
  phone_number_id: string;
  location_request_message_id: string | null;
  items: NotifyItem[];
}

export type ClaimResult =
  | { claimed: true; notificationId: string; claimToken: string }
  | { claimed: false; status?: NotificationStatus; reason?: ClaimDenialReason };

/** Resultado sanitizado de un envío: solo `ok` + wamid o un código de error corto. */
export type SendResult = { ok: true; wamid: string } | { ok: false; error: string };

/**
 * Acceso a datos y a las RPC de 0004. La implementación real usa Supabase con
 * `service_role`. Los métodos pueden lanzar ante fallos de infraestructura; el
 * orquestador los captura.
 */
export interface NotificationStore {
  initialize(orderId: string): Promise<void>;
  loadOrder(orderId: string): Promise<LoadedOrder | null>;
  claim(orderId: string, notificationType: NotificationType): Promise<ClaimResult>;
  /** Cierra order_received (texto simple, 6D.2C). Misma RPC de cierre que confirmation. */
  markOrderReceivedSent(notificationId: string, claimToken: string, wamid: string): Promise<boolean>;
  markConfirmationSent(notificationId: string, claimToken: string, wamid: string): Promise<boolean>;
  markLocationSent(notificationId: string, claimToken: string, wamid: string): Promise<boolean>;
  markFailed(notificationId: string, claimToken: string, errorCode: string): Promise<boolean>;
}

/**
 * Envío por Kapso. La implementación real fija el copy web de la ubicación.
 *
 * `orderNumber` viaja hasta el sender porque el copy de la solicitud de
 * ubicación lo incluye: es el token que permite reconciliar el saliente con su
 * notificación cuando un envío queda ambiguo.
 */
export interface NotificationSender {
  sendText(phone: string, text: string, phoneNumberId: string): Promise<SendResult>;
  /**
   * Envía una imagen por enlace con caption (6D.1: confirmación con QR). Devuelve
   * el MISMO `SendResult` que el resto de envíos, de modo que claim/mark/reconcile
   * no dependen del tipo físico del mensaje, solo del wamid/resultado.
   */
  sendImage(
    phone: string,
    imageUrl: string,
    caption: string,
    phoneNumberId: string,
  ): Promise<SendResult>;
  sendLocationRequest(
    phone: string,
    phoneNumberId: string,
    orderNumber: string,
  ): Promise<SendResult>;
}

/**
 * Resultados comunes a ambos tipos. Cada valor distingue una situación real de
 * 0005; en particular `pending_reconciliation` (ambiguo, el mensaje pudo salir)
 * NO es lo mismo que `failed` (no salió), y ninguno de los estados de bloqueo
 * debe leerse como "se resolverá solo".
 */
type SharedOutcome =
  /** El envío salió y quedó registrado. */
  | 'sent'
  /** Ya estaba enviada: no se reenvía. */
  | 'already_sent'
  /** Otro dispatch la tiene reclamada ahora mismo. */
  | 'in_flight'
  /** Resultado ambiguo: quedó pendiente de reconciliación. Nunca se reenvía. */
  | 'pending_reconciliation'
  /** Requiere reconciliar antes de cualquier envío (claim rechazado). */
  | 'requires_reconciliation'
  /** Reconciliación en curso por otro proceso. */
  | 'reconciliation_in_progress'
  /** Fallo sin ambigüedad de entrega. */
  | 'failed'
  /** Cerrada definitivamente: no se reintenta. */
  | 'terminal'
  /** Requiere intervención humana. */
  | 'manual_review_required'
  /** Agotó los intentos permitidos. */
  | 'max_attempts_reached'
  /** Hay trabajo, pero sin programación explícita: nadie lo tomará solo. */
  | 'not_scheduled'
  /** 6D.2C: confirmación de delivery dinámico diferida hasta aplicar la cotización. */
  | 'blocked_by_quote'
  /** Sin fila de notificación. */
  | 'not_initialized'
  /** Rechazo que este código no conoce: nunca se envía. */
  | 'unknown';

export type ConfirmationOutcome = SharedOutcome;

/** 6D.2C: outcome del mensaje de recepción (order_received). */
export type OrderReceivedOutcome = SharedOutcome | 'not_applicable';

export type LocationOutcome =
  | SharedOutcome
  /** Pickup: la ubicación no aplica. */
  | 'not_applicable'
  /** Delivery legacy cuya confirmación aún no está enviada. */
  | 'blocked_by_confirmation'
  /** 6D.2C: delivery dinámico cuya recepción (order_received) aún no está enviada. */
  | 'blocked_by_order_received';

export type DispatchReason = 'invalid_order' | 'missing_items' | 'persistence_error';

export interface DispatchResult {
  ok: boolean;
  orderId: string;
  /** 6D.2C: presente solo en el flujo dinámico (3 mensajes). Ausente en legacy/pickup. */
  orderReceived?: OrderReceivedOutcome;
  confirmation: ConfirmationOutcome;
  locationRequest: LocationOutcome;
  /** Presente solo cuando el dispatch no pudo procesarse (carga o infra). */
  reason?: DispatchReason;
}

function makeResult(
  orderId: string,
  confirmation: ConfirmationOutcome,
  locationRequest: LocationOutcome,
  reason?: DispatchReason,
): DispatchResult {
  const ok =
    !reason &&
    (confirmation === 'sent' || confirmation === 'already_sent') &&
    (locationRequest === 'sent' ||
      locationRequest === 'already_sent' ||
      locationRequest === 'not_applicable');
  return reason
    ? { ok, orderId, confirmation, locationRequest, reason }
    : { ok, orderId, confirmation, locationRequest };
}

/**
 * Traduce un claim NO otorgado a un outcome explícito.
 *
 * Regla dura: NINGUNA de estas ramas envía nada. Un claim rechazado no es un
 * error genérico reintentable — cada motivo se reporta tal cual para que el
 * operador sepa si hay que reconciliar, esperar o intervenir a mano. Un motivo
 * desconocido cae en `unknown`, que tampoco autoriza envío.
 */
function outcomeFromDeniedClaim(claim: Extract<ClaimResult, { claimed: false }>): SharedOutcome {
  // El estado persistido manda cuando viene informado.
  switch (claim.status) {
    case 'sent':
      return 'already_sent';
    case 'sending':
      return 'in_flight';
    case 'pending_reconciliation':
      return 'requires_reconciliation';
    case 'reconciling':
      return 'reconciliation_in_progress';
    default:
      break;
  }

  switch (claim.reason) {
    case 'not_initialized':
      return 'not_initialized';
    case 'in_flight':
      return 'in_flight';
    case 'requires_reconciliation':
      return 'requires_reconciliation';
    case 'not_scheduled':
      return 'not_scheduled';
    case 'confirmation_not_sent':
      return 'blocked_by_confirmation' as SharedOutcome;
    case 'order_received_not_sent':
      // 6D.2C: la ubicación dinámica espera a que order_received esté enviado.
      return 'blocked_by_order_received' as SharedOutcome;
    case 'quote_not_applied':
      // 6D.2C: la confirmación dinámica espera la cotización. No es un fallo.
      return 'blocked_by_quote';
    case 'max_attempts_reached':
      return 'max_attempts_reached';
    case 'terminal':
      return 'terminal';
    case 'manual_review_required':
      return 'manual_review_required';
    default:
      // Nunca se asume que se resolverá solo.
      return 'unknown';
  }
}

function confirmationFromDeniedClaim(
  claim: Extract<ClaimResult, { claimed: false }>,
): ConfirmationOutcome {
  const outcome = outcomeFromDeniedClaim(claim);
  // Motivos que pertenecen a la ubicación, no a la confirmación: se neutralizan.
  return outcome === ('blocked_by_confirmation' as SharedOutcome) ||
    outcome === ('blocked_by_order_received' as SharedOutcome)
    ? 'unknown'
    : outcome;
}

function locationFromDeniedClaim(claim: Extract<ClaimResult, { claimed: false }>): LocationOutcome {
  if (claim.reason === 'not_initialized') return 'not_applicable';
  return outcomeFromDeniedClaim(claim) as LocationOutcome;
}

/**
 * Traduce un fallo de envío al outcome que refleja lo que 0005 acaba de
 * persistir: `mark_order_notification_failed` deriva los códigos AMBIGUOS a
 * `pending_reconciliation` y solo los demás quedan en `failed`.
 *
 * Se apoya en `classifySendFailure` (retry-policy) para no duplicar la tabla de
 * clasificación. `manual_review` también implica ambigüedad no resuelta: se
 * reporta como pendiente de reconciliación porque la fila NO puede reenviarse.
 */
function outcomeFromSendFailure(errorCode: string): SharedOutcome {
  // `isAmbiguousError` espeja EXACTAMENTE `is_ambiguous_notification_error` de
  // 0005, que es quien decide de verdad el estado persistido. Es la fuente de
  // verdad: incluye `persistence_error` y todo `http_*`, donde la tabla más
  // antigua de retry-policy discrepa.
  if (isAmbiguousError(errorCode)) return 'pending_reconciliation';

  // No ambiguo: retry-policy distingue entre corrección humana y fallo simple.
  return classifySendFailure(errorCode) === 'manual_review' ? 'manual_review_required' : 'failed';
}

/** `true` si el pedido ya tiene registrada una solicitud de ubicación. */
function hasLocationRequest(order: LoadedOrder): boolean {
  return (order.location_request_message_id ?? '').trim() !== '';
}

/**
 * Ejecuta un envío aislando cualquier excepción inesperada del sender.
 *
 * Un throw del sender NO es un fallo de persistencia: se clasifica como
 * `network_error` y nunca expone el mensaje original.
 */
async function safeSend(send: () => Promise<SendResult>): Promise<SendResult> {
  try {
    return await send();
  } catch {
    return { ok: false, error: 'network_error' };
  }
}

/**
 * Marca el fallo sin propagar: si el propio cierre falla, la fila queda
 * `sending` y se recuperará cuando su claim quede stale.
 */
async function safeMarkFailed(
  store: NotificationStore,
  notificationId: string,
  claimToken: string,
  errorCode: string,
): Promise<void> {
  try {
    await store.markFailed(notificationId, claimToken, errorCode);
  } catch {
    // Recuperable por reclamo stale; nunca se propaga.
  }
}

/**
 * Cierra como enviada SIN propagar. Un throw AQUÍ ocurre DESPUÉS de un POST
 * exitoso: la petición ya salió a Kapso. No debe convertirse en un fallo
 * genérico (que reabriría la puerta a un segundo envío), sino en `false` →
 * outcome `unknown`, conservando `sendAttempted = true`. La fila se resolverá
 * por webhook/reconciliación.
 */
async function safeMarkSent(mark: () => Promise<boolean>): Promise<boolean> {
  try {
    return await mark();
  } catch {
    return false;
  }
}

/**
 * Resultado de procesar UNA notificación.
 *
 * `sendAttempted` = el sender fue INVOCADO (el POST a Kapso pudo iniciarse),
 * con independencia de si Kapso confirmó (timeout, network_error,
 * invalid_response y un fallo de persistencia POSTERIOR al POST también cuentan
 * como intento). NO significa éxito. El worker consume su cupo de envío por
 * `sendAttempted`, no por éxito, para no arriesgar un segundo POST en el tick.
 */
export interface OneNotificationResult<T> {
  outcome: T;
  sendAttempted: boolean;
}

async function processConfirmation(
  store: NotificationStore,
  sender: NotificationSender,
  order: LoadedOrder,
  text: string,
): Promise<OneNotificationResult<ConfirmationOutcome>> {
  const claim = await store.claim(order.id, 'confirmation');
  // Claim no concedido: el sender NO se invoca → no cuenta como intento.
  if (!claim.claimed) return { outcome: confirmationFromDeniedClaim(claim), sendAttempted: false };

  // 6D.1: si el pago es por QR, la confirmación es la imagen del QR con el texto
  // de confirmación como caption (un solo mensaje). Cualquier otro método
  // —incluido NULL (históricos / WhatsApp Flow)— conserva el texto de siempre.
  const sent = await safeSend(() =>
    order.payment_method === 'qr'
      ? sender.sendImage(
          order.customer_phone,
          PAYMENT_QR_URL,
          buildQrPaymentCaption(text),
          order.phone_number_id,
        )
      : sender.sendText(order.customer_phone, text, order.phone_number_id),
  );
  if (!sent.ok) {
    // La RPC decide el estado real (ambiguo -> pending_reconciliation); el
    // outcome se deriva de la MISMA clasificación para no mentir al operador.
    // El sender ya se invocó: es un intento (timeout/network/invalid_response).
    await safeMarkFailed(store, claim.notificationId, claim.claimToken, sent.error);
    return { outcome: outcomeFromSendFailure(sent.error), sendAttempted: true };
  }

  // POST exitoso: el cierre NO puede propagar (ver safeMarkSent). Aunque falle,
  // el intento cuenta y el outcome es `unknown`, nunca un segundo envío.
  const marked = await safeMarkSent(() =>
    store.markConfirmationSent(claim.notificationId, claim.claimToken, sent.wamid),
  );
  return { outcome: marked ? 'sent' : 'unknown', sendAttempted: true };
}

async function processLocationRequest(
  store: NotificationStore,
  sender: NotificationSender,
  order: LoadedOrder,
): Promise<OneNotificationResult<LocationOutcome>> {
  const claim = await store.claim(order.id, 'location_request');
  // Claim no concedido: el sender NO se invoca → no cuenta como intento.
  if (!claim.claimed) return { outcome: locationFromDeniedClaim(claim), sendAttempted: false };

  const sent = await safeSend(() =>
    sender.sendLocationRequest(order.customer_phone, order.phone_number_id, order.order_number),
  );
  if (!sent.ok) {
    // La RPC decide el estado real (ambiguo -> pending_reconciliation); el
    // outcome se deriva de la MISMA clasificación para no mentir al operador.
    // El sender ya se invocó: es un intento (timeout/network/invalid_response).
    await safeMarkFailed(store, claim.notificationId, claim.claimToken, sent.error);
    return { outcome: outcomeFromSendFailure(sent.error), sendAttempted: true };
  }

  // POST exitoso: el cierre NO puede propagar (ver safeMarkSent). Aunque falle,
  // el intento cuenta y el outcome es `unknown`, nunca un segundo envío.
  const marked = await safeMarkSent(() =>
    store.markLocationSent(claim.notificationId, claim.claimToken, sent.wamid),
  );
  return { outcome: marked ? 'sent' : 'unknown', sendAttempted: true };
}

/** Un claim denegado de order_received: no depende de nadie, se reporta tal cual. */
function orderReceivedFromDeniedClaim(
  claim: Extract<ClaimResult, { claimed: false }>,
): OrderReceivedOutcome {
  return outcomeFromDeniedClaim(claim) as OrderReceivedOutcome;
}

/**
 * Procesa el mensaje de RECEPCIÓN (order_received, 6D.2C) — texto simple. Es el
 * PRIMER mensaje del flujo dinámico; su cierre usa la misma RPC de "sent" que la
 * confirmación (texto sin doble escritura). No depende de ninguna otra notificación.
 */
async function processOrderReceived(
  store: NotificationStore,
  sender: NotificationSender,
  order: LoadedOrder,
): Promise<OneNotificationResult<OrderReceivedOutcome>> {
  const claim = await store.claim(order.id, 'order_received');
  if (!claim.claimed) return { outcome: orderReceivedFromDeniedClaim(claim), sendAttempted: false };

  const text = buildOrderReceivedText(order.order_number);
  const sent = await safeSend(() => sender.sendText(order.customer_phone, text, order.phone_number_id));
  if (!sent.ok) {
    await safeMarkFailed(store, claim.notificationId, claim.claimToken, sent.error);
    return { outcome: outcomeFromSendFailure(sent.error), sendAttempted: true };
  }

  const marked = await safeMarkSent(() =>
    store.markOrderReceivedSent(claim.notificationId, claim.claimToken, sent.wamid),
  );
  return { outcome: marked ? 'sent' : 'unknown', sendAttempted: true };
}

/**
 * Carga el pedido, valida y procesa confirmación (+ ubicación en delivery).
 * Envuelto en un único try/catch: cualquier error se reporta como
 * `persistence_error` sin propagarse.
 */
/** Motivo por el que un pedido no es despachable. */
type LoadGuardReason = 'invalid_order';

type LoadDispatchable =
  | { ok: true; order: LoadedOrder }
  | { ok: false; reason: LoadGuardReason };

/**
 * Carga y valida un pedido para despacho. Reúne los guards comunes a `dispatch`
 * y al envío por-notificación del worker, de modo que ninguna vía envíe sobre un
 * pedido en estado inconsistente. No construye texto (eso es de confirmation).
 */
async function loadDispatchableOrder(
  store: NotificationStore,
  orderId: string,
): Promise<LoadDispatchable> {
  const order = await store.loadOrder(orderId);
  if (!order) return { ok: false, reason: 'invalid_order' };

  // Teléfono y phone_number_id SOLO desde la base; no pueden estar vacíos.
  // `order_number` también es obligatorio: va dentro del copy de la solicitud
  // de ubicación y es la clave para reconciliar envíos ambiguos.
  if (
    order.customer_phone.trim() === '' ||
    order.phone_number_id.trim() === '' ||
    order.order_number.trim() === ''
  ) {
    return { ok: false, reason: 'invalid_order' };
  }

  // pickup solo confirmado; delivery esperando ubicación o ya confirmado
  // (la ubicación ya llegó por el webhook).
  const validStatus =
    (order.delivery_type === 'pickup' && order.status === 'confirmed') ||
    (order.delivery_type === 'delivery' &&
      (order.status === 'awaiting_location' || order.status === 'confirmed'));
  if (!validStatus) return { ok: false, reason: 'invalid_order' };

  // Delivery ya confirmado SIN solicitud registrada: estado inconsistente (la
  // ubicación no pudo llegar sin una solicitud previa). No se envía nada.
  if (
    order.delivery_type === 'delivery' &&
    order.status === 'confirmed' &&
    !hasLocationRequest(order)
  ) {
    return { ok: false, reason: 'invalid_order' };
  }

  return { ok: true, order };
}

/** ¿El pedido es un delivery de tarificación dinámica (6D.2C)? */
function isDynamicDelivery(order: LoadedOrder): boolean {
  return order.delivery_type === 'delivery' && order.delivery_pricing === 'dynamic';
}

/**
 * Elige el texto de confirmación según el pedido. Un delivery dinámico YA
 * cotizado usa el copy con montos reales (Comida/Delivery/Total, sin kilómetros
 * ni fórmula); todo lo demás conserva el texto de siempre (incluye ítems).
 */
function buildConfirmationForOrder(order: LoadedOrder): ConfirmationTextResult {
  if (isDynamicDelivery(order)) {
    return {
      ok: true,
      text: buildDynamicDeliveryConfirmationText({
        order_number: order.order_number,
        subtotal_amount: order.subtotal_amount,
        delivery_amount: order.delivery_amount,
        total_amount: order.total_amount,
      }),
    };
  }
  return buildConfirmationText({
    order_number: order.order_number,
    delivery_type: order.delivery_type,
    subtotal_amount: order.subtotal_amount,
    total_amount: order.total_amount,
    items: order.items,
  });
}

/** ¿Es un outcome "benigno" (sin fallo) para computar `ok` en el flujo dinámico? */
function isBenignDynamicOutcome(outcome: string): boolean {
  return (
    outcome === 'sent' ||
    outcome === 'already_sent' ||
    outcome === 'not_applicable' ||
    outcome === 'blocked_by_quote' ||
    outcome === 'blocked_by_order_received'
  );
}

/** Resultado del flujo dinámico (3 mensajes). `ok` = ningún fallo en las fases. */
function makeDynamicResult(
  orderId: string,
  orderReceived: OrderReceivedOutcome,
  locationRequest: LocationOutcome,
  confirmation: ConfirmationOutcome,
  reason?: DispatchReason,
): DispatchResult {
  const ok =
    !reason &&
    isBenignDynamicOutcome(orderReceived) &&
    isBenignDynamicOutcome(locationRequest) &&
    isBenignDynamicOutcome(confirmation);
  return reason
    ? { ok, orderId, orderReceived, confirmation, locationRequest, reason }
    : { ok, orderId, orderReceived, confirmation, locationRequest };
}

/**
 * Despacho de un delivery DINÁMICO (6D.2C) — TRES fases en orden estricto:
 *
 *   awaiting_location + pending/failed:
 *     1. order_received; si NO queda enviado → la ubicación queda
 *        `blocked_by_order_received` y la confirmación `blocked_by_quote`.
 *     2. location_request (solo tras order_received sent).
 *   confirmed + quoted:
 *     3. confirmation (order_received y ubicación ya salieron: already_sent).
 *   out_of_coverage / otro: nada (confirmación bloqueada).
 *
 * Defensa en profundidad: el orden también lo impone el gate SQL (claim), que es
 * la barrera final ante concurrencia/recovery.
 */
async function dispatchDynamic(
  store: NotificationStore,
  sender: NotificationSender,
  order: LoadedOrder,
): Promise<DispatchResult> {
  const quote = order.delivery_quote_status;

  // Fase 3: cotizado → confirmación final.
  if (order.status === 'confirmed' && quote === 'quoted') {
    const built = buildConfirmationForOrder(order);
    if (!built.ok) {
      return makeDynamicResult(order.id, 'already_sent', 'already_sent', 'not_initialized', 'missing_items');
    }
    const confirmation = (await processConfirmation(store, sender, order, built.text)).outcome;
    return makeDynamicResult(order.id, 'already_sent', 'already_sent', confirmation);
  }

  // Fases 1 y 2: esperando ubicación, aún sin cotizar.
  if (order.status === 'awaiting_location' && (quote === 'pending' || quote === 'failed')) {
    const orderReceived = (await processOrderReceived(store, sender, order)).outcome;
    if (orderReceived !== 'sent' && orderReceived !== 'already_sent') {
      // La ubicación NO se adelanta a la recepción; la confirmación espera la quote.
      return makeDynamicResult(order.id, orderReceived, 'blocked_by_order_received', 'blocked_by_quote');
    }
    const locationRequest = (await processLocationRequest(store, sender, order)).outcome;
    return makeDynamicResult(order.id, orderReceived, locationRequest, 'blocked_by_quote');
  }

  // out_of_coverage u otro estado no despachable: nada que enviar aquí.
  return makeDynamicResult(order.id, 'already_sent', 'not_applicable', 'blocked_by_quote');
}

async function dispatch(
  store: NotificationStore,
  sender: NotificationSender,
  orderId: string,
): Promise<DispatchResult> {
  try {
    const loaded = await loadDispatchableOrder(store, orderId);
    if (!loaded.ok) return makeResult(orderId, 'not_initialized', 'not_applicable', loaded.reason);
    const order = loaded.order;

    // 6D.2C: delivery dinámico invierte el orden y difiere la confirmación.
    if (isDynamicDelivery(order)) {
      return dispatchDynamic(store, sender, order);
    }

    // Legacy / pickup: comportamiento EXACTO al anterior.
    const built = buildConfirmationForOrder(order);
    if (!built.ok) {
      return makeResult(orderId, 'not_initialized', 'not_applicable', 'missing_items');
    }

    const confirmation = (await processConfirmation(store, sender, order, built.text)).outcome;

    // pickup: nunca se reclama ni envía location_request.
    if (order.delivery_type !== 'delivery') {
      return makeResult(orderId, confirmation, 'not_applicable');
    }

    // delivery: la ubicación solo procede si la confirmación quedó enviada.
    if (confirmation !== 'sent' && confirmation !== 'already_sent') {
      return makeResult(orderId, confirmation, 'blocked_by_confirmation');
    }

    // Delivery ya confirmado CON solicitud registrada: la ubicación ya llegó por
    // el webhook. Estado terminal: no se reclama ni se envía otra solicitud.
    if (order.status === 'confirmed') {
      return makeResult(orderId, confirmation, 'already_sent');
    }

    const locationRequest = (await processLocationRequest(store, sender, order)).outcome;
    return makeResult(orderId, confirmation, locationRequest);
  } catch {
    return makeResult(orderId, 'failed', 'not_applicable', 'persistence_error');
  }
}

/** Resultado del envío de UNA notificación (worker). Sin datos sensibles. */
export interface SingleDispatchResult {
  notificationType: NotificationType;
  outcome: ConfirmationOutcome | LocationOutcome;
  /**
   * `true` si el sender fue INVOCADO (el POST a Kapso pudo iniciarse), incluso si
   * terminó en timeout/error o si la persistencia posterior falló. NO es éxito.
   * El worker consume su cupo de envío por este valor.
   */
  sendAttempted: boolean;
}

/**
 * Envía EXACTAMENTE UNA notificación de un pedido ya existente (Fase 5.2D.5D).
 *
 * Reclama con `claim_order_notification` y envía a lo sumo una vez. NO inicializa
 * filas, NO intenta la siguiente notificación y NO se salta el orden: la RPC
 * rechaza `location_request` si la confirmación no está enviada. Es la pieza que
 * usa el worker para respetar `MAX_NETWORK_SENDS_PER_WORKER_RUN = 1` (un POST),
 * a diferencia de `dispatch`, que puede enviar dos.
 */
export async function dispatchSingleNotification(
  store: NotificationStore,
  sender: NotificationSender,
  orderId: string,
  notificationType: NotificationType,
): Promise<SingleDispatchResult> {
  try {
    const loaded = await loadDispatchableOrder(store, orderId);
    if (!loaded.ok) {
      return { notificationType, outcome: 'not_initialized', sendAttempted: false };
    }
    const order = loaded.order;

    if (notificationType === 'order_received') {
      // 6D.2C: texto de recepción (solo delivery dinámico). El gate SQL ya impide
      // reclamarlo en pickup/legacy (no existe la fila).
      const r = await processOrderReceived(store, sender, order);
      return { notificationType, outcome: r.outcome, sendAttempted: r.sendAttempted };
    }

    if (notificationType === 'confirmation') {
      const built = buildConfirmationForOrder(order);
      if (!built.ok) {
        return { notificationType, outcome: 'not_initialized', sendAttempted: false };
      }
      const r = await processConfirmation(store, sender, order, built.text);
      return { notificationType, outcome: r.outcome, sendAttempted: r.sendAttempted };
    }

    // location_request: solo delivery. La RPC de claim impone que la confirmación
    // esté enviada (confirmation_not_sent) y que el estado sea el correcto.
    if (order.delivery_type !== 'delivery') {
      return { notificationType, outcome: 'not_applicable', sendAttempted: false };
    }
    const r = await processLocationRequest(store, sender, order);
    return { notificationType, outcome: r.outcome, sendAttempted: r.sendAttempted };
  } catch {
    // Un throw aquí es ANTES del POST (loadOrder/build/claim): nunca es intento.
    // Un fallo POSTERIOR al POST lo absorbe safeMarkSent sin propagar.
    return { notificationType, outcome: 'failed', sendAttempted: false };
  }
}

/**
 * Inicializa las notificaciones y luego las procesa. Se usará solo para checkout
 * `created:true` y para el reintento interno explícito.
 */
export async function initializeAndDispatch(
  store: NotificationStore,
  sender: NotificationSender,
  orderId: string,
): Promise<DispatchResult> {
  try {
    await store.initialize(orderId);
  } catch {
    return makeResult(orderId, 'failed', 'not_applicable', 'persistence_error');
  }
  return dispatch(store, sender, orderId);
}

/**
 * Procesa únicamente notificaciones ya existentes (NO inicializa). Se usará para
 * checkout `created:false`, de modo que un reintento nunca cree filas nuevas para
 * pedidos que no las tenían.
 */
export function dispatchExisting(
  store: NotificationStore,
  sender: NotificationSender,
  orderId: string,
): Promise<DispatchResult> {
  return dispatch(store, sender, orderId);
}
