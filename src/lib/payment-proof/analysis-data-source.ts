import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import { amountDueByQrOf } from '@/lib/orders/amount-due';
import type { DeliveryType } from '@/types';
import type { ProofAnalysisReason, ProofVerdict } from './analysis';

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
  /** Monto leído en la imagen; `null` si no se leyó. */
  amount: number | null;
  /** Número de transacción leído; `null` si no se leyó. */
  reference: string | null;
  model: string;
}

export interface AnalysisDataSource {
  /** Lo que el cliente debía transferir por QR. `null` si no se pudo calcular. */
  amountDueByQr(orderId: string): Promise<number | null>;
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
    async amountDueByQr(orderId) {
      const { data, error } = await client
        .from('orders')
        .select('delivery_type,subtotal_amount,total_amount')
        .eq('id', orderId)
        .limit(1);
      if (error) return null;
      const row = (data ?? [])[0] as
        | {
            delivery_type: DeliveryType;
            subtotal_amount: number | string | null;
            total_amount: number | string | null;
          }
        | undefined;
      if (!row) return null;
      const due = amountDueByQrOf(row);
      // Un 0 no es una cifra contra la que contrastar: significa que no se pudo
      // calcular. Devolverlo haría saltar `amount_over` en todos los pagos.
      return due > 0 ? due : null;
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
          analysis_reference: outcome.reference,
          analysis_model: outcome.model,
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
