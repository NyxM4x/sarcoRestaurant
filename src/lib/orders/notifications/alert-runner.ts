import type { TelegramOutcome } from '@/lib/alerts/telegram';
import { buildAlertMessage } from '@/lib/alerts/alert-message';

/**
 * Orquestador PURO del envío de alertas de incidencias (Fase 5.2D.5E.2).
 *
 * Se ejecuta DESPUÉS del trabajo de recuperación del worker, con presupuesto
 * PROPIO e independiente (a lo sumo UN envío Telegram por tick). Nunca llama a
 * Kapso ni consulta `GET /messages`; una alerta jamás habilita un envío de
 * WhatsApp. Un fallo de Telegram solo reprograma la ALERTA, nunca toca la
 * notificación de WhatsApp. La deduplicación real vive en el claim atómico (0007).
 */

/** A lo sumo un envío Telegram por ejecución del worker. */
export const MAX_ALERT_SENDS_PER_WORKER_RUN = 1;
/** Retraso por defecto al reprogramar una alerta fallida. */
export const ALERT_RETRY_DELAY_SECONDS = 300;

export interface AlertClaimResult {
  claimed: boolean;
  notificationId?: string;
  claimToken?: string;
  notificationType?: string;
  orderNumber?: string;
  reasonCode?: string;
  reviewKind?: string;
  reason?: string;
}

export interface AlertRescheduleResult {
  rescheduled: boolean;
  terminal: boolean;
}

/** Primitivas inyectadas. La implementación real vive en `service.ts`. */
export interface AlertRunnerDeps {
  /** `select_due_notification_alerts(limit)` → notification ids. */
  selectDueAlerts(limit: number): Promise<string[]>;
  /** `claim_notification_alert`. Devuelve contexto sanitizado. */
  claimAlert(notificationId: string): Promise<AlertClaimResult>;
  /** Envía el texto por Telegram (a lo sumo una vez por tick). */
  sendAlert(text: string): Promise<TelegramOutcome>;
  /** `mark_notification_alerted`. */
  markAlerted(notificationId: string, claimToken: string): Promise<boolean>;
  /** `reschedule_notification_alert`. */
  rescheduleAlert(
    notificationId: string,
    claimToken: string,
    errorCode: string,
  ): Promise<AlertRescheduleResult>;
  now(): number;
}

export interface AlertPassResult {
  alerts_selected: number;
  alert_send_attempts: number;
  alerts_sent: number;
  alerts_rescheduled: number;
}

export type AlertLog = (event: string, fields?: Record<string, unknown>) => void;

const MAX_CODE_LEN = 40;
const short = (v: string) => (v.length > MAX_CODE_LEN ? v.slice(0, MAX_CODE_LEN) : v);

/** Código sanitizado que se persiste al reprogramar, según el resultado. */
function errorCodeFor(outcome: Exclude<TelegramOutcome, { kind: 'sent' }>): string {
  switch (outcome.kind) {
    case 'rate_limited':
      return 'telegram_rate_limited';
    case 'permanent':
      return 'telegram_permanent';
    case 'transient':
      return 'telegram_transient';
    case 'invalid':
      return 'telegram_invalid';
  }
}

/** Marca como alertada SIN propagar: un throw aquí es POSTERIOR a un envío OK. */
async function safeMarkAlerted(mark: () => Promise<boolean>): Promise<boolean> {
  try {
    return await mark();
  } catch {
    return false;
  }
}

const emptyResult = (): AlertPassResult => ({
  alerts_selected: 0,
  alert_send_attempts: 0,
  alerts_sent: 0,
  alerts_rescheduled: 0,
});

/**
 * Procesa alertas pendientes. Devuelve contadores saneados. A lo sumo un envío
 * Telegram (budget). Un fallo aislado por alerta no aborta el resto.
 */
export async function runAlertPass(
  deps: AlertRunnerDeps,
  budget: number,
  log: AlertLog,
  limit: number,
): Promise<AlertPassResult> {
  const result = emptyResult();
  let sendBudget = budget;

  const ids = await deps.selectDueAlerts(limit);
  result.alerts_selected = ids.length;
  log('alert_work_selected', { selected: ids.length });

  for (const id of ids) {
    if (sendBudget <= 0) {
      log('alert_budget_exhausted', {});
      break;
    }

    try {
      const claim = await deps.claimAlert(id);
      if (!claim.claimed || !claim.claimToken) {
        // Un claim no concedido NUNCA consume presupuesto ni envía.
        log('alert_skipped', { reason: short(claim.reason ?? 'not_claimed') });
        continue;
      }

      const text = buildAlertMessage({
        orderNumber: claim.orderNumber ?? '',
        notificationType: claim.notificationType ?? 'unknown',
        reasonCode: claim.reasonCode ?? '',
        reviewKind: claim.reviewKind ?? 'manual_review',
        now: deps.now(),
      });

      // El presupuesto se consume por INTENTO: en cuanto se invoca el sender no
      // habrá un segundo envío en este tick, aunque falle.
      sendBudget -= 1;
      result.alert_send_attempts += 1;
      const outcome = await deps.sendAlert(text);

      if (outcome.kind === 'sent') {
        const marked = await safeMarkAlerted(() => deps.markAlerted(id, claim.claimToken!));
        if (marked) {
          result.alerts_sent += 1;
          log('alert_sent', { notification_type: claim.notificationType ?? 'unknown' });
        } else {
          // Envío OK pero persistencia falló/idempotente: ambiguo. No se reenvía
          // en este tick; el claim caducará y podrá recuperarse (at-least-once).
          log('alert_error', { reason: 'persist_after_send' });
        }
        continue;
      }

      // Envío no exitoso: se reprograma la ALERTA (nunca la notificación WhatsApp).
      const code = errorCodeFor(outcome);
      const r = await deps.rescheduleAlert(id, claim.claimToken, code);
      if (r.rescheduled) {
        result.alerts_rescheduled += 1;
        log('alert_rescheduled', { reason: code });
      } else if (r.terminal) {
        log('alert_terminal', { reason: code });
      } else {
        log('alert_error', { reason: short(code) });
      }
    } catch {
      // Fallo aislado (claim/persistencia): no aborta el resto del tick.
      log('alert_error', { stage: 'process' });
    }
  }

  return result;
}
