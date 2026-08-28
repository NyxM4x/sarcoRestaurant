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
 * es opinable. Leer "2505098350" en una imagen es algo que un modelo hace bien;
 * decidir que esa cuenta no es la nuestra es una regla del negocio, y una regla
 * del negocio tiene que poder leerse, discutirse y probarse sin gastar un token.
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
 *
 * ── Tres datos, y el monto NO es uno de ellos ────────────────────────────
 *
 * Lo que se contrasta es el DESTINO del dinero: cuenta, titular y banco. Los
 * tres describen el mismo hecho —"esto entró donde cobra Don Zarco"— y ninguno
 * depende de cómo se comportó el cliente.
 *
 * El monto se lee y se guarda, pero no acusa. No se sabe de antemano cuánto va a
 * transferir alguien por WhatsApp: hay quien adelanta, quien paga dos pedidos
 * juntos, quien redondea la propina y quien abona una parte. Contrastar contra
 * el total del pedido marcaría como sospechosos pagos perfectamente buenos, y a
 * diario — que es la forma más rápida de que cocina aprenda a ignorar el aviso.
 *
 * Queda visible en el panel junto al comprobante: quien revisa lo ve y decide.
 * Lo que no hace es gritar.
 */
import {
  matchesAccount,
  matchesBank,
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
  /** El dinero entró en otro banco. */
  'bank_mismatch',
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
  /** Banco o app desde donde se emitió el comprobante. Informativo. */
  bank: string | null;
  /** Banco que RECIBE el dinero. */
  destinationBank: string | null;
  /** Cuenta que RECIBE el dinero (no la del cliente). */
  destinationAccount: string | null;
  /** Titular que RECIBE el dinero. */
  destinationHolder: string | null;
  /** Monto leído. Informativo: se muestra, no acusa. */
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
  /** Instante en que llegó el comprobante (ms). */
  receivedAtMs: number;
  /** ¿Ese número de transacción ya está registrado en otro comprobante? */
  referenceReused: boolean;
}

export interface ProofChecks {
  account: FieldMatch;
  holder: FieldMatch;
  bank: FieldMatch;
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

/**
 * Juzga un comprobante ya leído.
 *
 * El orden importa: primero se descarta lo que no se puede juzgar —una imagen
 * ilegible, o que ni siquiera es un comprobante— y solo después se contrasta. Un
 * recorte borroso no es un ladrón, y llamarlo sospechoso enseñaría a cocina a
 * ignorar la palabra justo cuando aparezca de verdad.
 */
export function judgeProof(facts: ProofFacts, ctx: ProofJudgeContext): ProofJudgement {
  const sinContrastar: ProofChecks = { account: 'unknown', holder: 'unknown', bank: 'unknown' };

  if (!facts.looksLikeReceipt) {
    return { verdict: 'suspicious', reasons: ['not_a_receipt'], checks: sinContrastar };
  }
  if (!facts.legible) {
    return { verdict: 'unreadable', reasons: ['unreadable'], checks: sinContrastar };
  }

  const checks: ProofChecks = {
    account: matchesAccount(facts.destinationAccount, ctx.expected.accountNumber),
    holder: matchesHolder(facts.destinationHolder, ctx.expected.holderNames),
    bank: matchesBank(facts.destinationBank, ctx.expected.bankNames),
  };

  const reasons: ProofAnalysisReason[] = [];
  if (checks.account === 'mismatch') reasons.push('account_mismatch');
  if (checks.holder === 'mismatch') reasons.push('holder_mismatch');
  if (checks.bank === 'mismatch') reasons.push('bank_mismatch');
  if (ctx.referenceReused) reasons.push('reference_reused');

  const pagadoMs = parseBolivianLocalTime(facts.paidAtLocal);
  if (pagadoMs !== null && Math.abs(ctx.receivedAtMs - pagadoMs) > STALE_RECEIPT_TOLERANCE_MS) {
    reasons.push('stale_receipt');
  }

  // Nada que contrastar: ni la cuenta, ni el titular, ni el banco pudieron
  // compararse. Decir "ok" ahí sería un aprobado que nadie ha dado, y la
  // pantalla lo pintaría como si el comprobante estuviera verificado.
  const seContrastoAlgo =
    checks.account !== 'unknown' || checks.holder !== 'unknown' || checks.bank !== 'unknown';
  if (reasons.length === 0 && !seContrastoAlgo) {
    return { verdict: 'unreadable', reasons: ['unreadable'], checks };
  }

  return { verdict: reasons.length > 0 ? 'suspicious' : 'ok', reasons, checks };
}
