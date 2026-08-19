import {
  reconcileOutbound,
  DEFAULT_MATCH_WINDOW_MS,
  DEFAULT_CLOCK_SKEW_MS,
} from './reconciliation';
import {
  normalizeOutboundMessage,
  type MessageHistoryResult,
  type ListOutboundQuery,
} from '@/lib/kapso/message-history';
import type { RecoveryStatus, NotificationType } from './recovery-state';

/**
 * Orquestador PURO de la reconciliación manual de un pedido (Fase 5.2D.5C).
 *
 * Para cada notificación `pending_reconciliation` (o `reconciling` abandonada)
 * decide, mediante `GET /messages` + `reconcileOutbound`, si el mensaje ya salió.
 * NUNCA envía: solo consulta el historial y persiste con las RPC de 0005.
 *
 * Garantías:
 *  - a lo sumo UNA consulta de historial por notificación;
 *  - CERO envíos;
 *  - `confirmation` antes de `location_request`; la ubicación no se reconcilia
 *    si la confirmación no quedó `sent`/`matched`;
 *  - un error consultando el historial se reprograma, jamás se disfraza de
 *    `not_found`.
 */

/** Resultado saneado por notificación. */
export type ReconcileOutcome =
  | 'matched'
  | 'not_found'
  | 'ambiguous'
  | 'provider_failed'
  | 'not_applicable'
  | 'already_sent'
  /**
   * Un `reconciling` abandonado (claim stale) que ya AGOTÓ sus intentos: no puede
   * reclamarse de nuevo ni tiene dueño del claim_token, así que se cierra a
   * revisión manual de forma atómica. Cero GET y cero envío.
   */
  | 'exhausted_terminal';

/** Vista mínima de una fila para reconciliar. Sin datos sensibles. */
export interface ReconcileRow {
  notificationType: NotificationType;
  status: RecoveryStatus;
  /** Inicio del intento de envío: ancla de la ventana de búsqueda. */
  lastAttemptAt: string | null;
}

/** Contexto del pedido necesario para reconciliar. */
export interface ReconcileContext {
  orderNumber: string;
  /** Teléfono del pedido, normalizado a dígitos. */
  normalizedRecipient: string;
  /** phone_number_id del negocio (de menu_sessions). */
  phoneNumberId: string;
  /** 6D.2C: recepción del pedido (solo delivery dinámico; `null` en legacy/pickup). */
  orderReceived: ReconcileRow | null;
  confirmation: ReconcileRow | null;
  locationRequest: ReconcileRow | null;
}

/** Reclamo de reconciliación (`claim_notification_reconciliation`). */
export type ClaimReconResult =
  | { claimed: true; notificationId: string; claimToken: string }
  | { claimed: false; reason?: string; status?: string };

/** Resultado de una RPC que reporta `{ scheduled, reason }`. */
export interface ScheduleResult {
  scheduled: boolean;
  reason?: string;
}

/** Resultado de una RPC que reporta `{ rescheduled, reason }`. */
export interface RescheduleResult {
  rescheduled: boolean;
  reason?: string;
}

/**
 * Dependencias inyectadas. Ninguna envía mensajes. La implementación real vive
 * en `service.ts` (Supabase + `GET /messages` de Kapso).
 */
export interface ReconcileDeps {
  loadContext(orderId: string): Promise<ReconcileContext | null>;
  claim(orderId: string, notificationType: NotificationType): Promise<ClaimReconResult>;
  listOutbound(query: ListOutboundQuery): Promise<MessageHistoryResult>;
  /** `mark_reconciliation_sent` con source `history`. */
  markSent(
    notificationId: string,
    claimToken: string,
    externalMessageId: string,
  ): Promise<boolean>;
  /** `schedule_notification_retry` (solo se llama con outcome `not_found`). */
  scheduleRetry(
    notificationId: string,
    claimToken: string,
    errorCode: string,
  ): Promise<ScheduleResult>;
  /** `reschedule_notification_reconciliation`. */
  reschedule(notificationId: string, claimToken: string): Promise<RescheduleResult>;
  /** `mark_notification_terminal` (cierre con posible revisión manual). */
  markTerminal(
    notificationId: string,
    claimToken: string,
    errorCode: string,
    manualReview: boolean,
  ): Promise<boolean>;
  /**
   * `terminalize_exhausted_reconciliation` (0006). Cierre atómico y saneado de un
   * `reconciling` stale que agotó intentos: NO exige claim_token (nadie lo posee),
   * la RPC re-valida status/staleness/intentos. NUNCA envía. Devuelve `true` si
   * cerró la fila.
   */
  terminalizeExhausted(
    orderId: string,
    notificationType: NotificationType,
  ): Promise<boolean>;
  now?(): number;
}

export interface OrderReconcileResult {
  ok: boolean;
  /** 6D.2C: solo en delivery dinámico; `not_applicable` en legacy/pickup. */
  orderReceived: ReconcileOutcome;
  confirmation: ReconcileOutcome;
  locationRequest: ReconcileOutcome;
  reason: string | null;
}

/** Código no ambiguo que queda en la fila cuando el historial confirma que no salió. */
const NOT_FOUND_CODE = 'reconciled_not_found';
/** Código de cierre cuando la reconciliación no puede concluir. */
const UNRESOLVED_CODE = 'reconciliation_unresolved';
const PROVIDER_FAILED_CODE = 'provider_failed';

/** Estados que ya no requieren reconciliación (nada que hacer aquí). */
function nonReconcilableOutcome(status: RecoveryStatus): ReconcileOutcome {
  return status === 'sent' ? 'already_sent' : 'not_applicable';
}

/** Un claim rechazado se traduce a un outcome saneado, nunca a un envío. */
function outcomeFromDeniedClaim(claim: Extract<ClaimReconResult, { claimed: false }>): ReconcileOutcome {
  if (claim.status === 'sent') return 'already_sent';
  // terminal / manual_review_required / max_attempts_reached: requieren humano.
  if (
    claim.reason === 'terminal' ||
    claim.reason === 'manual_review_required' ||
    claim.reason === 'max_attempts_reached'
  ) {
    return 'ambiguous';
  }
  // confirmation_not_sent, not_available, o simplemente no vencida: nada que hacer.
  return 'not_applicable';
}

/**
 * Reconcilia UNA notificación ya reclamada consultando el historial una sola vez.
 */
async function reconcileClaimed(
  ctx: ReconcileContext,
  type: NotificationType,
  row: ReconcileRow,
  claim: Extract<ClaimReconResult, { claimed: true }>,
  deps: ReconcileDeps,
  now: number,
): Promise<ReconcileOutcome> {
  const startMs = row.lastAttemptAt !== null ? Date.parse(row.lastAttemptAt) : NaN;
  const anchorMs = Number.isFinite(startMs) ? startMs : now - DEFAULT_MATCH_WINDOW_MS;
  const since = new Date(anchorMs - DEFAULT_CLOCK_SKEW_MS).toISOString();
  const until = new Date(now).toISOString();

  const history = await deps.listOutbound({
    since,
    until,
    phoneNumberId: ctx.phoneNumberId,
    limit: 100,
  });

  // Error consultando el historial: se reprograma. NUNCA se disfraza de not_found.
  if (!history.ok) {
    await deps.reschedule(claim.notificationId, claim.claimToken);
    return 'ambiguous';
  }

  const candidates = history.messages
    .map((raw) => normalizeOutboundMessage(raw))
    .filter((m): m is NonNullable<typeof m> => m !== null);

  const decision = reconcileOutbound({
    orderNumber: ctx.orderNumber,
    normalizedRecipient: ctx.normalizedRecipient,
    notificationType: type,
    attemptStartedAt: new Date(anchorMs).toISOString(),
    candidates,
  });

  switch (decision.result) {
    case 'matched': {
      await deps.markSent(claim.notificationId, claim.claimToken, decision.externalMessageId);
      return 'matched';
    }
    case 'not_found': {
      // Único resultado que autoriza reintento (queda next_attempt_at para el
      // futuro worker). No se envía aquí.
      const scheduled = await deps.scheduleRetry(
        claim.notificationId,
        claim.claimToken,
        NOT_FOUND_CODE,
      );
      return scheduled.scheduled ? 'not_found' : 'ambiguous';
    }
    case 'provider_failed': {
      // Evidencia de un mensaje fallido: no hay un id único que reenviar sin
      // decisión humana y la RPC no autoriza reintento desde 'reconciling' salvo
      // not_found. Se cierra para revisión manual; nunca se envía.
      await deps.markTerminal(
        claim.notificationId,
        claim.claimToken,
        PROVIDER_FAILED_CODE,
        true,
      );
      return 'provider_failed';
    }
    case 'ambiguous': {
      // No se elige candidato. Se reprograma una revisión; si ya no quedan
      // intentos, se cierra a revisión manual.
      const re = await deps.reschedule(claim.notificationId, claim.claimToken);
      if (!re.rescheduled && re.reason === 'max_attempts_reached') {
        await deps.markTerminal(claim.notificationId, claim.claimToken, UNRESOLVED_CODE, true);
      }
      return 'ambiguous';
    }
  }
}

/** ¿La fase previa quedó cubierta (enviada o coincidida) para habilitar la siguiente? */
function phaseReady(outcome: ReconcileOutcome, rowStatus: RecoveryStatus | undefined): boolean {
  return outcome === 'matched' || outcome === 'already_sent' || rowStatus === 'sent';
}

/**
 * Reconcilia un pedido completo. Respeta el orden por flujo:
 *  - dinámico (6D.2C): order_received → location_request → confirmation. La
 *    ubicación solo se reconcilia si order_received quedó enviado; la confirmación
 *    depende del gate DB (quoted).
 *  - legacy: confirmation → location_request (dependencia DB-side actual).
 */
export async function reconcileOrder(
  orderId: string,
  deps: ReconcileDeps,
): Promise<OrderReconcileResult> {
  const now = deps.now ? deps.now() : Date.now();
  const ctx = await deps.loadContext(orderId);

  // Sin contexto o sin ninguna notificación: no se inicializa nada.
  if (
    ctx === null ||
    (ctx.orderReceived === null && ctx.confirmation === null && ctx.locationRequest === null)
  ) {
    return {
      ok: false,
      orderReceived: 'not_applicable',
      confirmation: 'not_applicable',
      locationRequest: 'not_applicable',
      reason: 'not_found',
    };
  }

  // Delivery dinámico: la presencia de la fila order_received lo identifica.
  if (ctx.orderReceived !== null) {
    const orderReceived = (await runType(orderId, ctx, ctx.orderReceived, 'order_received', deps, now)).outcome;
    const receivedReady = phaseReady(orderReceived, ctx.orderReceived?.status);

    let locationRequest: ReconcileOutcome = 'not_applicable';
    if (ctx.locationRequest !== null) {
      locationRequest = receivedReady
        ? (await runType(orderId, ctx, ctx.locationRequest, 'location_request', deps, now)).outcome
        : 'not_applicable';
    }

    // La confirmación la gatea la RPC de claim (quoted); si no procede, el claim
    // se rechaza sin consultar historial.
    let confirmation: ReconcileOutcome = 'not_applicable';
    if (ctx.confirmation !== null) {
      confirmation = (await runType(orderId, ctx, ctx.confirmation, 'confirmation', deps, now)).outcome;
    }

    return { ok: true, orderReceived, confirmation, locationRequest, reason: null };
  }

  // Legacy: confirmation → location_request.
  const confirmation = (await runType(orderId, ctx, ctx.confirmation, 'confirmation', deps, now)).outcome;
  const confirmationReady = phaseReady(confirmation, ctx.confirmation?.status);

  let locationRequest: ReconcileOutcome = 'not_applicable';
  if (ctx.locationRequest !== null) {
    locationRequest = confirmationReady
      ? (await runType(orderId, ctx, ctx.locationRequest, 'location_request', deps, now)).outcome
      : 'not_applicable';
  }

  return { ok: true, orderReceived: 'not_applicable', confirmation, locationRequest, reason: null };
}

/** Resultado de reconciliar UNA notificación. `historyRead` = hubo un GET. */
export interface SingleReconcileResult {
  outcome: ReconcileOutcome;
  /** `true` si se consultó `GET /messages` (solo ocurre si el claim fue concedido). */
  historyRead: boolean;
}

async function runType(
  orderId: string,
  ctx: ReconcileContext,
  row: ReconcileRow | null,
  type: NotificationType,
  deps: ReconcileDeps,
  now: number,
): Promise<SingleReconcileResult> {
  if (row === null) return { outcome: 'not_applicable', historyRead: false };
  if (row.status === 'sent') return { outcome: 'already_sent', historyRead: false };
  if (row.status !== 'pending_reconciliation' && row.status !== 'reconciling') {
    return { outcome: nonReconcilableOutcome(row.status), historyRead: false };
  }

  const claim = await deps.claim(orderId, type);
  // Un claim rechazado NUNCA consulta el historial: no consume presupuesto.
  if (!claim.claimed) {
    // Caso límite: un `reconciling` stale que agotó intentos ya no es reclamable
    // (la RPC de claim devuelve max_attempts_reached) y conserva un claim_token
    // sin dueño, de modo que mark_notification_terminal (que exige el token) no
    // puede cerrarlo. Se cierra con la RPC dedicada, que re-valida atómicamente
    // status='reconciling' + claim stale + intentos agotados. Cero GET, cero envío.
    if (claim.reason === 'max_attempts_reached' && row.status === 'reconciling') {
      const closed = await deps.terminalizeExhausted(orderId, type);
      if (closed) return { outcome: 'exhausted_terminal', historyRead: false };
    }
    return { outcome: outcomeFromDeniedClaim(claim), historyRead: false };
  }

  const outcome = await reconcileClaimed(ctx, type, row, claim, deps, now);
  return { outcome, historyRead: true };
}

/**
 * Reconcilia UNA notificación concreta de un pedido (Fase 5.2D.5D, para el
 * worker). Carga el contexto, localiza la fila del tipo pedido y la reconcilia
 * con a lo sumo UN `GET /messages`. Nunca inicializa filas ni envía.
 *
 * La dependencia de orden la impone la RPC de claim (rechaza `location_request`
 * si la confirmación no está enviada), de modo que llamar aquí a `location_request`
 * antes de tiempo devuelve `not_applicable` sin consultar el historial.
 */
export async function reconcileNotification(
  orderId: string,
  type: NotificationType,
  deps: ReconcileDeps,
): Promise<SingleReconcileResult> {
  const now = deps.now ? deps.now() : Date.now();
  const ctx = await deps.loadContext(orderId);
  if (ctx === null) return { outcome: 'not_applicable', historyRead: false };
  const row =
    type === 'order_received'
      ? ctx.orderReceived
      : type === 'confirmation'
        ? ctx.confirmation
        : ctx.locationRequest;
  return runType(orderId, ctx, row, type, deps, now);
}
