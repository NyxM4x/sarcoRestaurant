import 'server-only';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { DeliveryType, OrderStatus } from '@/types';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import { getServerEnv } from '@/lib/env/env';
import { log } from '@/lib/log';
import { getKapsoClient } from '@/lib/kapso/client';
import { buildWebLocationRequestBodyText } from '@/lib/kapso/messages';
import { createKapsoMessageHistory } from '@/lib/kapso/message-history';
import { normalizePhone } from '@/lib/phone';
import type { KapsoClient } from '@/lib/kapso/transport';
import { NOTIFICATION_SEND_TIMEOUT_MS } from './retry-policy';
import { RECOVERY_STATUSES, type RecoveryStatus } from './recovery-state';
import type { NotificationStateRow, NotificationStatesResult } from './retry-plan';
import { reconcileNotification } from './reconcile-runner';
import { WORKER_ORDER_LIMIT, type WorkerDeps } from './worker';
import {
  ALERT_RETRY_DELAY_SECONDS,
  type AlertClaimResult,
  type AlertRescheduleResult,
  type AlertRunnerDeps,
} from './alert-runner';
import { createTelegramAlertSender } from '@/lib/alerts/telegram';
import type {
  OutboundReconciliationStore,
  ResolvedOrder,
  WebhookSentResult,
} from './outbound-webhook';
import type {
  ClaimReconResult,
  ReconcileContext,
  ReconcileDeps,
  ReconcileRow,
  RescheduleResult,
  ScheduleResult,
} from './reconcile-runner';
import {
  dispatchExisting,
  dispatchSingleNotification,
  initializeAndDispatch,
  type ClaimResult,
  type DispatchResult,
  type LoadedOrder,
  type NotificationSender,
  type NotificationStatus,
  type NotificationStore,
  type NotificationType,
  type SendResult,
} from './web-notify';

/**
 * Capa server-only de las notificaciones (Fase 5.2D.2).
 *
 * Implementa `NotificationStore` con las CINCO RPC de 0004 y una única consulta
 * de lectura (orders ⨝ menu_sessions ⨝ order_items), y `NotificationSender` con
 * el cliente real de Kapso. El teléfono y el phone_number_id se leen SOLO de la
 * base; nunca llegan como parámetros. Los errores de Supabase se convierten a un
 * error sanitizado (`persistence_error`) sin filtrar detalles.
 */

/** Error sanitizado: nunca lleva mensaje técnico, body, teléfono ni secretos. */
export class NotificationPersistenceError extends Error {
  constructor() {
    super('persistence_error');
    this.name = 'NotificationPersistenceError';
  }
}

/**
 * Relación explícita por la FK de 0003 (`orders_menu_session_id_fk`) y alias
 * fijos para ambos embeds: no se depende de que PostgREST infiera la relación.
 */
export const ORDER_SELECT =
  'id, order_number, customer_phone, customer_name, delivery_type, status, ' +
  'subtotal_amount, delivery_amount, total_amount, payment_method, menu_session_id, ' +
  'delivery_pricing, delivery_quote_status, ' +
  'location_request_message_id, ' +
  'menu_session:menu_sessions!orders_menu_session_id_fk ( phone_number_id ), ' +
  'items:order_items ( product_name_snapshot, quantity, subtotal )';

/**
 * Columnas de recuperación de 0005 necesarias para planificar un reintento
 * manual. No incluye claim_token ni datos del destinatario.
 */
export const NOTIFICATION_STATE_SELECT =
  'notification_type, status, attempt_count, max_attempts, next_attempt_at, ' +
  'terminal_at, manual_review_required, last_error_code, last_http_status';

function unwrapToOne(value: unknown): Record<string, unknown> | null {
  // Supabase puede devolver el embed to-one como objeto o como array de uno.
  const v = Array.isArray(value) ? value[0] : value;
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
}

function parseClaim(data: unknown): ClaimResult {
  if (typeof data !== 'object' || data === null) throw new NotificationPersistenceError();
  const d = data as Record<string, unknown>;

  if (d.claimed === true) {
    if (typeof d.notification_id !== 'string' || typeof d.claim_token !== 'string') {
      throw new NotificationPersistenceError();
    }
    return { claimed: true, notificationId: d.notification_id, claimToken: d.claim_token };
  }
  if (d.claimed === false) {
    // El status solo se acepta si pertenece al dominio de 0005; cualquier otro
    // valor se descarta en vez de castearse a ciegas, y el `reason` decide.
    const status =
      typeof d.status === 'string' && (RECOVERY_STATUSES as readonly string[]).includes(d.status)
        ? (d.status as NotificationStatus)
        : undefined;
    return {
      claimed: false,
      status,
      reason: typeof d.reason === 'string' ? d.reason : undefined,
    };
  }
  // Forma inesperada: se rechaza de forma segura.
  throw new NotificationPersistenceError();
}

function parseBoolean(data: unknown): boolean {
  if (typeof data !== 'boolean') throw new NotificationPersistenceError();
  return data;
}

/** Store respaldado por Supabase (service_role). El `supabase` se inyecta. */
export function createSupabaseNotificationStore(supabase: SupabaseClient): NotificationStore {
  return {
    async initialize(orderId: string): Promise<void> {
      const { error } = await supabase.rpc('initialize_order_notifications', {
        p_order_id: orderId,
      });
      if (error) throw new NotificationPersistenceError();
    },

    async loadOrder(orderId: string): Promise<LoadedOrder | null> {
      const { data, error } = await supabase
        .from('orders')
        .select(ORDER_SELECT)
        .eq('id', orderId)
        .maybeSingle();
      if (error) throw new NotificationPersistenceError();
      if (!data) return null;

      // El `select` se compone por concatenación, así que PostgREST no puede
      // inferir su forma: se normaliza vía `unknown` y se valida campo a campo.
      const row = data as unknown as Record<string, unknown>;

      // Solo pedidos web: sin sesión no hay phone_number_id que usar.
      if (row.menu_session_id == null) return null;

      const session = unwrapToOne(row.menu_session);
      const phoneNumberId =
        typeof session?.phone_number_id === 'string' ? session.phone_number_id : '';
      if (phoneNumberId.trim() === '') return null;

      const itemsRaw = Array.isArray(row.items) ? row.items : [];
      const items = itemsRaw.map((raw) => {
        const it = raw as Record<string, unknown>;
        return {
          product_name_snapshot: String(it.product_name_snapshot ?? ''),
          quantity: Number(it.quantity ?? 0),
          subtotal: Number(it.subtotal ?? 0),
        };
      });

      return {
        id: String(row.id),
        order_number: String(row.order_number),
        customer_phone: String(row.customer_phone ?? ''),
        customer_name: (row.customer_name as string | null) ?? null,
        delivery_type: row.delivery_type as DeliveryType,
        status: row.status as OrderStatus,
        subtotal_amount: Number(row.subtotal_amount),
        delivery_amount: Number(row.delivery_amount),
        total_amount: Number(row.total_amount),
        payment_method:
          row.payment_method === 'cash' || row.payment_method === 'qr'
            ? row.payment_method
            : null,
        delivery_pricing: row.delivery_pricing === 'dynamic' ? 'dynamic' : null,
        delivery_quote_status:
          row.delivery_quote_status === 'pending' ||
          row.delivery_quote_status === 'quoted' ||
          row.delivery_quote_status === 'failed' ||
          row.delivery_quote_status === 'out_of_coverage'
            ? row.delivery_quote_status
            : null,
        phone_number_id: phoneNumberId,
        location_request_message_id: (row.location_request_message_id as string | null) ?? null,
        items,
      };
    },

    async claim(orderId: string, notificationType: NotificationType): Promise<ClaimResult> {
      const { data, error } = await supabase.rpc('claim_order_notification', {
        p_order_id: orderId,
        p_notification_type: notificationType,
      });
      if (error) throw new NotificationPersistenceError();
      return parseClaim(data);
    },

    async markOrderReceivedSent(
      notificationId: string,
      claimToken: string,
      wamid: string,
    ): Promise<boolean> {
      // 6D.2C: order_received cierra con la MISMA RPC que confirmation (texto sin
      // doble escritura). En 0013 esa RPC acepta también 'order_received'.
      const { data, error } = await supabase.rpc('mark_order_notification_sent', {
        p_notification_id: notificationId,
        p_claim_token: claimToken,
        p_external_message_id: wamid,
      });
      if (error) throw new NotificationPersistenceError();
      return parseBoolean(data);
    },

    async markConfirmationSent(
      notificationId: string,
      claimToken: string,
      wamid: string,
    ): Promise<boolean> {
      const { data, error } = await supabase.rpc('mark_order_notification_sent', {
        p_notification_id: notificationId,
        p_claim_token: claimToken,
        p_external_message_id: wamid,
      });
      if (error) throw new NotificationPersistenceError();
      return parseBoolean(data);
    },

    async markLocationSent(
      notificationId: string,
      claimToken: string,
      wamid: string,
    ): Promise<boolean> {
      const { data, error } = await supabase.rpc('mark_location_request_sent', {
        p_notification_id: notificationId,
        p_claim_token: claimToken,
        p_wamid: wamid,
      });
      if (error) throw new NotificationPersistenceError();
      return parseBoolean(data);
    },

    async markFailed(
      notificationId: string,
      claimToken: string,
      errorCode: string,
    ): Promise<boolean> {
      const { data, error } = await supabase.rpc('mark_order_notification_failed', {
        p_notification_id: notificationId,
        p_claim_token: claimToken,
        p_error_code: errorCode,
      });
      if (error) throw new NotificationPersistenceError();
      return parseBoolean(data);
    },
  };
}

/**
 * Lee el estado de recuperación de las notificaciones de un pedido (0005).
 *
 * Solo lectura y sin datos sensibles: no devuelve claim_token, teléfono ni
 * wamid. Alimenta el planificador puro del reintento manual.
 */
export async function loadNotificationStates(
  supabase: SupabaseClient,
  orderId: string,
): Promise<NotificationStatesResult> {
  const { data, error } = await supabase
    .from('order_notifications')
    .select(NOTIFICATION_STATE_SELECT)
    .eq('order_id', orderId);

  if (error) throw new NotificationPersistenceError();

  const raws = (data ?? []) as unknown as Record<string, unknown>[];
  const rows: NotificationStateRow[] = [];
  let unknownStateCount = 0;

  for (const raw of raws) {
    const type = raw.notification_type;
    const status = raw.status;

    // Una fila existente que no sabemos interpretar NO se descarta en silencio:
    // se cuenta, para que el endpoint no la confunda con "pedido sin filas".
    const knownType =
      type === 'order_received' || type === 'confirmation' || type === 'location_request';
    const knownStatus =
      typeof status === 'string' && (RECOVERY_STATUSES as readonly string[]).includes(status);

    if (!knownType || !knownStatus) {
      unknownStateCount += 1;
      continue;
    }

    const httpStatus = Number(raw.last_http_status);
    rows.push({
      notificationType: type,
      status: status as RecoveryStatus,
      attemptCount: Number(raw.attempt_count ?? 0),
      maxAttempts: Number(raw.max_attempts ?? 5),
      nextAttemptAt: (raw.next_attempt_at as string | null) ?? null,
      terminalAt: (raw.terminal_at as string | null) ?? null,
      manualReviewRequired: raw.manual_review_required === true,
      lastErrorCode: (raw.last_error_code as string | null) ?? null,
      lastHttpStatus: Number.isInteger(httpStatus) ? httpStatus : null,
    });
  }

  return { rows, unknownStateCount };
}

/**
 * Programa un envío para una fila `failed` NO ambigua (`schedule_notification_send`).
 *
 * Necesario porque 0005 solo permite reclamar un `failed` con `next_attempt_at`
 * explícito y vencido. La RPC rechaza por sí misma los ambiguos, terminales, en
 * revisión manual o con intentos agotados: aquí solo se reporta el resultado.
 */
export async function scheduleNotificationSend(
  supabase: SupabaseClient,
  orderId: string,
  notificationType: NotificationType,
): Promise<boolean> {
  const { data, error } = await supabase.rpc('schedule_notification_send', {
    p_order_id: orderId,
    p_notification_type: notificationType,
    p_delay_seconds: 0,
  });
  if (error) throw new NotificationPersistenceError();
  if (typeof data !== 'object' || data === null) throw new NotificationPersistenceError();
  return (data as Record<string, unknown>).scheduled === true;
}

/**
 * Sender respaldado por el cliente real de Kapso (se inyecta). Fija aquí el copy
 * web de la solicitud de ubicación, de modo que el orquestador no conoce textos.
 * Devuelve solo `{ ok, wamid }` o `{ ok:false, error }` con un código corto.
 */
export function createKapsoNotificationSender(kapso: KapsoClient): NotificationSender {
  return {
    async sendText(phone: string, text: string, phoneNumberId: string): Promise<SendResult> {
      const res = await kapso.sendText(phone, text, {
        phoneNumberId,
        timeoutMs: NOTIFICATION_SEND_TIMEOUT_MS,
      });
      return res.ok ? { ok: true, wamid: res.wamid } : { ok: false, error: res.error };
    },

    async sendImage(
      phone: string,
      imageUrl: string,
      caption: string,
      phoneNumberId: string,
    ): Promise<SendResult> {
      const res = await kapso.sendImage(phone, imageUrl, caption, {
        phoneNumberId,
        timeoutMs: NOTIFICATION_SEND_TIMEOUT_MS,
      });
      return res.ok ? { ok: true, wamid: res.wamid } : { ok: false, error: res.error };
    },

    async sendLocationRequest(
      phone: string,
      phoneNumberId: string,
      orderNumber: string,
    ): Promise<SendResult> {
      const res = await kapso.sendLocationRequest(phone, {
        phoneNumberId,
        // El copy incluye el número de pedido: es el token de reconciliación.
        bodyText: buildWebLocationRequestBodyText(orderNumber),
        timeoutMs: NOTIFICATION_SEND_TIMEOUT_MS,
      });
      return res.ok ? { ok: true, wamid: res.wamid } : { ok: false, error: res.error };
    },
  };
}

function buildDeps(): { store: NotificationStore; sender: NotificationSender } {
  return {
    store: createSupabaseNotificationStore(getSupabaseAdmin()),
    sender: createKapsoNotificationSender(getKapsoClient()),
  };
}

/**
 * Inicializa y despacha (server-only). Uso previsto (fases siguientes): checkout
 * `created:true` y reintento interno explícito. No se usará con `created:false`.
 */
export function initializeAndDispatchWebOrderWhatsApp(orderId: string): Promise<DispatchResult> {
  const { store, sender } = buildDeps();
  return initializeAndDispatch(store, sender, orderId);
}

/**
 * Despacha SOLO notificaciones existentes (server-only). Uso previsto: checkout
 * `created:false`. Nunca inicializa filas nuevas.
 */
export function dispatchExistingWebOrderWhatsApp(orderId: string): Promise<DispatchResult> {
  const { store, sender } = buildDeps();
  return dispatchExisting(store, sender, orderId);
}

/** Lee el estado de recuperación de un pedido (server-only). */
export function loadWebOrderNotificationStates(orderId: string): Promise<NotificationStatesResult> {
  return loadNotificationStates(getSupabaseAdmin(), orderId);
}

/** Programa el envío de una notificación concreta (server-only). */
export function scheduleWebOrderNotificationSend(
  orderId: string,
  notificationType: NotificationType,
): Promise<boolean> {
  return scheduleNotificationSend(getSupabaseAdmin(), orderId, notificationType);
}

// ============================================================================
// Reconciliación outbound (Fase 5.2D.5C) — wrappers de las RPC de 0005.
//
// Todos devuelven resultados tipados y saneados. Un resultado desconocido NUNCA
// autoriza un envío: se degrada a un valor seguro (unknown / no reclamado / no
// programado). Nunca devuelven teléfono, wamid completo, claim_token ni SQL.
// ============================================================================

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Resultados válidos de `mark_notification_sent_by_webhook`. */
const WEBHOOK_SENT_RESULTS: readonly WebhookSentResult[] = [
  'sent',
  'already_sent',
  'conflict',
  'not_found',
  'terminal',
  'manual_review_required',
  'duplicate_message_id',
  'invalid_state',
] as const;

/** `mark_notification_sent_by_webhook` (sin claim). */
export async function markNotificationSentByWebhook(
  supabase: SupabaseClient,
  orderId: string,
  notificationType: NotificationType,
  externalMessageId: string,
): Promise<WebhookSentResult> {
  const { data, error } = await supabase.rpc('mark_notification_sent_by_webhook', {
    p_order_id: orderId,
    p_notification_type: notificationType,
    p_external_message_id: externalMessageId,
  });
  if (error) throw new NotificationPersistenceError();
  const result = asRecord(data)?.result;
  return typeof result === 'string' &&
    (WEBHOOK_SENT_RESULTS as readonly string[]).includes(result)
    ? (result as WebhookSentResult)
    : 'unknown';
}

/** `claim_notification_reconciliation`. */
export async function claimNotificationReconciliation(
  supabase: SupabaseClient,
  orderId: string,
  notificationType: NotificationType,
): Promise<ClaimReconResult> {
  const { data, error } = await supabase.rpc('claim_notification_reconciliation', {
    p_order_id: orderId,
    p_notification_type: notificationType,
  });
  if (error) throw new NotificationPersistenceError();
  const d = asRecord(data);
  if (d === null) throw new NotificationPersistenceError();

  if (d.claimed === true) {
    if (typeof d.notification_id !== 'string' || typeof d.claim_token !== 'string') {
      throw new NotificationPersistenceError();
    }
    return { claimed: true, notificationId: d.notification_id, claimToken: d.claim_token };
  }
  return {
    claimed: false,
    reason: typeof d.reason === 'string' ? d.reason : undefined,
    status: typeof d.status === 'string' ? d.status : undefined,
  };
}

/** `mark_reconciliation_sent` con source `history`. */
export async function markReconciliationSent(
  supabase: SupabaseClient,
  notificationId: string,
  claimToken: string,
  externalMessageId: string,
): Promise<boolean> {
  const { data, error } = await supabase.rpc('mark_reconciliation_sent', {
    p_notification_id: notificationId,
    p_claim_token: claimToken,
    p_external_message_id: externalMessageId,
    p_source: 'history',
  });
  if (error) throw new NotificationPersistenceError();
  return data === true;
}

/**
 * `schedule_notification_retry`. Fija `p_reconciliation_outcome = 'not_found'`:
 * es el ÚNICO resultado que 0005 acepta como evidencia para reprogramar desde
 * `reconciling`. El endpoint nunca puede programar un reenvío por otra vía.
 */
export async function scheduleNotificationRetryFromReconcile(
  supabase: SupabaseClient,
  notificationId: string,
  claimToken: string,
  errorCode: string,
): Promise<ScheduleResult> {
  const { data, error } = await supabase.rpc('schedule_notification_retry', {
    p_notification_id: notificationId,
    p_claim_token: claimToken,
    p_error_code: errorCode,
    p_reconciliation_outcome: 'not_found',
  });
  if (error) throw new NotificationPersistenceError();
  const d = asRecord(data);
  return {
    scheduled: d?.scheduled === true,
    reason: typeof d?.reason === 'string' ? d.reason : undefined,
  };
}

/** `reschedule_notification_reconciliation`. */
export async function rescheduleNotificationReconciliation(
  supabase: SupabaseClient,
  notificationId: string,
  claimToken: string,
): Promise<RescheduleResult> {
  const { data, error } = await supabase.rpc('reschedule_notification_reconciliation', {
    p_notification_id: notificationId,
    p_claim_token: claimToken,
  });
  if (error) throw new NotificationPersistenceError();
  const d = asRecord(data);
  return {
    rescheduled: d?.rescheduled === true,
    reason: typeof d?.reason === 'string' ? d.reason : undefined,
  };
}

/**
 * `mark_notification_terminal`. `claimToken` puede ser `null` para cerrar una
 * fila NO reclamada (camino del webhook); si la fila está reclamada, la RPC
 * exige el token y devuelve `false` si no coincide.
 */
export async function markNotificationTerminal(
  supabase: SupabaseClient,
  notificationId: string,
  claimToken: string | null,
  errorCode: string,
  manualReview: boolean,
): Promise<boolean> {
  const { data, error } = await supabase.rpc('mark_notification_terminal', {
    p_notification_id: notificationId,
    p_claim_token: claimToken,
    p_error_code: errorCode,
    p_manual_review: manualReview,
  });
  if (error) throw new NotificationPersistenceError();
  return data === true;
}

/**
 * `terminalize_exhausted_reconciliation` (0006). Cierra a revisión manual un
 * `reconciling` stale con intentos agotados. No exige claim_token: la RPC
 * re-valida status/staleness/intentos de forma atómica. Nunca envía. Devuelve
 * `true` solo si la RPC cerró la fila.
 */
export async function terminalizeExhaustedReconciliation(
  supabase: SupabaseClient,
  orderId: string,
  notificationType: NotificationType,
): Promise<boolean> {
  const { data, error } = await supabase.rpc('terminalize_exhausted_reconciliation', {
    p_order_id: orderId,
    p_notification_type: notificationType,
  });
  if (error) throw new NotificationPersistenceError();
  return asRecord(data)?.terminalized === true;
}

/** Resuelve el id de una notificación por (order_id, tipo). `null` si no existe. */
async function resolveNotificationId(
  supabase: SupabaseClient,
  orderId: string,
  notificationType: NotificationType,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('order_notifications')
    .select('id')
    .eq('order_id', orderId)
    .eq('notification_type', notificationType)
    .maybeSingle();
  if (error) throw new NotificationPersistenceError();
  const id = asRecord(data)?.id;
  return typeof id === 'string' ? id : null;
}

/**
 * Store de reconciliación outbound (para el webhook). Localiza el pedido por su
 * número, cierra como enviada vía webhook, lee estados y cierra como terminal
 * una fila no reclamada.
 */
export function createSupabaseOutboundStore(
  supabase: SupabaseClient,
): OutboundReconciliationStore {
  return {
    async resolveOrder(orderNumber: string): Promise<ResolvedOrder | null> {
      const { data, error } = await supabase
        .from('orders')
        .select('id, customer_phone')
        .eq('order_number', orderNumber)
        .maybeSingle();
      if (error) throw new NotificationPersistenceError();
      const row = asRecord(data);
      if (row === null || typeof row.id !== 'string') return null;
      return {
        id: row.id,
        customerPhoneDigits: normalizePhone(String(row.customer_phone ?? '')),
      };
    },

    markSentByWebhook(orderId, notificationType, externalMessageId) {
      return markNotificationSentByWebhook(
        supabase,
        orderId,
        notificationType,
        externalMessageId,
      );
    },

    loadStates(orderId) {
      return loadNotificationStates(supabase, orderId);
    },

    async markTerminalByType(orderId, notificationType, errorCode, httpStatus, manualReview) {
      void httpStatus; // el webhook no persiste http status; se conserva la firma
      const id = await resolveNotificationId(supabase, orderId, notificationType);
      if (id === null) return false;
      return markNotificationTerminal(supabase, id, null, errorCode, manualReview);
    },
  };
}

/** Store outbound respaldado por el cliente admin (server-only). */
export function createWebOutboundStore(): OutboundReconciliationStore {
  return createSupabaseOutboundStore(getSupabaseAdmin());
}

/**
 * Carga el contexto de reconciliación de un pedido: número, destinatario
 * normalizado, phone_number_id del negocio y el estado de sus notificaciones.
 */
export async function loadReconcileContext(
  supabase: SupabaseClient,
  orderId: string,
): Promise<ReconcileContext | null> {
  const { data: orderData, error: orderError } = await supabase
    .from('orders')
    .select(
      'order_number, customer_phone, ' +
        'menu_session:menu_sessions!orders_menu_session_id_fk ( phone_number_id )',
    )
    .eq('id', orderId)
    .maybeSingle();
  if (orderError) throw new NotificationPersistenceError();
  const order = asRecord(orderData);
  if (order === null) return null;

  const session = unwrapToOne(order.menu_session);
  const phoneNumberId =
    typeof session?.phone_number_id === 'string' ? session.phone_number_id : '';

  const { data: notifData, error: notifError } = await supabase
    .from('order_notifications')
    .select('notification_type, status, last_attempt_at')
    .eq('order_id', orderId);
  if (notifError) throw new NotificationPersistenceError();

  const rows = (notifData ?? []) as unknown as Record<string, unknown>[];
  const toRow = (type: NotificationType): ReconcileRow | null => {
    const raw = rows.find((r) => r.notification_type === type);
    if (!raw) return null;
    const status = raw.status;
    if (typeof status !== 'string' || !(RECOVERY_STATUSES as readonly string[]).includes(status)) {
      return null;
    }
    return {
      notificationType: type,
      status: status as RecoveryStatus,
      lastAttemptAt: (raw.last_attempt_at as string | null) ?? null,
    };
  };

  return {
    orderNumber: String(order.order_number ?? ''),
    normalizedRecipient: normalizePhone(String(order.customer_phone ?? '')),
    phoneNumberId,
    orderReceived: toRow('order_received'),
    confirmation: toRow('confirmation'),
    locationRequest: toRow('location_request'),
  };
}

/** URL oficial de la API de Kapso (misma base que el envío). */
const DEFAULT_KAPSO_BASE_URL = 'https://api.kapso.ai/meta/whatsapp/v24.0';

/** Cliente de historial de Kapso construido desde el entorno (server-only). */
export function getKapsoMessageHistory(): ReturnType<typeof createKapsoMessageHistory> {
  const env = getServerEnv();
  if (!env.KAPSO_API_KEY || !env.KAPSO_PHONE_NUMBER_ID) {
    throw new NotificationPersistenceError();
  }
  return createKapsoMessageHistory({
    apiKey: env.KAPSO_API_KEY,
    phoneNumberId: env.KAPSO_PHONE_NUMBER_ID,
    baseUrl: env.KAPSO_API_BASE_URL ?? DEFAULT_KAPSO_BASE_URL,
  });
}

/**
 * Ensambla las dependencias de la reconciliación manual (server-only): Supabase
 * + `GET /messages` de Kapso. Ninguna envía mensajes.
 */
export function buildWebReconcileDeps(): ReconcileDeps {
  const supabase = getSupabaseAdmin();
  const history = getKapsoMessageHistory();
  return {
    loadContext: (orderId) => loadReconcileContext(supabase, orderId),
    claim: (orderId, type) => claimNotificationReconciliation(supabase, orderId, type),
    listOutbound: (query) => history.listOutbound(query),
    markSent: (id, token, ext) => markReconciliationSent(supabase, id, token, ext),
    scheduleRetry: (id, token, code) =>
      scheduleNotificationRetryFromReconcile(supabase, id, token, code),
    reschedule: (id, token) => rescheduleNotificationReconciliation(supabase, id, token),
    markTerminal: (id, token, code, manual) =>
      markNotificationTerminal(supabase, id, token, code, manual),
    terminalizeExhausted: (orderId, type) =>
      terminalizeExhaustedReconciliation(supabase, orderId, type),
  };
}

// ============================================================================
// Worker interno de recuperación (Fase 5.2D.5D) — wrappers + ensamblado.
// ============================================================================

/** Fila devuelta por `select_due_notification_orders`: solo un order_id. */
const dueOrderSchema = z.object({ order_id: z.uuid() });

/**
 * `select_due_notification_orders(limit)`. Devuelve SOLO order ids válidos, en
 * el orden de la RPC. Filas malformadas se ignoran (nunca autorizan trabajo).
 * El límite se acota al cupo del worker; no inicializa nada.
 */
export async function selectDueNotificationOrders(
  supabase: SupabaseClient,
  limit: number,
): Promise<string[]> {
  const safeLimit = Number.isInteger(limit) && limit >= 1 ? Math.min(limit, WORKER_ORDER_LIMIT) : 1;
  const { data, error } = await supabase.rpc('select_due_notification_orders', {
    p_limit: safeLimit,
  });
  if (error) throw new NotificationPersistenceError();
  if (!Array.isArray(data)) return [];
  const ids: string[] = [];
  for (const raw of data) {
    const parsed = dueOrderSchema.safeParse(raw);
    if (parsed.success) ids.push(parsed.data.order_id);
  }
  return ids;
}

/** `recover_stale_sending_notification`. No envía ni consulta historial. */
export async function recoverStaleNotification(
  supabase: SupabaseClient,
  orderId: string,
  notificationType: NotificationType,
): Promise<{ recovered: boolean; reason?: string }> {
  const { data, error } = await supabase.rpc('recover_stale_sending_notification', {
    p_order_id: orderId,
    p_notification_type: notificationType,
  });
  if (error) throw new NotificationPersistenceError();
  const d = asRecord(data);
  return {
    recovered: d?.recovered === true,
    reason: typeof d?.reason === 'string' ? d.reason : undefined,
  };
}

// ============================================================================
// Alertas Telegram (Fase 5.2D.5E.2) — wrappers de las RPC de 0007.
// Ninguno envía mensajes; solo persisten el ciclo de entrega de la alerta.
// ============================================================================

/** Fila de `select_due_notification_alerts`: solo un notification id. */
const dueAlertSchema = z.object({ notification_id: z.uuid() });

/** `select_due_notification_alerts(limit)` → notification ids válidos. */
export async function selectDueNotificationAlerts(
  supabase: SupabaseClient,
  limit: number,
): Promise<string[]> {
  const safeLimit = Number.isInteger(limit) && limit >= 1 ? Math.min(limit, WORKER_ORDER_LIMIT) : 1;
  const { data, error } = await supabase.rpc('select_due_notification_alerts', {
    p_limit: safeLimit,
  });
  if (error) throw new NotificationPersistenceError();
  if (!Array.isArray(data)) return [];
  const ids: string[] = [];
  for (const raw of data) {
    const parsed = dueAlertSchema.safeParse(raw);
    if (parsed.success) ids.push(parsed.data.notification_id);
  }
  return ids;
}

/** `claim_notification_alert`. Devuelve contexto sanitizado (sin datos personales). */
export async function claimNotificationAlert(
  supabase: SupabaseClient,
  notificationId: string,
): Promise<AlertClaimResult> {
  const { data, error } = await supabase.rpc('claim_notification_alert', {
    p_notification_id: notificationId,
  });
  if (error) throw new NotificationPersistenceError();
  const d = asRecord(data);
  if (d === null) throw new NotificationPersistenceError();

  if (d.claimed === true) {
    if (typeof d.notification_id !== 'string' || typeof d.claim_token !== 'string') {
      throw new NotificationPersistenceError();
    }
    return {
      claimed: true,
      notificationId: d.notification_id,
      claimToken: d.claim_token,
      notificationType: typeof d.notification_type === 'string' ? d.notification_type : undefined,
      orderNumber: typeof d.order_number === 'string' ? d.order_number : undefined,
      reasonCode: typeof d.reason_code === 'string' ? d.reason_code : undefined,
      reviewKind: typeof d.review_kind === 'string' ? d.review_kind : undefined,
    };
  }
  return { claimed: false, reason: typeof d.reason === 'string' ? d.reason : undefined };
}

/** `mark_notification_alerted`. */
export async function markNotificationAlerted(
  supabase: SupabaseClient,
  notificationId: string,
  claimToken: string,
): Promise<boolean> {
  const { data, error } = await supabase.rpc('mark_notification_alerted', {
    p_notification_id: notificationId,
    p_claim_token: claimToken,
  });
  if (error) throw new NotificationPersistenceError();
  return data === true;
}

/** `reschedule_notification_alert`. */
export async function rescheduleNotificationAlert(
  supabase: SupabaseClient,
  notificationId: string,
  claimToken: string,
  errorCode: string,
): Promise<AlertRescheduleResult> {
  const { data, error } = await supabase.rpc('reschedule_notification_alert', {
    p_notification_id: notificationId,
    p_claim_token: claimToken,
    p_error_code: errorCode,
    p_delay_seconds: ALERT_RETRY_DELAY_SECONDS,
  });
  if (error) throw new NotificationPersistenceError();
  const d = asRecord(data);
  return {
    rescheduled: d?.rescheduled === true,
    terminal: d?.terminal === true,
  };
}

/**
 * Ensambla las dependencias del pase de alertas (server-only). Devuelve `null`
 * si faltan las credenciales de Telegram: en ese caso el worker NO procesa
 * alertas (sin fetch) y el resto del tick queda intacto.
 */
export function buildAlertRunnerDeps(supabase: SupabaseClient): AlertRunnerDeps | null {
  const env = getServerEnv();
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return null;

  const sender = createTelegramAlertSender({
    botToken: env.TELEGRAM_BOT_TOKEN,
    chatId: env.TELEGRAM_CHAT_ID,
  });

  return {
    selectDueAlerts: (limit) => selectDueNotificationAlerts(supabase, limit),
    claimAlert: (id) => claimNotificationAlert(supabase, id),
    sendAlert: (text) => sender.send(text),
    markAlerted: (id, token) => markNotificationAlerted(supabase, id, token),
    rescheduleAlert: (id, token, code) => rescheduleNotificationAlert(supabase, id, token, code),
    now: () => Date.now(),
  };
}

/** Reserva de la invocación (60 s de maxDuration) menos margen de cierre. */
const WORKER_DEADLINE_MS = 55_000;

/**
 * Ensambla las dependencias del worker (server-only). Reúne selección, estados,
 * recuperación de stale, reconciliación por-notificación (con `GET /messages`) y
 * envío por-notificación (a lo sumo un POST). Ninguna inicializa notificaciones.
 */
export function buildWorkerDeps(): WorkerDeps {
  const supabase = getSupabaseAdmin();
  const reconcileDeps = buildWebReconcileDeps();
  const store = createSupabaseNotificationStore(supabase);
  const sender = createKapsoNotificationSender(getKapsoClient());
  const start = Date.now();

  return {
    selectDue: (limit) => selectDueNotificationOrders(supabase, limit),
    loadStates: (orderId) => loadNotificationStates(supabase, orderId),
    recoverStale: (orderId, type) => recoverStaleNotification(supabase, orderId, type),
    reconcileNotification: (orderId, type) => reconcileNotification(orderId, type, reconcileDeps),
    async sendNotification(orderId, type) {
      const r = await dispatchSingleNotification(store, sender, orderId, type);
      return { outcome: r.outcome, sendAttempted: r.sendAttempted };
    },
    now: () => Date.now(),
    deadline: start + WORKER_DEADLINE_MS,
    log: (event, fields) => log.info(`internal.order_notifications.${event}`, fields ?? {}),
    // Alertas Telegram: se omiten (undefined) si faltan credenciales → sin fetch.
    alerts: buildAlertRunnerDeps(supabase) ?? undefined,
  };
}
