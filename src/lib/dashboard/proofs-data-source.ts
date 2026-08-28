import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import type { PaymentAttempt, PaymentProof } from '@/types';
import type { ReviewDecision, RpcDecisionRow } from '@/lib/payment-proof/review-result';

/**
 * Puerto hacia los datos de comprobantes — server-only.
 *
 * ── Una sola puerta para decidir ────────────────────────────────────────────
 *
 * `decide()` llama a la RPC `decide_payment_attempt` y NO existe ningún otro
 * camino en el código que escriba `payment_attempts.review_status`. Eso es
 * deliberado: si hubiera un `.update()` suelto en cualquier parte, el CAS de la
 * RPC dejaría de ser una garantía y volverían las carreras que resuelve.
 *
 * Las lecturas devuelven las filas crudas; sanitizarlas para la UI es trabajo
 * del repositorio puro, no de este adaptador.
 */

const ATTEMPT_COLUMNS = 'id,order_id,review_status,opened_at,reviewed_at,created_at,updated_at';

/**
 * Columnas del comprobante para la UI. `storage_key` y `storage_namespace` NO
 * entran: el navegador nunca debe verlas. Solo las lee el endpoint de archivos,
 * que las pide aparte con `getProofStorage`.
 */
const PROOF_UI_COLUMNS =
  'id,source_message_id,order_id,attempt_id,association_method,routing_exception,' +
  'declared_mime_type,verified_mime_type,safe_filename,duplicate_of_id,' +
  'capture_status,received_at,analysis_status,analysis_verdict,analysis_reasons';

/**
 * `analysis_amount` y `analysis_reference` NO viajan a la UI a proposito.
 *
 * Son una lectura optica, y pintarlos junto al veredicto invita a decidir por
 * ellos en vez de por el comprobante: "dice Bs 48" leido de una imagen retocada
 * es exactamente lo que el retoque queria conseguir. Quien revisa mira el
 * archivo; el analisis solo le dice DONDE mirar.
 *
 * Se guardan igualmente en la base, que es donde sirven: contrastar despues y
 * reconocer un numero de transaccion repetido.
 */

export type ProofUiRow = Pick<
  PaymentProof,
  | 'id'
  | 'source_message_id'
  | 'order_id'
  | 'attempt_id'
  | 'association_method'
  | 'routing_exception'
  | 'declared_mime_type'
  | 'verified_mime_type'
  | 'safe_filename'
  | 'duplicate_of_id'
  | 'capture_status'
  | 'received_at'
  | 'analysis_status'
  | 'analysis_verdict'
  | 'analysis_reasons'
>;

/** Referencia privada al objeto: SOLO para el endpoint de streaming. */
export interface ProofStorageRef {
  storageKey: string;
  verifiedMimeType: string | null;
  safeFilename: string | null;
}

/** Filas de pago de un pedido, resueltas por número (el UUID no sale de aquí). */
export interface PaymentRows {
  attempts: PaymentAttempt[];
  proofs: ProofUiRow[];
}

export interface ProofsDataSource {
  /**
   * Intentos y comprobantes de un pedido, buscados por NÚMERO de pedido.
   *
   * La resolución `order_number → id` ocurre aquí dentro a propósito: el UUID
   * del pedido es un identificador técnico que nunca debe viajar al navegador,
   * y la vista de detalle solo conoce el número.
   */
  getPaymentRows(orderNumber: string): Promise<PaymentRows>;
  /** Intentos de un pedido, el más reciente primero. */
  listAttempts(orderId: string): Promise<PaymentAttempt[]>;
  /** Comprobantes de un pedido (incluidos los no asociados a ningún intento). */
  listProofs(orderId: string): Promise<ProofUiRow[]>;
  /** Cuántos pedidos de una página tienen un pago pendiente de revisión. */
  pendingReviewOrderIds(orderIds: string[]): Promise<Set<string>>;
  /** Referencia de almacenamiento de un comprobante (endpoint de archivos). */
  getProofStorage(proofId: string): Promise<ProofStorageRef | null>;
  /** Teléfono del cliente de un pedido. Se lee EN SERVIDOR, nunca del navegador. */
  getCustomerPhone(orderId: string): Promise<string | null>;
  /** ÚNICO camino de escritura del estado de revisión. */
  decide(attemptId: string, decision: ReviewDecision): Promise<RpcDecisionRow | null>;
}

export function createSupabaseProofsDataSource(
  client: SupabaseClient = getSupabaseAdmin(),
): ProofsDataSource {
  return {
    async getPaymentRows(orderNumber) {
      const { data: orderRows, error: orderError } = await client
        .from('orders')
        .select('id')
        .eq('order_number', orderNumber)
        .limit(1);
      if (orderError) throw new Error('order_lookup_failed');
      const orderId = (orderRows ?? [])[0]?.id as string | undefined;
      if (!orderId) return { attempts: [], proofs: [] };

      const [attempts, proofs] = await Promise.all([
        this.listAttempts(orderId),
        this.listProofs(orderId),
      ]);
      return { attempts, proofs };
    },

    async listAttempts(orderId) {
      const { data, error } = await client
        .from('payment_attempts')
        .select(ATTEMPT_COLUMNS)
        .eq('order_id', orderId)
        .order('opened_at', { ascending: false });
      if (error) throw new Error('attempts_list_failed');
      return (data ?? []) as unknown as PaymentAttempt[];
    },

    async listProofs(orderId) {
      const { data, error } = await client
        .from('payment_proofs')
        .select(PROOF_UI_COLUMNS)
        .eq('order_id', orderId)
        .order('received_at', { ascending: true });
      if (error) throw new Error('proofs_list_failed');
      return (data ?? []) as unknown as ProofUiRow[];
    },

    async pendingReviewOrderIds(orderIds) {
      if (orderIds.length === 0) return new Set();
      const { data, error } = await client
        .from('payment_attempts')
        .select('order_id')
        .in('order_id', orderIds)
        .eq('review_status', 'pending_review');
      if (error) throw new Error('pending_review_failed');
      return new Set((data ?? []).map((r) => (r as { order_id: string }).order_id));
    },

    async getProofStorage(proofId) {
      const { data, error } = await client
        .from('payment_proofs')
        .select('storage_key,verified_mime_type,safe_filename,capture_status')
        .eq('id', proofId)
        .limit(1);
      if (error) throw new Error('proof_storage_failed');
      const row = (data ?? [])[0] as
        | {
            storage_key: string | null;
            verified_mime_type: string | null;
            safe_filename: string | null;
            capture_status: string;
          }
        | undefined;
      // Solo un comprobante realmente almacenado se puede servir.
      if (!row || row.capture_status !== 'stored' || !row.storage_key) return null;
      return {
        storageKey: row.storage_key,
        verifiedMimeType: row.verified_mime_type,
        safeFilename: row.safe_filename,
      };
    },

    async getCustomerPhone(orderId) {
      const { data, error } = await client
        .from('orders')
        .select('customer_phone')
        .eq('id', orderId)
        .limit(1);
      if (error) throw new Error('customer_phone_failed');
      return (data ?? [])[0]?.customer_phone ?? null;
    },

    async decide(attemptId, decision) {
      const { data, error } = await client.rpc('decide_payment_attempt', {
        p_attempt_id: attemptId,
        p_decision: decision,
      });
      if (error) throw new Error('decide_failed');
      return (data ?? null) as RpcDecisionRow | null;
    },
  };
}
