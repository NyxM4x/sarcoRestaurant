import 'server-only';
import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import type { OrderStatus, PaymentMethod } from '@/types';
import type { ProofCandidateOrder } from './association';
import type { ExistingProof, ProofContentUpdate, ProofInsert } from './capture';

/**
 * Puertos de captura sobre Supabase — server-only.
 *
 * Traduce las operaciones del motor a SQL, sin lógica propia. Los dos CAS
 * —re-reclamar y cerrar— viven aquí porque son consultas condicionales, y son
 * lo único que impide que dos workers se pisen.
 */

/** Estados de pedido que aún pueden recibir un comprobante. */
const CANDIDATE_STATUSES: readonly OrderStatus[] = [
  'awaiting_location',
  'confirmed',
  'preparing',
  'ready',
  'on_the_way',
];

export interface IntakeDataSource {
  findBySourceMessageId(sourceMessageId: string): Promise<ExistingProof | null>;
  insertClaimed(row: ProofInsert, claimToken: string): Promise<string>;
  reclaim(proofId: string, claimToken: string, staleBeforeMs: number): Promise<boolean>;
  findByContentHash(sha256: string, excludeProofId: string): Promise<string | null>;
  updateContent(proofId: string, update: ProofContentUpdate): Promise<void>;
  markStored(
    proofId: string,
    claimToken: string,
    key: string,
    filename: string,
    storedAtIso: string,
  ): Promise<boolean>;
  markFailed(proofId: string, claimToken: string): Promise<void>;
  attachToAttempt(proofId: string, orderId: string): Promise<string | null>;
  /** Pedidos del teléfono que podrían estar esperando pago. */
  candidatesForPhone(phone: string): Promise<ProofCandidateOrder[]>;
}

export function createSupabaseIntakeDataSource(
  client: SupabaseClient = getSupabaseAdmin(),
): IntakeDataSource {
  return {
    async findBySourceMessageId(sourceMessageId) {
      const { data, error } = await client
        .from('payment_proofs')
        .select('id,capture_status,claimed_at')
        .eq('source_message_id', sourceMessageId)
        .limit(1);
      if (error) throw new Error('proof_lookup_failed');
      const row = (data ?? [])[0] as
        | { id: string; capture_status: ExistingProof['captureStatus']; claimed_at: string | null }
        | undefined;
      if (!row) return null;
      const claimedAt = row.claimed_at ? Date.parse(row.claimed_at) : NaN;
      return {
        proofId: row.id,
        captureStatus: row.capture_status,
        claimedAtMs: Number.isNaN(claimedAt) ? null : claimedAt,
      };
    },

    async insertClaimed(row, claimToken) {
      // Lanza si el WAMID ya existe: el índice único es la garantía real de
      // idempotencia, no la consulta previa.
      const { data, error } = await client
        .from('payment_proofs')
        .insert({
          source_message_id: row.sourceMessageId,
          order_id: row.orderId,
          association_method: row.associationMethod,
          routing_exception: row.routingException,
          declared_mime_type: row.declaredMimeType,
          received_at: row.receivedAt,
          capture_status: 'capturing',
          claim_token: claimToken,
          claimed_at: new Date().toISOString(),
        })
        .select('id')
        .single();
      if (error) throw new Error('proof_insert_failed');
      return data.id as string;
    },

    async reclaim(proofId, claimToken, staleBeforeMs) {
      // CAS: solo se re-reclama una fila que NO esté cerrada y cuyo claim esté
      // vencido (o no exista). Si otro la reclamó entre medias, no actualiza nada.
      const stale = new Date(staleBeforeMs).toISOString();
      const { data, error } = await client
        .from('payment_proofs')
        .update({
          capture_status: 'capturing',
          claim_token: claimToken,
          claimed_at: new Date().toISOString(),
        })
        .eq('id', proofId)
        .neq('capture_status', 'stored')
        .or(`claimed_at.is.null,claimed_at.lt.${stale}`)
        .select('id');
      if (error) throw new Error('proof_reclaim_failed');
      return (data ?? []).length === 1;
    },

    async findByContentHash(sha256, excludeProofId) {
      const { data, error } = await client
        .from('payment_proofs')
        .select('id')
        .eq('content_sha256', sha256)
        .neq('id', excludeProofId)
        .order('received_at', { ascending: true })
        .limit(1);
      if (error) throw new Error('proof_hash_lookup_failed');
      return ((data ?? [])[0]?.id as string | undefined) ?? null;
    },

    async updateContent(proofId, update) {
      const { error } = await client
        .from('payment_proofs')
        .update({
          verified_mime_type: update.verifiedMimeType,
          content_sha256: update.contentSha256,
          association_method: update.associationMethod,
          duplicate_of_id: update.duplicateOfId,
        })
        .eq('id', proofId);
      if (error) throw new Error('proof_content_update_failed');
    },

    async markStored(proofId, claimToken, key, filename, storedAtIso) {
      // CAS de cierre: solo gana quien todavía sostiene el claim.
      const { data, error } = await client
        .from('payment_proofs')
        .update({
          capture_status: 'stored',
          storage_provider: 'r2',
          storage_namespace: 'payment-proofs',
          storage_key: key,
          storage_stored_at: storedAtIso,
          safe_filename: filename,
        })
        .eq('id', proofId)
        .eq('claim_token', claimToken)
        .eq('capture_status', 'capturing')
        .select('id');
      if (error) throw new Error('proof_mark_stored_failed');
      return (data ?? []).length === 1;
    },

    async markFailed(proofId, claimToken) {
      await client
        .from('payment_proofs')
        .update({ capture_status: 'failed', claim_token: null, claimed_at: null })
        .eq('id', proofId)
        .eq('claim_token', claimToken);
    },

    async attachToAttempt(proofId, orderId) {
      // Reutiliza el episodio abierto del pedido, o abre uno nuevo. Dos
      // comprobantes seguidos del mismo pedido comparten intento a propósito:
      // son la misma conversación de pago.
      const { data: abierto } = await client
        .from('payment_attempts')
        .select('id')
        .eq('order_id', orderId)
        .eq('review_status', 'pending_review')
        .order('opened_at', { ascending: false })
        .limit(1);

      let attemptId = (abierto ?? [])[0]?.id as string | undefined;
      if (!attemptId) {
        const { data: creado, error } = await client
          .from('payment_attempts')
          .insert({ order_id: orderId })
          .select('id')
          .single();
        if (error) return null;
        attemptId = creado.id as string;
      }

      const { error: linkError } = await client
        .from('payment_proofs')
        .update({ attempt_id: attemptId, order_id: orderId })
        .eq('id', proofId);
      if (linkError) return null;
      return attemptId;
    },

    async candidatesForPhone(phone) {
      const { data, error } = await client
        .from('orders')
        .select('id,status,payment_method,created_at,confirmed_at')
        .eq('customer_phone', phone)
        .in('status', [...CANDIDATE_STATUSES])
        .order('created_at', { ascending: false })
        .limit(20);
      if (error) throw new Error('candidates_lookup_failed');

      const rows = (data ?? []) as Array<{
        id: string;
        status: OrderStatus;
        payment_method: PaymentMethod | null;
        created_at: string;
        confirmed_at: string | null;
      }>;
      if (rows.length === 0) return [];

      // ¿Cuáles ya tienen un pago aceptado? Una sola consulta para todos.
      const { data: aceptados } = await client
        .from('payment_attempts')
        .select('order_id')
        .in('order_id', rows.map((r) => r.id))
        .eq('review_status', 'accepted');
      const conPagoAceptado = new Set(
        (aceptados ?? []).map((a) => (a as { order_id: string }).order_id),
      );

      return rows.map((r) => ({
        orderId: r.id,
        status: r.status,
        paymentMethod: r.payment_method,
        openedAt: r.confirmed_at ?? r.created_at,
        hasAcceptedPayment: conPagoAceptado.has(r.id),
      }));
    },
  };
}

/** Token de claim nuevo. Aislado para poder fijarlo en pruebas. */
export function newClaimToken(): string {
  return randomUUID();
}
