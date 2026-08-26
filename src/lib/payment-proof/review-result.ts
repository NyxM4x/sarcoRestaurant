/**
 * Contrato de respuesta de la revisión de un pago — módulo PURO.
 *
 * Traduce el resultado crudo de la RPC a la unión discriminada que consume el
 * navegador. Aquí se decide, en un solo sitio y de forma testeable, la regla más
 * importante del flujo: **solo `won` notifica al cliente**.
 *
 * Nada de lo que sale de este módulo puede llevar teléfono, SQL, credenciales ni
 * el detalle interno del error.
 */
import type { PaymentReviewStatus } from '@/types';

/** Decisión que puede tomar el operador. Dominio cerrado. */
export const REVIEW_DECISIONS = ['accept', 'reject'] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

export function isReviewDecision(value: unknown): value is ReviewDecision {
  return typeof value === 'string' && (REVIEW_DECISIONS as readonly string[]).includes(value);
}

/** Resultado crudo devuelto por `decide_payment_attempt`. */
export type RpcOutcome = 'won' | 'repeated' | 'conflict' | 'not_found' | 'invalid_decision';

export interface RpcDecisionRow {
  outcome: RpcOutcome;
  attempt_id?: string | null;
  order_id?: string | null;
  review_status?: PaymentReviewStatus | null;
  reviewed_at?: string | null;
}

export type ReviewFailureReason =
  | 'unauthorized'
  | 'invalid_decision'
  | 'not_found'
  | 'already_settled'
  | 'conflict'
  | 'error';

export type ReviewResult =
  | {
      ok: true;
      reviewStatus: Extract<PaymentReviewStatus, 'accepted' | 'rejected'>;
      reviewedAt: string;
      /** Presente solo cuando esta llamada ganó y por tanto se intentó avisar. */
      notification?: 'sent' | 'failed';
    }
  | {
      ok: false;
      reason: ReviewFailureReason;
      /** Estado REAL actual, para que el panel deje de mostrar lo que ya no es. */
      current?: PaymentReviewStatus | null;
    };

/**
 * ¿Este resultado debe disparar el aviso al cliente?
 *
 * Solo `won`. `repeated` es un doble clic —la decisión ya estaba aplicada y el
 * cliente ya recibió su mensaje—, y `conflict` significa que ganó la decisión
 * contraria, así que avisar aquí mandaría un mensaje que contradice lo aplicado.
 */
export function shouldNotifyCustomer(outcome: RpcOutcome): boolean {
  return outcome === 'won';
}

/** Estado final de un intento decidido, derivado de la decisión. */
export function statusForDecision(decision: ReviewDecision): 'accepted' | 'rejected' {
  return decision === 'accept' ? 'accepted' : 'rejected';
}

/**
 * Convierte el resultado de la RPC en la respuesta que ve el navegador.
 *
 * `repeated` se presenta como ÉXITO: para el operador que tocó dos veces, el
 * pago quedó como quería. Lo único que no ocurre es un segundo WhatsApp.
 */
export function toReviewResult(
  row: RpcDecisionRow | null | undefined,
  notification?: 'sent' | 'failed',
): ReviewResult {
  if (!row) return { ok: false, reason: 'error' };

  switch (row.outcome) {
    case 'won':
    case 'repeated': {
      const status = row.review_status;
      const reviewedAt = row.reviewed_at;
      // Un intento decidido SIEMPRE trae estado y fecha (lo garantiza un CHECK
      // en la base). Si no llegan, algo va mal y no se finge un éxito.
      if ((status !== 'accepted' && status !== 'rejected') || !reviewedAt) {
        return { ok: false, reason: 'error' };
      }
      const result: ReviewResult = { ok: true, reviewStatus: status, reviewedAt };
      // La notificación solo se reporta cuando de verdad se intentó (won).
      return notification === undefined ? result : { ...result, notification };
    }
    case 'conflict':
      return { ok: false, reason: 'conflict', current: row.review_status ?? null };
    case 'not_found':
      return { ok: false, reason: 'not_found', current: null };
    case 'invalid_decision':
      return { ok: false, reason: 'invalid_decision', current: null };
    default:
      return { ok: false, reason: 'error' };
  }
}

/** Mensaje para el operador. Nunca detalle técnico. */
export function reviewErrorMessage(reason: ReviewFailureReason): string {
  switch (reason) {
    case 'unauthorized':
      return 'Tu sesión expiró. Vuelve a ingresar.';
    case 'invalid_decision':
      return 'Esa acción no es válida.';
    case 'not_found':
      return 'No encontramos este intento de pago.';
    case 'already_settled':
      return 'Este pago ya estaba decidido.';
    case 'conflict':
      return 'Otra persona ya decidió este pago.';
    default:
      return 'No se pudo guardar la decisión. Vuelve a intentarlo.';
  }
}

/** Aviso cuando la decisión se guardó pero el WhatsApp no salió. */
export const NOTIFICATION_FAILED_NOTICE =
  'La decisión se guardó, pero no pudimos avisar al cliente por WhatsApp. Contáctalo manualmente.';
