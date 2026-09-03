import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import type {
  ExpectedAmounts,
  ProofAmountLabel,
  ProofAnalysisReason,
  ProofVerdict,
} from './analysis';

/**
 * Puertos del análisis de comprobantes sobre Supabase — server-only.
 *
 * Traduce a SQL lo que el análisis necesita saber y lo que deja escrito. No
 * decide nada: las reglas viven en `analysis.ts` y la lectura en
 * `analysis-vision.ts`, los dos puros y probados sin base ni red.
 */

/** Lo que se guarda de una lectura terminada. */
export interface AnalysisOutcome {
  verdict: ProofVerdict;
  reasons: ProofAnalysisReason[];
  /** Monto leído en la imagen; `null` si no se leyó. Informativo. */
  amount: number | null;
  /** Número de transacción leído; `null` si no se leyó. */
  reference: string | null;
  model: string;
  /** Contra cuál de los dos importes cuadró. `null` = no había con qué comparar. */
  amountLabel: ProofAmountLabel | null;
  /**
   * Lo que se leyó del DESTINO, tal cual, sin normalizar (0034).
   *
   * Es contra esto que se emiten `account_mismatch`, `holder_mismatch` y
   * `bank_mismatch`, y hasta ahora se tiraba en cuanto se emitía la acusación.
   * Sin ello, un falso positivo solo se puede diagnosticar volviendo a abrir la
   * imagen, y una acusación que no se puede auditar acaba ignorándose.
   *
   * Solo el destino: quién COBRA. El remitente no se guarda.
   */
  destinationAccount: string | null;
  destinationHolder: string | null;
  destinationBank: string | null;
}

export interface AnalysisDataSource {
  /**
   * Los dos importes válidos del pedido: la comida sola y la comida con envío.
   *
   * `null` si el pedido no existe o sus importes no se pueden leer. Ausencia de
   * dato, y por eso deja la etiqueta sin poner en vez de compararla contra
   * cero — que marcaría `revisar_monto` a todo el mundo por un fallo nuestro.
   */
  expectedAmounts(orderId: string): Promise<ExpectedAmounts | null>;
  /**
   * ¿Ese número de transacción ya aparece en el comprobante de OTRO pedido?
   *
   * El mismo número repetido dentro del mismo pedido no cuenta: es el cliente
   * reenviando su propio comprobante, y eso ya lo marca el hash del contenido
   * como duplicado. Lo que delata es el mismo pago cobrado dos veces en pedidos
   * distintos.
   */
  isReferenceUsedElsewhere(
    reference: string,
    proofId: string,
    orderId: string | null,
  ): Promise<boolean>;
  saveAnalysis(proofId: string, outcome: AnalysisOutcome): Promise<void>;
  markAnalysisFailed(proofId: string): Promise<void>;
}

export function createSupabaseAnalysisDataSource(
  client: SupabaseClient = getSupabaseAdmin(),
): AnalysisDataSource {
  return {
    async expectedAmounts(orderId) {
      const { data, error } = await client
        .from('orders')
        .select('subtotal_amount,total_amount')
        .eq('id', orderId)
        .maybeSingle();
      if (error || !data) return null;

      // `numeric` de Postgres llega como cadena según el driver. Un valor que
      // no es un número finito se trata como ausencia: comparar contra `NaN`
      // devolvería `false` siempre y etiquetaría todo `revisar_monto`.
      const fila = data as { subtotal_amount: unknown; total_amount: unknown };
      const subtotal = Number(fila.subtotal_amount);
      const total = Number(fila.total_amount);
      if (!Number.isFinite(subtotal) || !Number.isFinite(total)) return null;
      return { subtotal, total };
    },

    async isReferenceUsedElsewhere(reference, proofId, orderId) {
      const { data, error } = await client
        .from('payment_proofs')
        .select('id,order_id')
        .eq('analysis_reference', reference)
        .neq('id', proofId)
        .limit(20);
      // Ante un fallo de consulta NO se acusa: "no lo sé" nunca es "sí".
      if (error) return false;
      const filas = (data ?? []) as Array<{ id: string; order_id: string | null }>;
      return filas.some((f) => f.order_id !== orderId);
    },

    async saveAnalysis(proofId, outcome) {
      await client
        .from('payment_proofs')
        .update({
          analysis_status: 'done',
          analysis_verdict: outcome.verdict,
          analysis_reasons: outcome.reasons,
          analysis_amount: outcome.amount,
          analysis_amount_label: outcome.amountLabel,
          analysis_reference: outcome.reference,
          analysis_model: outcome.model,
          analysis_destination_account: outcome.destinationAccount,
          analysis_destination_holder: outcome.destinationHolder,
          analysis_destination_bank: outcome.destinationBank,
          analyzed_at: new Date().toISOString(),
        })
        .eq('id', proofId);
    },

    async markAnalysisFailed(proofId) {
      // Sin veredicto: el CHECK de 0025 lo exige, y con razón. `failed` significa
      // "no se pudo leer", no "no cuadra", y la pantalla no debe poder confundir
      // una cosa con la otra.
      await client
        .from('payment_proofs')
        .update({ analysis_status: 'failed' })
        .eq('id', proofId);
    },
  };
}
