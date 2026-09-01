import 'server-only';
import { log } from '@/lib/log';
import { getServerEnv } from '@/lib/env/env';
import { createOpenAiModel } from '@/lib/agent/openai/adapter';
import type { AgentModel } from '@/lib/agent/core/model';
import { isImageMime, sniffMimeType } from './mime';
import { parseExpectedAccount, type ExpectedAccount } from './expected-account';
import { judgeProof } from './analysis';
import { readProofFacts } from './analysis-vision';
import {
  createSupabaseAnalysisDataSource,
  type AnalysisDataSource,
} from './analysis-data-source';

/**
 * Análisis automático del comprobante — cableado server-only.
 *
 * Une las tres piezas puras: lee la imagen (`analysis-vision`), la juzga
 * (`analysis`) y guarda el resultado (`analysis-data-source`). Aquí no hay
 * ninguna regla: si algo de lo que decide el veredicto acaba escrito en este
 * archivo, está en el sitio equivocado.
 *
 * ── Corre DESPUÉS de la captura, y no puede estorbarla ──────────────────────
 *
 * El comprobante ya está guardado, asociado a su intento y visible en cocina
 * antes de que esto empiece. Cualquier fallo aquí —modelo caído, respuesta
 * ilegible, clave mal puesta— deja el comprobante exactamente como estaba: en
 * la pantalla, esperando que una persona lo abra y decida. El análisis es una
 * ayuda, y una ayuda que se cae no puede llevarse por delante el trabajo.
 *
 * Por eso esta función NUNCA lanza y NUNCA devuelve un error al llamador: lo
 * único que puede pasar es que no haya análisis.
 */

/**
 * Tope de tamaño para analizar. Una captura de banco pesa decenas o cientos de
 * kilobytes; por encima de esto lo que hay es una foto de la pantalla hecha con
 * la cámara, y mandarla entera al modelo cuesta tiempo dentro del webhook sin
 * mejorar la lectura.
 */
export const PROOF_ANALYSIS_MAX_BYTES = 4 * 1024 * 1024;

/**
 * ¿Está encendido el análisis?
 *
 * Solo la cadena exacta 'true', igual que la captura. Apagado por defecto y a
 * propósito: esto corre dentro del webhook que atiende a todos los clientes y
 * gasta API, así que se enciende cuando se decide, no por desplegar.
 */
export function isProofAnalysisEnabled(): boolean {
  try {
    return getServerEnv().PAYMENT_PROOF_ANALYSIS_ENABLED === 'true';
  } catch {
    return false;
  }
}

/**
 * La cuenta contra la que se contrasta, leída de configuración.
 *
 * `null` apaga el análisis: sin saber qué cuenta ni qué titular deberían
 * aparecer, no queda nada contra lo que contrastar, y un veredicto sin nada
 * detrás pinta de "verificado" un comprobante que nadie ha verificado.
 */
export function readExpectedAccount(): ExpectedAccount | null {
  try {
    const env = getServerEnv();
    return parseExpectedAccount({
      bank: env.PAYMENT_PROOF_ACCOUNT_BANK,
      bankAliases: env.PAYMENT_PROOF_ACCOUNT_BANK_ALIASES,
      accountNumber: env.PAYMENT_PROOF_ACCOUNT_NUMBER,
      holder: env.PAYMENT_PROOF_ACCOUNT_HOLDER,
      holderAliases: env.PAYMENT_PROOF_ACCOUNT_HOLDER_ALIASES,
    });
  } catch {
    return null;
  }
}

/**
 * Modelo por defecto del lector de comprobantes.
 *
 * ── Por qué NO hereda el del agente ─────────────────────────────────────────
 *
 * El default del agente es `gpt-4o-mini`, y para MIRAR una imagen es el peor de
 * la lista por un motivo que no se ve en la tabla de precios: su tokenización de
 * imágenes lleva un multiplicador enorme —2 833 tokens de base y 5 667 por cada
 * cuadro de 512 px, unas 33 veces lo que cuesta la misma foto en `gpt-4o`—. Una
 * captura de banco corriente sale por unos 48 000 tokens de entrada.
 *
 * Los modelos `gpt-5-*` cuentan por parches de 32 px con un tope de 2 500 para
 * `detail: high`, así que la MISMA imagen ronda los 3 000 tokens. Leer el mismo
 * comprobante cuesta del orden de siete veces menos, y además lo lee mejor.
 *
 * Heredar `OPENAI_MODEL` sería cómodo y estaría mal: conversar por WhatsApp y
 * leer números pequeños en una foto son dos trabajos con dos modelos buenos
 * distintos, y el bueno para uno es el caro para el otro.
 *
 * `PAYMENT_PROOF_ANALYSIS_MODEL` sigue mandando sobre esto para poder cambiarlo
 * sin desplegar.
 */
export const PROOF_ANALYSIS_DEFAULT_MODEL = 'gpt-5-mini';

/** Modelo de visión configurado. `null` si falta la clave. */
function readModel(): AgentModel | null {
  try {
    const env = getServerEnv();
    if (!env.OPENAI_API_KEY) return null;
    return createOpenAiModel({
      apiKey: env.OPENAI_API_KEY,
      model: env.PAYMENT_PROOF_ANALYSIS_MODEL || PROOF_ANALYSIS_DEFAULT_MODEL,
    });
  } catch {
    return null;
  }
}

export interface AnalyzeProofInput {
  proofId: string;
  /** Pedido al que se asoció. `null` si no se pudo asociar a ninguno. */
  orderId: string | null;
  /** Los bytes ya descargados por la captura: no se vuelve a bajar nada. */
  bytes: Uint8Array;
  receivedAtMs: number;
}

export interface AnalyzeProofDeps {
  model: AgentModel;
  source: AnalysisDataSource;
  expected: ExpectedAccount;
}

/**
 * Analiza un comprobante ya capturado, con las dependencias inyectadas.
 *
 * Separada de `analyzeCapturedProof` para poder probar el recorrido entero
 * —lectura, juicio y escritura— con un modelo falso y sin base.
 */
export async function analyzeProofWith(
  input: AnalyzeProofInput,
  deps: AnalyzeProofDeps,
): Promise<void> {
  // Solo imágenes: un PDF no entra en la visión. Se queda en `pending`, que es
  // su estado normal y significa "no analizado" — no se marca `failed`, porque
  // no ha fallado nada.
  const mime = sniffMimeType(input.bytes);
  if (!isImageMime(mime)) return;
  if (input.bytes.byteLength > PROOF_ANALYSIS_MAX_BYTES) {
    await deps.source.markAnalysisFailed(input.proofId);
    return;
  }

  const dataUrl = `data:${mime};base64,${Buffer.from(input.bytes).toString('base64')}`;
  const lectura = await readProofFacts(deps.model, dataUrl);
  if (!lectura.ok) {
    log.warn('payment_proof_analysis_unreadable', { reason: lectura.error });
    await deps.source.markAnalysisFailed(input.proofId);
    return;
  }

  const { facts } = lectura;
  const referenceReused = facts.transactionRef
    ? await deps.source.isReferenceUsedElsewhere(
        facts.transactionRef,
        input.proofId,
        input.orderId,
      )
    : false;

  // ── Los dos importes contra los que se compara ────────────────────────────
  //
  // Sin pedido asociado no hay etiqueta: el cliente mandó una captura y no
  // tiene nada pendiente, así que no existe la pregunta "¿pagó el envío?".
  //
  // Un fallo leyendo los importes tampoco inventa una: `expectedAmounts`
  // devuelve `null` y la etiqueta se queda sin poner. Marcar `revisar_monto`
  // ahí acusaría al cliente de un problema nuestro.
  const amounts = input.orderId
    ? await deps.source.expectedAmounts(input.orderId)
    : null;

  const juicio = judgeProof(facts, {
    expected: deps.expected,
    receivedAtMs: input.receivedAtMs,
    referenceReused,
    amounts,
  });

  await deps.source.saveAnalysis(input.proofId, {
    verdict: juicio.verdict,
    reasons: juicio.reasons,
    amount: facts.amount,
    amountLabel: juicio.amountLabel,
    reference: facts.transactionRef,
    model: lectura.model,
  });

  // Sin datos del cliente, sin montos y sin el número de transacción: solo el
  // veredicto, sus motivos y la etiqueta —que es un enum cerrado, no una
  // cifra—. Sirve para saber si el filtro está funcionando o gritando de más.
  log.info('payment_proof_analyzed', {
    verdict: juicio.verdict,
    reasons: juicio.reasons.join(','),
    amount_label: juicio.amountLabel,
  });
}

/**
 * Analiza un comprobante recién capturado. Nunca lanza.
 *
 * Sin interruptor, sin clave o sin cuenta configurada no hace nada y no deja
 * rastro: el comprobante se queda en `analysis_status = 'pending'`, que es
 * exactamente lo que significaba antes de que existiera esta función.
 */
export async function analyzeCapturedProof(input: AnalyzeProofInput): Promise<void> {
  if (!isProofAnalysisEnabled()) return;
  const expected = readExpectedAccount();
  if (expected === null) return;
  const model = readModel();
  if (model === null) return;

  try {
    await analyzeProofWith(input, {
      model,
      source: createSupabaseAnalysisDataSource(),
      expected,
    });
  } catch (error) {
    // Solo el nombre del fallo: nunca bytes, ni el teléfono, ni el comprobante.
    log.error('payment_proof_analysis_failed', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
  }
}
