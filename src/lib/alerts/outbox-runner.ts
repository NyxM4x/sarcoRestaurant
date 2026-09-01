/**
 * Ejecución de una alerta del outbox — módulo PURO con puertos inyectados.
 *
 * Une las tres piezas: reclamar, mandar y cerrar. Es el único sitio donde se
 * escribe el resultado de un envío, y por eso la regla vive aquí y no repartida
 * entre los dos servicios que encolan.
 *
 * ── El estado se escribe DESPUÉS de saber qué pasó ──────────────────────────
 *
 * Es la inversión que arregla el fallo original. Antes se marcaba "enviado" y
 * luego se mandaba; si Telegram fallaba, la marca ya estaba puesta y el aviso
 * se perdía en silencio. Aquí `sent` solo se escribe con un `sent` del
 * transporte en la mano.
 */
import type { AlertSendOutcome, TelegramAlertRow } from './outbox';
import { dispositionForOutcome, nextAttemptAt } from './outbox';

export interface AlertOutboxStore {
  /**
   * Reclamo ATÓMICO por vencimiento, con lease. Lo elige la base, nunca el
   * llamante: un caller que pudiera pedir "manda esta alerta" convertiría el
   * endpoint interno en una forma de mandar mensajes a voluntad.
   */
  claimDue(limit: number, leaseSeconds: number): Promise<TelegramAlertRow[]>;
  /** Reclamo por id, para el fast path del que acaba de encolarla. */
  claimById(id: string, leaseSeconds: number): Promise<TelegramAlertRow | null>;
  markSent(id: string, sentAtIso: string): Promise<void>;
  /** Vuelve a `pending` con su próxima cita. */
  reschedule(id: string, nextAttemptAtIso: string, error: string): Promise<void>;
  /** Terminal sin haber salido. Queda visible en el panel. */
  markFailed(id: string, error: string): Promise<void>;
}

/** Manda el texto por Telegram. El chat lo decide el cableado, no la fila. */
export type AlertSender = (
  kind: TelegramAlertRow['kind'],
  body: string,
) => Promise<AlertSendOutcome>;

export interface RunAlertDeps {
  store: AlertOutboxStore;
  send: AlertSender;
  now(): number;
}

export type RunAlertResult = 'sent' | 'rescheduled' | 'failed';

/**
 * Intenta UNA alerta ya reclamada. Nunca lanza.
 *
 * Un fallo escribiendo el desenlace deja la fila en `sending` con su lease; al
 * vencer, el worker la recupera. Perder el desenlace es recuperable; perder la
 * alerta, no.
 */
export async function runClaimedAlert(
  row: TelegramAlertRow,
  deps: RunAlertDeps,
): Promise<RunAlertResult> {
  let outcome: AlertSendOutcome;
  try {
    outcome = await deps.send(row.kind, row.body);
  } catch {
    // El transporte no debería lanzar —devuelve `transient`— pero si lo hiciera,
    // se trata como transitorio: no se marca enviado algo que no se sabe.
    outcome = { kind: 'transient', code: 'sender_threw' };
  }

  const decision = dispositionForOutcome(outcome, row.attempts, row.maxAttempts);

  try {
    if (decision.kind === 'sent') {
      await deps.store.markSent(row.id, new Date(deps.now()).toISOString());
      return 'sent';
    }
    if (decision.kind === 'retry') {
      await deps.store.reschedule(
        row.id,
        nextAttemptAt(deps.now(), decision.delaySeconds),
        decision.error,
      );
      return 'rescheduled';
    }
    await deps.store.markFailed(row.id, decision.error);
    return 'failed';
  } catch {
    // Ver la cabecera: el lease vencido devuelve la fila al worker.
    return decision.kind === 'sent' ? 'sent' : 'rescheduled';
  }
}

/**
 * Presupuesto de un tick.
 *
 * Cuatro alertas por vuelta. El worker corre cada minuto y esto es el camino de
 * RECUPERACIÓN, no el normal —el normal es el fast path del que encola—, así
 * que lo que no entra sigue agendado para el siguiente.
 */
export const ALERT_TICK_BUDGET = 4;

/** Lease del reclamo. Por encima del timeout del transporte (10 s) con holgura. */
export const ALERT_LEASE_SECONDS = 60;

export interface AlertTickResult {
  ok: true;
  claimed: number;
  sent: number;
  rescheduled: number;
  failed: number;
}

/** Un tick del worker: recoge lo vencido y lo intenta. */
export async function runAlertOutboxTick(deps: RunAlertDeps): Promise<AlertTickResult> {
  const filas = await deps.store.claimDue(ALERT_TICK_BUDGET, ALERT_LEASE_SECONDS);
  const conteo = { sent: 0, rescheduled: 0, failed: 0 };

  for (const fila of filas) {
    const resultado = await runClaimedAlert(fila, deps);
    conteo[resultado] += 1;
  }

  return { ok: true, claimed: filas.length, ...conteo };
}

/**
 * FAST PATH: intenta mandar YA una alerta recién encolada.
 *
 * La fila ya está escrita, así que esto es LATENCIA, no durabilidad — igual que
 * el `after()` del webhook. Si no llega a correr, si muere a mitad o si el envío
 * falla, la fila sigue agendada y el worker la recoge.
 *
 * Nunca lanza: quien encola ya hizo lo importante (dejar la fila) y no puede
 * caerse porque Telegram esté lento.
 */
export async function trySendNow(alertId: string, deps: RunAlertDeps): Promise<RunAlertResult | 'skipped'> {
  try {
    const fila = await deps.store.claimById(alertId, ALERT_LEASE_SECONDS);
    // Cero filas: el worker la tiene, o ya salió. Quien pierde se retira.
    if (fila === null) return 'skipped';
    return await runClaimedAlert(fila, deps);
  } catch {
    return 'skipped';
  }
}
