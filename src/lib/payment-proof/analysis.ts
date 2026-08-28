/**
 * Veredicto del comprobante — módulo PURO.
 *
 * Recibe lo que se LEYÓ en la imagen y lo contrasta con lo que debería decir.
 * No mira la foto, no llama a nadie y no escribe en la base: dado el mismo
 * hecho, siempre da el mismo veredicto.
 *
 * ── Por qué el modelo NO decide ─────────────────────────────────────────────
 *
 * La lectura óptica y el juicio son dos trabajos distintos, y solo uno de ellos
 * es opinable. Leer "Bs 20" en una imagen es algo que un modelo hace bien;
 * decidir que un pago de Bs 20 para un pedido de Bs 48 es sospechoso es una
 * regla del negocio, y una regla del negocio tiene que poder leerse, discutirse
 * y probarse sin gastar un token.
 *
 * Si el veredicto viniera del modelo, dos comprobantes idénticos podrían recibir
 * respuestas distintas, nadie podría explicar por qué saltó una alerta, y
 * cambiar el criterio significaría reescribir un prompt a ciegas. Aquí el
 * criterio está en este archivo, con sus tests al lado.
 *
 * ── Sospechar NO es rechazar ────────────────────────────────────────────────
 *
 * Nada de lo que sale de aquí acepta ni rechaza un pago, ni oculta el
 * comprobante, ni bloquea un botón. El flujo sigue exactamente igual: el
 * comprobante llega a cocina, la persona lo abre y decide. Esto solo le pone
 * delante lo que un vistazo con prisa se salta.
 *
 * Es deliberado, y en esta dirección: un falso positivo cuesta que alguien mire
 * dos veces un pago bueno; un rechazo automático equivocado insulta a un cliente
 * que sí pagó, y lo hace por WhatsApp y al instante.
 */
import {
  matchesAccount,
  matchesHolder,
  type ExpectedAccount,
  type FieldMatch,
} from './expected-account';

export const PROOF_VERDICTS = ['ok', 'suspicious', 'unreadable'] as const;
export type ProofVerdict = (typeof PROOF_VERDICTS)[number];

/**
 * Por qué salta la alerta. Son códigos: la traducción al castellano vive en
 * `labels.ts`, como el resto del vocabulario que ve una persona.
 */
export const PROOF_ANALYSIS_REASONS = [
  /** La cuenta destino no es la nuestra. */
  'account_mismatch',
  /** El titular que cobra no es el nuestro. */
  'holder_mismatch',
  /** Pagó MENOS de lo que debía. */
  'amount_short',
  /** Pagó más de lo que debía: suele ser el comprobante de otro pedido. */
  'amount_over',
  /** El número de transacción ya se usó en otro comprobante. */
  'reference_reused',
  /** El comprobante es de otro momento, no de este pedido. */
  'stale_receipt',
  /** La imagen no es un comprobante de pago. */
  'not_a_receipt',
  /** No se pudo leer lo suficiente para contrastar nada. */
  'unreadable',
] as const;
export type ProofAnalysisReason = (typeof PROOF_ANALYSIS_REASONS)[number];

/**
 * Lo que la lectura afirma haber visto. Todo es anulable: un campo que no está
 * en la imagen —o que no se entiende— llega como `null`, y `null` nunca acusa.
 */
export interface ProofFacts {
  /** ¿La imagen es un comprobante de pago? */
  looksLikeReceipt: boolean;
  /** ¿Se lee lo bastante como para contrastar algo? */
  legible: boolean;
  bank: string | null;
  /** Cuenta que RECIBE el dinero (no la del cliente). */
  destinationAccount: string | null;
  /** Titular que RECIBE el dinero. */
  destinationHolder: string | null;
  amount: number | null;
  /** Moneda tal como se lee: BOB, USD… */
  currency: string | null;
  /** Número de transacción del banco. */
  transactionRef: string | null;
  /** Fecha y hora locales del pago, `YYYY-MM-DDTHH:mm`. `null` si no se lee. */
  paidAtLocal: string | null;
}

export interface ProofJudgeContext {
  expected: ExpectedAccount;
  /** Lo que el cliente debía transferir por QR. `null` si no se pudo calcular. */
  amountDueByQr: number | null;
  /** Instante en que llegó el comprobante (ms). */
  receivedAtMs: number;
  /** ¿Ese número de transacción ya está registrado en otro comprobante? */
  referenceReused: boolean;
}

export interface ProofChecks {
  account: FieldMatch;
  holder: FieldMatch;
  amount: FieldMatch;
}

export interface ProofJudgement {
  verdict: ProofVerdict;
  reasons: ProofAnalysisReason[];
  checks: ProofChecks;
}

/**
 * Bolivia entera va en UTC−4 todo el año, sin horario de verano. Es una
 * constante y no una consulta a `Intl` a propósito: un desfase de zona no puede
 * depender de la configuración de la máquina que ejecute esto.
 */
const BOLIVIA_UTC_OFFSET_MS = 4 * 60 * 60 * 1000;

/**
 * Cuánto puede separarse la hora del comprobante de su llegada antes de
 * sospechar. Seis horas es holgado a propósito: el caso normal son minutos, y lo
 * que se busca es el comprobante de anteayer reenviado, no un reloj mal puesto.
 * Un margen corto convertiría cada teléfono desajustado en una acusación.
 */
export const STALE_RECEIPT_TOLERANCE_MS = 6 * 60 * 60 * 1000;

/** Tolerancia del monto: el céntimo. Un banco no redondea. */
const AMOUNT_EPSILON = 0.01;

/**
 * Instante UTC de una hora local boliviana escrita como `YYYY-MM-DDTHH:mm`.
 * `null` si no tiene esa forma exacta: no se adivinan formatos, porque adivinar
 * mal aquí produce una sospecha inventada.
 */
export function parseBolivianLocalTime(value: string | null): number | null {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const utc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  if (Number.isNaN(utc)) return null;
  return utc + BOLIVIA_UTC_OFFSET_MS;
}

/** ¿Cuadra el monto leído con lo que había que pagar? */
function revisarMonto(
  amount: number | null,
  due: number | null,
): { match: FieldMatch; reason: ProofAnalysisReason | null } {
  if (amount === null || !Number.isFinite(amount) || due === null || due <= 0) {
    return { match: 'unknown', reason: null };
  }
  if (amount < due - AMOUNT_EPSILON) return { match: 'mismatch', reason: 'amount_short' };
  if (amount > due + AMOUNT_EPSILON) return { match: 'mismatch', reason: 'amount_over' };
  return { match: 'match', reason: null };
}

/**
 * Juzga un comprobante ya leído.
 *
 * El orden importa: primero se descarta lo que no se puede juzgar —una imagen
 * ilegible, o que ni siquiera es un comprobante— y solo después se contrasta. Un
 * recorte borroso no es un ladrón, y llamarlo sospechoso enseñaría a cocina a
 * ignorar la palabra justo cuando aparezca de verdad.
 */
export function judgeProof(facts: ProofFacts, ctx: ProofJudgeContext): ProofJudgement {
  const sinContrastar: ProofChecks = { account: 'unknown', holder: 'unknown', amount: 'unknown' };

  if (!facts.looksLikeReceipt) {
    return { verdict: 'suspicious', reasons: ['not_a_receipt'], checks: sinContrastar };
  }
  if (!facts.legible) {
    return { verdict: 'unreadable', reasons: ['unreadable'], checks: sinContrastar };
  }

  const monto = revisarMonto(facts.amount, ctx.amountDueByQr);
  const checks: ProofChecks = {
    account: matchesAccount(facts.destinationAccount, ctx.expected.accountNumber),
    holder: matchesHolder(facts.destinationHolder, ctx.expected.holderNames),
    amount: monto.match,
  };

  const reasons: ProofAnalysisReason[] = [];
  if (checks.account === 'mismatch') reasons.push('account_mismatch');
  if (checks.holder === 'mismatch') reasons.push('holder_mismatch');
  if (monto.reason) reasons.push(monto.reason);
  if (ctx.referenceReused) reasons.push('reference_reused');

  const pagadoMs = parseBolivianLocalTime(facts.paidAtLocal);
  if (pagadoMs !== null && Math.abs(ctx.receivedAtMs - pagadoMs) > STALE_RECEIPT_TOLERANCE_MS) {
    reasons.push('stale_receipt');
  }

  // Nada que contrastar: ni la cuenta, ni el titular, ni el monto pudieron
  // compararse. Decir "ok" ahí sería un aprobado que nadie ha dado, y la
  // pantalla lo pintaría como si el comprobante estuviera verificado.
  const seContrastoAlgo =
    checks.account !== 'unknown' || checks.holder !== 'unknown' || checks.amount !== 'unknown';
  if (reasons.length === 0 && !seContrastoAlgo) {
    return { verdict: 'unreadable', reasons: ['unreadable'], checks };
  }

  return { verdict: reasons.length > 0 ? 'suspicious' : 'ok', reasons, checks };
}
