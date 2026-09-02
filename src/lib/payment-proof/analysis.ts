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
 * es opinable. Leer un numero de cuenta en una imagen es algo que un modelo hace bien;
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
 * ── Qué se contrasta: el destino, y el monto ────────────────────────────────
 *
 * El DESTINO del dinero —cuenta, titular y banco— describe el mismo hecho:
 * "esto entró donde cobra Don Zarco". Ninguno de los tres depende de cómo se
 * comportó el cliente.
 *
 * El MONTO sí se contrasta, y contra DOS cifras, porque en delivery hay dos
 * pagos legítimos y distintos:
 *
 *   · solo los productos — el envío se paga en mano al recibir el pedido, que
 *     es lo que el QR le advierte;
 *   · productos + envío — el cliente que prefiere dejarlo todo pagado.
 *
 * Los dos son correctos, y hasta ahora no había forma de saber cuál hizo cada
 * uno: el repartidor llegaba sin saber si le tocaba cobrar la carrera. La
 * etiqueta lo responde, y ese es su trabajo principal — no vigilar al cliente,
 * sino decirle al que reparte qué lleva cobrado.
 *
 * Cualquier otra cifra es `revisar_monto`. También lo es un monto que NO se
 * pudo leer: un importe que no se puede confirmar no es un importe, y en caja
 * se prefiere mirar de más a cobrar de menos.
 *
 * ── La etiqueta no cambia un `unreadable` en acusación ──────────────────────
 *
 * Una foto borrosa recibe la etiqueta `revisar_monto` —el cocinero tiene que
 * mirarla— pero su veredicto sigue siendo `unreadable`, no `suspicious`. Son
 * dos cosas distintas: "hay que mirar esto" y "esto no cuadra". Confundirlas
 * convertiría cada recorte a medias en una acusación de fraude, y ese es
 * exactamente el aviso que se aprende a ignorar.
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
  /**
   * El monto no cuadra con ninguno de los dos pagos válidos: ni los productos
   * solos ni productos más envío.
   *
   * Solo se emite cuando el comprobante ERA legible y se leyó una cifra que no
   * es ninguna de las dos. Un monto ilegible recibe la etiqueta
   * `revisar_monto` —el cocinero tiene que mirarlo igual— pero no este motivo:
   * `unreadable` ya dice lo que pasó, y añadirle una acusación encima
   * convertiría una foto borrosa en un intento de fraude.
   */
  'amount_mismatch',
] as const;
export type ProofAnalysisReason = (typeof PROOF_ANALYSIS_REASONS)[number];

/**
 * Contra cuál de los dos importes válidos cuadró lo leído.
 *
 * Es una dimensión APARTE del veredicto, y por eso viaja en su propio campo. El
 * veredicto responde "¿hay que desconfiar?"; la etiqueta responde "¿qué pagó?",
 * que es una pregunta operativa: la hace el repartidor al llegar, y hasta ahora
 * nadie sabía contestarla.
 */
export const PROOF_AMOUNT_LABELS = ['pago_total', 'pago_productos', 'revisar_monto'] as const;
export type ProofAmountLabel = (typeof PROOF_AMOUNT_LABELS)[number];

/**
 * Los dos importes que un comprobante puede valer legítimamente.
 *
 * En recojo no hay envío que cobrar aparte, así que las dos cifras coinciden y
 * cualquier pago correcto sale `pago_total`. No es un caso especial: es la
 * misma regla con `deliveryAmount` en cero.
 */
export interface ExpectedAmounts {
  /** Solo la comida. En delivery es lo que el QR pide de verdad. */
  subtotal: number;
  /** Comida más envío, para quien prefiere dejarlo todo pagado. */
  total: number;
}

/**
 * Etiqueta del monto leído. Comparación EXACTA contra las dos cifras.
 *
 * ── Por qué exacta y sin margen ─────────────────────────────────────────────
 *
 * Un margen de tolerancia es una rendija: si se acepta un boliviano de
 * diferencia, un comprobante retocado en un boliviano pasa. Y el margen no
 * compra nada a cambio, porque las dos cifras contra las que se compara salen
 * del carrito, no de una estimación — el cliente ve el número exacto antes de
 * transferir.
 *
 * Quien paga de más o redondea la propina cae en `revisar_monto`, y eso es
 * deliberado: es una etiqueta que pide una mirada, no una acusación, y el
 * cocinero resuelve en dos segundos lo que ninguna regla automática puede
 * distinguir de un pago corto.
 *
 * `null` —no se leyó cifra— es `revisar_monto` por la misma razón: un importe
 * que no se puede confirmar no es un importe.
 */
export function labelForAmount(
  amount: number | null,
  expected: ExpectedAmounts,
): ProofAmountLabel {
  if (amount === null || !Number.isFinite(amount)) return 'revisar_monto';
  // El total primero: en recojo las dos cifras son la misma, y "pagó todo" es
  // la lectura correcta de un pedido que no tiene envío que cobrar aparte.
  if (amount === expected.total) return 'pago_total';
  if (amount === expected.subtotal) return 'pago_productos';
  return 'revisar_monto';
}

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
  /**
   * Los dos importes válidos del pedido al que se asoció el comprobante.
   *
   * Opcional porque un comprobante puede llegar sin pedido detrás —el cliente
   * manda una captura y no tiene nada pendiente— y ahí no hay contra qué
   * comparar. Su ausencia deja la etiqueta en `null`, que significa "no se
   * pudo comparar", nunca "cuadra".
   */
  amounts?: ExpectedAmounts | null;
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
  /**
   * Qué pagó, de las dos cosas que podía pagar. `null` = no había pedido
   * contra el que comparar.
   *
   * Va SIEMPRE que haya importes, incluso cuando el veredicto corta antes por
   * `not_a_receipt` o `unreadable`: en esos casos vale `revisar_monto`, porque
   * el repartidor sigue necesitando una respuesta y "no lo sabemos" es la
   * respuesta correcta.
   */
  amountLabel: ProofAmountLabel | null;
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

  // Sin importes no hay etiqueta: `null` dice "no se pudo comparar" y no se
  // parece en nada a `pago_total`, que afirma algo.
  const amounts = ctx.amounts ?? null;
  const etiqueta = (amount: number | null): ProofAmountLabel | null =>
    amounts === null ? null : labelForAmount(amount, amounts);

  if (!facts.looksLikeReceipt) {
    // No es un comprobante, así que su monto tampoco confirma nada. La
    // etiqueta lo dice sin añadir un segundo motivo: `not_a_receipt` ya es la
    // acusación, y repetirla en otras palabras no informa mejor.
    return {
      verdict: 'suspicious',
      reasons: ['not_a_receipt'],
      checks: sinContrastar,
      amountLabel: etiqueta(null),
    };
  }
  if (!facts.legible) {
    // Borrosa, recortada u oscura. El cocinero tiene que mirarla —de ahí la
    // etiqueta— pero el veredicto NO sube a `suspicious`: no se acusa a una
    // foto mala de lo mismo que a un monto cambiado.
    return {
      verdict: 'unreadable',
      reasons: ['unreadable'],
      checks: sinContrastar,
      amountLabel: etiqueta(null),
    };
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

  // El monto, aquí y no antes: solo tiene sentido preguntarlo de un comprobante
  // que se pudo leer. La etiqueta se calcula igual en los tres caminos; lo que
  // solo ocurre en este es que además ACUSE.
  const amountLabel = etiqueta(facts.amount);
  if (amountLabel === 'revisar_monto') reasons.push('amount_mismatch');

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
    return { verdict: 'unreadable', reasons: ['unreadable'], checks, amountLabel };
  }

  return {
    verdict: reasons.length > 0 ? 'suspicious' : 'ok',
    reasons,
    checks,
    amountLabel,
  };
}
