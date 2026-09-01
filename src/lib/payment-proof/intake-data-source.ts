import 'server-only';
import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import type { OrderStatus, PaymentMethod } from '@/types';
import type { ProofCandidateOrder } from './association';
import type { ExistingProof, ProofContentUpdate, ProofInsert } from './capture';
import { REJECTION_GRACE_MS } from './payment-gate';

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
  /**
   * LA RED DE SEGURIDAD: deja constancia de un comprobante que no se pudo
   * capturar (0028).
   *
   * Escribe lo poco que se sabe con certeza —el WAMID, cuándo llegó, qué tipo
   * decía ser y a qué pedido iba, si se supo— con `capture_status = 'failed'`.
   * No descarga, no almacena y no abre intento: solo impide que el comprobante
   * desaparezca sin dejar rastro.
   *
   * Devuelve `false` si no se pudo escribir NI ESO. Es idempotente por WAMID:
   * si la fila ya existe (una carrera, un reproceso), no toca nada.
   */
  insertUncaptured(row: UncapturedProofInsert): Promise<boolean>;
}

/** Lo mínimo que deja constancia de un comprobante perdido. */
export interface UncapturedProofInsert {
  sourceMessageId: string;
  /** Pedido al que iba, si se llegó a enrutar. `null` lo deja huérfano. */
  orderId: string | null;
  declaredMimeType: string | null;
  receivedAt: string;
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

      // ── El estado de pago de todos, en UNA consulta ────────────────────
      //
      // Se traen los intentos enteros y no solo los aceptados: desde 0028 hace
      // falta saber también si hay uno esperando revisión —eso PARA el reloj de
      // la ventana de gracia— y cuándo fue el último rechazo. Tres consultas
      // separadas darían tres fotos de instantes distintos del mismo pago.
      const ids = rows.map((r) => r.id);
      const { data: intentos } = await client
        .from('payment_attempts')
        .select('order_id,review_status,reviewed_at')
        .in('order_id', ids);

      const porPedido = new Map<string, Array<{ review_status: string; reviewed_at: string | null }>>();
      for (const fila of (intentos ?? []) as Array<{
        order_id: string;
        review_status: string;
        reviewed_at: string | null;
      }>) {
        const lista = porPedido.get(fila.order_id);
        if (lista) lista.push(fila);
        else porPedido.set(fila.order_id, [fila]);
      }

      return rows.map((r) => {
        const suyos = porPedido.get(r.id) ?? [];
        const aceptado = suyos.some((a) => a.review_status === 'accepted');
        const esperando = suyos.some((a) => a.review_status === 'pending_review');

        // El reloj corre SOLO si hay un rechazo sin nada posterior. Un intento
        // esperando revisión significa que el cliente ya reenvió y cumplió su
        // parte: a partir de ahí el pedido no puede morir por una demora
        // nuestra en mirarlo.
        let graceEnds: number | null = null;
        if (!aceptado && !esperando) {
          const rechazos = suyos
            .filter((a) => a.review_status === 'rejected')
            .map((a) => (a.reviewed_at === null ? NaN : Date.parse(a.reviewed_at)))
            .filter((ms) => !Number.isNaN(ms));
          // El MÁS RECIENTE: cada rechazo trae su propio aviso al cliente
          // prometiéndole el plazo entero, así que abre una ventana limpia.
          if (rechazos.length > 0) graceEnds = Math.max(...rechazos) + REJECTION_GRACE_MS;
        }

        return {
          orderId: r.id,
          status: r.status,
          paymentMethod: r.payment_method,
          openedAt: r.confirmed_at ?? r.created_at,
          hasAcceptedPayment: aceptado,
          rejectionGraceEndsAtMs: graceEnds,
        };
      });
    },

    async insertUncaptured(row) {
      // Solo las columnas que no pueden faltar. `association_method` se deja
      // en NULL a propósito aunque el enrutado lo supiera: afirma cómo se
      // vinculó un archivo que no llegamos a tener, y el panel lo pintaría
      // como una asociación hecha. El `order_id` sí va, porque sin él la fila
      // no aparece en ninguna pantalla y una fila que nadie ve no es un
      // rastro, es un residuo.
      const { error } = await client.from('payment_proofs').insert({
        source_message_id: row.sourceMessageId,
        order_id: row.orderId,
        declared_mime_type: row.declaredMimeType,
        received_at: row.receivedAt,
        capture_status: 'failed',
      });
      // El índice único del WAMID rechazando un duplicado NO es un fallo: la
      // constancia que se quería dejar ya está puesta.
      if (error) return error.code === '23505';
      return true;
    },
  };
}

/** Token de claim nuevo. Aislado para poder fijarlo en pruebas. */
export function newClaimToken(): string {
  return randomUUID();
}
