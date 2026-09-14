import {
  MAX_NETWORK_SENDS_PER_WORKER_RUN,
  NOTIFICATION_SEND_TIMEOUT_MS,
  RESERVED_NON_NETWORK_MS,
} from './retry-policy';
import { DEFAULT_HISTORY_TIMEOUT_MS } from '@/lib/kapso/message-history';
import { planNotificationRetry, type NotificationStateRow, type NotificationStatesResult } from './retry-plan';
import type { ReconcileOutcome } from './reconcile-runner';
import type { NotificationType } from './recovery-state';
import { runAlertPass, MAX_ALERT_SENDS_PER_WORKER_RUN, type AlertRunnerDeps } from './alert-runner';

/**
 * Worker interno de recuperación de notificaciones (Fase 5.2D.5D) — orquestador
 * PURO. No hace E/S: recibe primitivas inyectadas y coordina presupuesto, orden
 * y ramas. La autoridad final es SIEMPRE la base (las RPC de 0005).
 *
 * INVARIANTES:
 *  - a lo sumo UN POST real a Kapso por tick (MAX_NETWORK_SENDS_PER_WORKER_RUN);
 *  - a lo sumo DOS `GET /messages` por tick;
 *  - confirmation SIEMPRE antes de location_request;
 *  - un `sending` stale se recupera y se DETIENE (no reenvía ni reconcilia en el
 *    mismo tick);
 *  - nunca inicializa notificaciones para pedidos históricos;
 *  - un claim rechazado NUNCA autoriza un envío;
 *  - alcanzar un límite no es error: el trabajo queda para otro tick;
 *  - una fila que la base ofrece como trabajo y que este worker NUNCA va a
 *    despachar se CIERRA, no se salta: saltarla sin escribir es un bucle.
 */

/** Cupo pequeño y constante de pedidos por ejecución. */
export const WORKER_ORDER_LIMIT = 5;
/** Máximo de lecturas de historial (`GET /messages`) por ejecución. */
export const MAX_HISTORY_READS_PER_WORKER_RUN = 2;

/**
 * Estados del pedido en los que ningún aviso de este worker tiene sentido.
 *
 * Los tres avisos —"recibimos tu pedido", "mándanos tu ubicación" y la
 * confirmación con el total— son de ANTES de cocina. Un pedido que ya se está
 * preparando, que salió, que se entregó o que se canceló no necesita ninguno, y
 * mandarlo tarde confunde al cliente en vez de ayudarle.
 */
export const ORDER_STATUSES_PAST_NOTIFICATIONS: readonly string[] = [
  'preparing',
  'ready',
  'on_the_way',
  'delivered',
  'cancelled',
];

/**
 * Antigüedad máxima de un pedido para que todavía se le mande un aviso: 3 h.
 *
 * La ventana más larga en la que un pedido vive legítimamente sin entrar a
 * cocina son los 45 min del carrito sin ubicación más las 2 h del QR sin pagar.
 * Pasadas 3 h, un pedido que sigue antes de cocina es uno al que los barridos
 * no llegaron —ya pasó el 09-09-2026—, y un aviso a esas horas no sirve de nada.
 *
 * El caso real que lo pidió (14-09-2026): un "recibimos tu pedido" que se
 * reconcilió QUINCE horas tarde, con el pedido ya listo.
 */
export const MAX_NOTIFICATION_AGE_MS = 3 * 60 * 60 * 1000;

/** Motivo de cierre por el estado o la edad del pedido. Nunca genera alerta. */
export type OrderCloseReason = 'order_already_closed' | 'notification_too_old';

/** Lo mínimo del pedido que el worker necesita para decidir si un aviso sigue vivo. */
export interface OrderLifecycle {
  status: string;
  /** ISO de `orders.created_at`. */
  createdAt: string;
}

/** Cómo cerrar una fila que no debe volver a ser trabajo. */
export interface NotificationClose {
  /** Estado leído al planificar: el cierre solo se aplica si sigue en él. */
  fromStatus: 'pending' | 'failed';
  /** Código corto del motivo, sin datos sensibles. */
  code: string;
  /**
   * `true` cuando no hay nada que alguien deba hacer (pedido cerrado o viejo):
   * la alerta de Telegram se apaga en la MISMA escritura. `false` deja que el
   * pase de alertas avise, porque un cliente con pedido vivo se quedó sin aviso.
   */
  silenceAlert: boolean;
}

/** Coste temporal estimado de cada operación de red, para el presupuesto. */
const SEND_COST_MS = NOTIFICATION_SEND_TIMEOUT_MS;
const HISTORY_COST_MS = DEFAULT_HISTORY_TIMEOUT_MS;
/** Reserva mínima para cerrar el tick con holgura. */
const RESERVE_MS = RESERVED_NON_NETWORK_MS;

/**
 * Motivos de rechazo de un `failed` que NO cambian solos: ni pasando el tiempo
 * ni en otro tick. Si la base lo ofrece como trabajo y el plan dice esto, la
 * fila se seleccionaría cada minuto para siempre.
 */
const STUCK_FAILED_REASONS: ReadonlySet<string> = new Set([
  'permanent_failure',
  'manual_review_required',
  'requires_reconciliation',
  'max_attempts_reached',
  'unknown',
]);

/**
 * Salidas del envío que tampoco cambian solas: el pedido no se puede cargar para
 * enviar (`not_initialized`) o el aviso no aplica a ese pedido (`not_applicable`,
 * una ubicación para un pedido de recojo).
 */
const DEAD_END_SEND_OUTCOMES: ReadonlySet<string> = new Set(['not_initialized', 'not_applicable']);

/** Acción global saneada por notificación. */
export type WorkerAction =
  | 'reconciled'
  | 'scheduled_retry'
  | 'sent'
  | 'recovered_stale'
  | 'skipped'
  | 'manual_review'
  | 'closed'
  | 'unknown';

export interface WorkerResultItem {
  notification_type: NotificationType | 'unknown';
  action: WorkerAction;
  /** Detalle corto y saneado (nunca datos sensibles). */
  outcome: string;
}

export interface WorkerTickResult {
  ok: true;
  selected: number;
  processed: number;
  history_reads: number;
  /** Intentos reales de POST a Kapso (sender invocado), no envíos exitosos. */
  network_send_attempts: number;
  budget_exhausted: boolean;
  /** Incidencias con alerta pendiente descubiertas este tick. */
  alerts_selected: number;
  /** Intentos reales de envío Telegram (sender invocado), no éxitos. */
  alert_send_attempts: number;
  /** Alertas marcadas como enviadas. */
  alerts_sent: number;
  /** Alertas reprogramadas tras un fallo de Telegram. */
  alerts_rescheduled: number;
  results: WorkerResultItem[];
}

/** Logger estructurado y saneado (solo recuentos/tipos/acciones). */
export type WorkerLog = (event: string, fields?: Record<string, unknown>) => void;

/**
 * Primitivas inyectadas. Ninguna recibe destino ni estado desde el caller: todo
 * se resuelve desde la base. La implementación real vive en `service.ts`.
 */
export interface WorkerDeps {
  /** `select_due_notification_orders(limit)` → order ids, en el orden de la RPC. */
  selectDue(limit: number): Promise<string[]>;
  /** Estado de recuperación de las notificaciones de un pedido. */
  loadStates(orderId: string): Promise<NotificationStatesResult>;
  /** Estado y fecha de creación del pedido. `null` si no existe. */
  loadOrderLifecycle(orderId: string): Promise<OrderLifecycle | null>;
  /**
   * Cierra UNA notificación sin reclamar que no debe volver a ser trabajo.
   * Condicional y atómico: devuelve `false` si la fila ya no está en
   * `close.fromStatus` (otro proceso la tomó), y entonces no se insiste.
   */
  closeNotification(
    orderId: string,
    notificationType: NotificationType,
    close: NotificationClose,
  ): Promise<boolean>;
  /** `recover_stale_sending_notification`. No envía ni consulta historial. */
  recoverStale(
    orderId: string,
    notificationType: NotificationType,
  ): Promise<{ recovered: boolean; reason?: string }>;
  /** Reconcilia UNA notificación con a lo sumo un `GET /messages`. */
  reconcileNotification(
    orderId: string,
    notificationType: NotificationType,
  ): Promise<{ outcome: ReconcileOutcome; historyRead: boolean }>;
  /**
   * Envía UNA notificación con a lo sumo un POST. `sendAttempted` = el sender
   * fue INVOCADO (el POST pudo iniciarse), aunque terminara en timeout/error o
   * fallara la persistencia posterior. NO significa éxito.
   */
  sendNotification(
    orderId: string,
    notificationType: NotificationType,
  ): Promise<{ outcome: string; sendAttempted: boolean }>;
  now(): number;
  /** Epoch ms límite de la invocación; sin él, no hay cota temporal. */
  deadline?: number;
  log?: WorkerLog;
  /**
   * Alertas Telegram (Fase 5.2D.5E.2). OPCIONAL: si no se inyecta (p. ej. sin
   * credenciales), el worker NO procesa alertas y su comportamiento anterior
   * queda intacto. El presupuesto de alerta es INDEPENDIENTE del de envío/GET.
   */
  alerts?: AlertRunnerDeps;
}

export interface WorkerConfig {
  orderLimit?: number;
  sendBudget?: number;
  historyBudget?: number;
  alertBudget?: number;
}

const MAX_RESULTS = 50;
const MAX_OUTCOME_LEN = 40;

function short(value: string): string {
  return value.length > MAX_OUTCOME_LEN ? value.slice(0, MAX_OUTCOME_LEN) : value;
}

/** Estado mutable del presupuesto del tick. */
interface Budget {
  send: number;
  history: number;
}

/** Puertas por operación: presupuesto restante Y tiempo suficiente. */
interface Gates {
  canSend: boolean;
  canHistory: boolean;
}

function rowOf(states: NotificationStatesResult, type: NotificationType): NotificationStateRow | null {
  return states.rows.find((r) => r.notificationType === type) ?? null;
}

/** ¿La fecha existe y ya venció? Una fecha ausente o ilegible nunca vence. */
function isDue(iso: string | null, now: number): boolean {
  if (iso === null) return false;
  const at = Date.parse(iso);
  return Number.isFinite(at) && at <= now;
}

/**
 * ¿Este pedido ya no debe recibir ningún aviso? Por estado primero —es la razón
 * más clara— y por edad después. Una fecha ilegible no cierra nada por edad.
 */
export function orderCloseReason(order: OrderLifecycle, now: number): OrderCloseReason | null {
  if (ORDER_STATUSES_PAST_NOTIFICATIONS.includes(order.status)) return 'order_already_closed';
  const createdAt = Date.parse(order.createdAt);
  if (Number.isFinite(createdAt) && now - createdAt > MAX_NOTIFICATION_AGE_MS) {
    return 'notification_too_old';
  }
  return null;
}

/** Mapea el resultado de reconciliación a acción + outcome saneados. */
function fromReconcile(outcome: ReconcileOutcome): { action: WorkerAction; outcome: string } {
  switch (outcome) {
    case 'matched':
      return { action: 'reconciled', outcome: 'matched' };
    case 'not_found':
      return { action: 'scheduled_retry', outcome: 'not_found' };
    case 'provider_failed':
      return { action: 'manual_review', outcome: 'provider_failed' };
    case 'ambiguous':
      return { action: 'reconciled', outcome: 'ambiguous' };
    case 'already_sent':
      return { action: 'skipped', outcome: 'already_sent' };
    case 'exhausted_terminal':
      // Reconciliación stale con intentos agotados: cerrada a revisión manual.
      return { action: 'manual_review', outcome: 'attempts_exhausted' };
    default:
      return { action: 'skipped', outcome: 'not_applicable' };
  }
}

type ProcessResult = { item: WorkerResultItem; sends: number; historyReads: number; budgetHit: boolean };

/**
 * Procesa UNA notificación según su estado persistido. Devuelve el item de
 * resultado y cuánto presupuesto consumió (0/1 envío, 0/1 lectura de historial).
 */
async function processNotification(
  deps: WorkerDeps,
  log: WorkerLog,
  orderId: string,
  type: NotificationType,
  row: NotificationStateRow,
  order: OrderLifecycle,
  gates: Gates,
  now: number,
): Promise<ProcessResult> {
  const mk = (action: WorkerAction, outcome: string): ProcessResult => ({
    item: { notification_type: type, action, outcome: short(outcome) },
    sends: 0,
    historyReads: 0,
    budgetHit: false,
  });

  /**
   * Saca la fila de la cola. Si el cierre no se aplica es porque otro proceso
   * cambió la fila entre la lectura y la escritura: lo que haya hecho manda, y
   * aquí no se insiste ni se envía.
   */
  const close = async (fromStatus: 'pending' | 'failed', code: string, silenceAlert: boolean) => {
    const closed = await deps.closeNotification(orderId, type, { fromStatus, code, silenceAlert });
    if (!closed) return mk('skipped', 'close_not_applied');
    log('notification_closed', { notification_type: type, outcome: short(code), alert: !silenceAlert });
    return mk('closed', code);
  };

  // Cierres explícitos: nunca se tocan automáticamente.
  if (row.terminalAt !== null) {
    log('notification_skipped', { notification_type: type, outcome: 'terminal' });
    return mk('skipped', 'terminal');
  }
  if (row.manualReviewRequired) {
    log('notification_manual_review', { notification_type: type });
    return mk('manual_review', 'manual_review_required');
  }

  // Freno de etapa y de antigüedad, ANTES de cualquier envío. Solo sobre filas
  // sin reclamar: un `sending` o una reconciliación siguen su camino, que nunca
  // envía y termina en un estado que este mismo freno cerrará después.
  if (row.status === 'pending' || row.status === 'failed') {
    const reason = orderCloseReason(order, now);
    if (reason !== null) return close(row.status, reason, true);
  }

  switch (row.status) {
    case 'sent':
      return mk('skipped', 'already_sent');

    // A. sending stale: recuperar y DETENER (no reenvía ni reconcilia este tick).
    case 'sending': {
      const rec = await deps.recoverStale(orderId, type);
      if (rec.recovered) {
        log('stale_recovered', { notification_type: type });
        return mk('recovered_stale', 'recovered');
      }
      // Fresco o no recuperable: no se toca.
      return mk('skipped', rec.reason ?? 'not_stale');
    }

    // B/C. reconciliación (pending_reconciliation o reconciling abandonado).
    case 'pending_reconciliation':
    case 'reconciling': {
      if (!gates.canHistory) {
        log('worker_budget_exhausted', { kind: 'history' });
        return { ...mk('skipped', 'history_budget_exhausted'), budgetHit: true };
      }
      const r = await deps.reconcileNotification(orderId, type);
      const used = r.historyRead ? 1 : 0;
      const mapped = fromReconcile(r.outcome);
      if (r.outcome === 'matched') log('reconciliation_matched', { notification_type: type });
      else if (r.outcome === 'not_found') log('reconciliation_not_found', { notification_type: type });
      else log('reconciliation_rescheduled', { notification_type: type, outcome: mapped.outcome });
      return {
        item: { notification_type: type, action: mapped.action, outcome: short(mapped.outcome) },
        sends: 0,
        historyReads: used,
        budgetHit: false,
      };
    }

    // D/E. envío programado (pending vencida o failed programada no ambigua).
    case 'pending':
    case 'failed': {
      // Solo un plan 'dispatch' autoriza enviar: pending, o failed ya programada
      // y vencida no ambigua. `schedule_then_dispatch` y cualquier reject NO se
      // envían aquí (el worker no arma retries: §5.G).
      const plan = planNotificationRetry(row, now);
      if (plan.action !== 'dispatch') {
        const reason = plan.action === 'reject' ? (plan.reason ?? 'not_dispatchable') : 'not_scheduled';

        // ── El bucle del 14-09-2026 ────────────────────────────────────────
        //
        // Un `failed` con reintento VENCIDO es exactamente lo que la base
        // ofrece como trabajo. Si el plan dice que nunca se despachará,
        // saltarlo sin escribir hace que vuelva el minuto siguiente, y el
        // siguiente, ocupando uno de los cinco lugares del tick. Se cierra, y
        // la alerta se deja encendida: el pedido está vivo y su cliente se
        // quedó sin un aviso que nadie va a mandar.
        //
        // Sin reintento vencido la base no lo ofrece: no hay bucle y no se toca.
        if (row.status === 'failed' && STUCK_FAILED_REASONS.has(reason) && isDue(row.nextAttemptAt, now)) {
          return close('failed', reason, false);
        }
        return mk('skipped', reason);
      }
      if (!gates.canSend) {
        log('worker_budget_exhausted', { kind: 'send' });
        return { ...mk('skipped', 'send_budget_exhausted'), budgetHit: true };
      }
      const r = await deps.sendNotification(orderId, type);
      // El cupo se consume por INTENTO (sender invocado), no por éxito: si el
      // POST se inició y expiró, no debe iniciarse un segundo POST en el tick.
      const sends = r.sendAttempted ? 1 : 0;
      if (r.outcome === 'sent') {
        log('notification_sent', { notification_type: type });
        return { item: { notification_type: type, action: 'sent', outcome: 'sent' }, sends, historyReads: 0, budgetHit: false };
      }
      // Un envío que ni llegó a intentarse porque el pedido no se puede cargar,
      // o porque el aviso no le corresponde, dará lo mismo en cada tick. Solo
      // `not_applicable` se cierra en silencio: `not_initialized` es un pedido
      // que debería poder avisarse y no puede, y eso sí hay que saberlo.
      if (!r.sendAttempted && DEAD_END_SEND_OUTCOMES.has(r.outcome)) {
        return close(row.status, r.outcome, r.outcome === 'not_applicable');
      }
      // Intento sin éxito confirmado (timeout/ambiguo/carrera): se reporta el
      // outcome real y el intento YA consumió el cupo.
      log('notification_skipped', { notification_type: type, outcome: short(r.outcome) });
      return { item: { notification_type: type, action: 'skipped', outcome: short(r.outcome) }, sends, historyReads: 0, budgetHit: false };
    }

    default:
      // Estado que este código no conoce: nunca se envía.
      return mk('skipped', 'unknown');
  }
}

/**
 * Ejecuta un tick del worker. NO lanza salvo que falle la SELECCIÓN inicial de
 * trabajo (ahí el caller responde 500). Un fallo aislado de un pedido se aísla y
 * se reporta dentro de `results`.
 */
export async function runWorkerTick(
  deps: WorkerDeps,
  cfg: WorkerConfig = {},
): Promise<WorkerTickResult> {
  const log = deps.log ?? (() => {});
  const orderLimit = clampLimit(cfg.orderLimit ?? WORKER_ORDER_LIMIT);
  const budget: Budget = {
    send: cfg.sendBudget ?? MAX_NETWORK_SENDS_PER_WORKER_RUN,
    history: cfg.historyBudget ?? MAX_HISTORY_READS_PER_WORKER_RUN,
  };

  log('worker_started', {});
  // Un fallo aquí PROPAGA: el worker no pudo siquiera obtener trabajo → 500.
  const orderIds = await deps.selectDue(orderLimit);
  log('work_selected', { selected: orderIds.length });

  const results: WorkerResultItem[] = [];
  let historyReads = 0;
  let networkSendAttempts = 0;
  let budgetExhausted = false;

  const remaining = () => (deps.deadline != null ? deps.deadline - deps.now() : Number.POSITIVE_INFINITY);
  // Puerta por operación: presupuesto restante Y tiempo suficiente para su coste.
  const gates = (): Gates => ({
    canSend: budget.send > 0 && remaining() >= SEND_COST_MS,
    canHistory: budget.history > 0 && remaining() >= HISTORY_COST_MS,
  });

  for (const orderId of orderIds) {
    // No iniciar trabajo nuevo si no queda tiempo ni para la operación más barata.
    if (remaining() < HISTORY_COST_MS + RESERVE_MS) {
      budgetExhausted = true;
      log('worker_budget_exhausted', { kind: 'time' });
      break;
    }

    let states: NotificationStatesResult;
    let order: OrderLifecycle | null;
    try {
      states = await deps.loadStates(orderId);
      order = await deps.loadOrderLifecycle(orderId);
    } catch {
      // Fallo aislado de un pedido: no tumba el tick.
      log('worker_error', { stage: 'load_states' });
      pushCapped(results, { notification_type: 'unknown', action: 'skipped', outcome: 'order_error' });
      continue;
    }

    // Sin saber en qué estado está el pedido no se decide nada sobre él: ni se
    // envía —podría estar cancelado— ni se cierra —podría estar vivo—.
    if (order === null) {
      log('worker_error', { stage: 'load_order' });
      pushCapped(results, { notification_type: 'unknown', action: 'skipped', outcome: 'order_error' });
      continue;
    }
    const lifecycle = order;

    if (states.unknownStateCount > 0) {
      pushCapped(results, { notification_type: 'unknown', action: 'skipped', outcome: 'unknown_state' });
    }

    const orderReceivedRow = rowOf(states, 'order_received');
    const confirmationRow = rowOf(states, 'confirmation');
    const locationRow = rowOf(states, 'location_request');

    /** Procesa una fila aislando su fallo; actualiza presupuesto y contadores. */
    const runRow = async (type: NotificationType, row: NotificationStateRow) => {
      try {
        const r = await processNotification(deps, log, orderId, type, row, lifecycle, gates(), deps.now());
        applyResult(results, budget, r);
        historyReads += r.historyReads;
        networkSendAttempts += r.sends;
        budgetExhausted = budgetExhausted || r.budgetHit;
      } catch {
        log('worker_error', { stage: type });
        pushCapped(results, { notification_type: type, action: 'skipped', outcome: 'error' });
      }
    };

    // Pedido que ya no debe recibir avisos: se recorren TODAS sus filas, sin
    // bloqueos de orden. El orden existe para no mandar la ubicación antes que
    // su aviso previo, y aquí no se va a mandar nada: bloquear la ubicación
    // detrás de un `order_received` que se está cerrando la dejaría abierta.
    if (orderCloseReason(lifecycle, deps.now()) !== null) {
      for (const [type, row] of [
        ['order_received', orderReceivedRow],
        ['confirmation', confirmationRow],
        ['location_request', locationRow],
      ] as const) {
        if (row) await runRow(type, row);
      }
      continue;
    }

    if (orderReceivedRow) {
      // 6D.2C — delivery DINÁMICO: order_received → location_request → confirmation.
      // La decisión de la ubicación usa el estado de order_received AL INICIO del
      // tick (además del guard DB-side); la confirmación la gatea la RPC (quoted).
      const orderReceivedSentAtStart = orderReceivedRow.status === 'sent';

      await runRow('order_received', orderReceivedRow);

      if (locationRow) {
        if (!orderReceivedSentAtStart) {
          pushCapped(results, {
            notification_type: 'location_request',
            action: 'skipped',
            outcome: 'blocked_by_order_received',
          });
        } else {
          await runRow('location_request', locationRow);
        }
      }

      if (confirmationRow) {
        // El claim (0013) rechaza la confirmación hasta que el pedido esté quoted.
        await runRow('confirmation', confirmationRow);
      }
    } else {
      // LEGACY / pickup: confirmation → location_request (comportamiento actual).
      const confirmationSentAtStart = confirmationRow?.status === 'sent';

      if (confirmationRow) {
        await runRow('confirmation', confirmationRow);
      }

      if (locationRow) {
        if (!confirmationSentAtStart) {
          pushCapped(results, {
            notification_type: 'location_request',
            action: 'skipped',
            outcome: 'blocked_by_confirmation',
          });
        } else {
          await runRow('location_request', locationRow);
        }
      }
    }
  }

  // Pase de alertas DESPUÉS de la recuperación, con presupuesto propio. Aislado:
  // un fallo aquí nunca tumba el tick ni afecta a la recuperación ya hecha. Sin
  // deps de alerta (sin credenciales), no se procesa ninguna alerta.
  let alerts = { alerts_selected: 0, alert_send_attempts: 0, alerts_sent: 0, alerts_rescheduled: 0 };
  if (deps.alerts) {
    try {
      alerts = await runAlertPass(
        deps.alerts,
        cfg.alertBudget ?? MAX_ALERT_SENDS_PER_WORKER_RUN,
        log,
        orderLimit,
      );
    } catch {
      log('alert_error', { stage: 'alert_pass' });
    }
  }

  log('worker_finished', {
    selected: orderIds.length,
    processed: results.length,
    history_reads: historyReads,
    network_send_attempts: networkSendAttempts,
    budget_exhausted: budgetExhausted,
    alerts_selected: alerts.alerts_selected,
    alert_send_attempts: alerts.alert_send_attempts,
    alerts_sent: alerts.alerts_sent,
    alerts_rescheduled: alerts.alerts_rescheduled,
  });

  return {
    ok: true,
    selected: orderIds.length,
    processed: results.length,
    history_reads: historyReads,
    network_send_attempts: networkSendAttempts,
    budget_exhausted: budgetExhausted,
    alerts_selected: alerts.alerts_selected,
    alert_send_attempts: alerts.alert_send_attempts,
    alerts_sent: alerts.alerts_sent,
    alerts_rescheduled: alerts.alerts_rescheduled,
    results,
  };
}

function clampLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1) return 1;
  return Math.min(limit, WORKER_ORDER_LIMIT);
}

function pushCapped(results: WorkerResultItem[], item: WorkerResultItem): void {
  if (results.length < MAX_RESULTS) results.push(item);
}

/** Aplica el item y descuenta el presupuesto realmente consumido. */
function applyResult(
  results: WorkerResultItem[],
  budget: Budget,
  r: { item: WorkerResultItem; sends: number; historyReads: number },
): void {
  pushCapped(results, r.item);
  budget.send -= r.sends;
  budget.history -= r.historyReads;
}
