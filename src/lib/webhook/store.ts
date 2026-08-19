import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  InsertProcessingInput,
  WebhookEventRow,
  WebhookEventStatus,
  WebhookEventStore,
} from './kapso';

/**
 * `webhook_events` sobre Supabase (Fase 6D.2F.5C.1).
 *
 * Estaba dentro de la ruta; se saca aquí porque ahora lo usan DOS entradas —el
 * webhook y el worker de recovery— y tener dos copias del mismo acceso a datos
 * es tener dos sitios donde equivocarse con el mismo UPDATE.
 */

/** Código Postgres de violación de unicidad. */
const UNIQUE_VIOLATION = '23505';

function toRow(data: Record<string, unknown>): WebhookEventRow {
  return {
    id: data.id as string,
    eventName: (data.event_name as string | null) ?? '',
    payload: data.payload,
    attempts: (data.attempts as number | null) ?? 0,
    maxAttempts: (data.max_attempts as number | null) ?? 1,
  };
}

export function createSupabaseWebhookStore(supabase: SupabaseClient): WebhookEventStore {
  return {
    async findByKey(key: string) {
      const { data, error } = await supabase
        .from('webhook_events')
        .select('id, status')
        .eq('event_id', key)
        .maybeSingle();
      if (error) throw new Error(`webhook.findByKey: ${error.message}`);
      if (!data) return null;
      return { id: data.id as string, status: data.status as WebhookEventStatus };
    },

    async insertReceived(input: InsertProcessingInput) {
      // Nace `received` y AGENDADA: si `after()` no llega a correr, el worker la
      // encuentra vencida. Sin `next_attempt_at` la fila sería invisible para el
      // recovery y el mensaje del cliente se quedaría esperando para siempre.
      const { data, error } = await supabase
        .from('webhook_events')
        .insert({
          event_id: input.event_id,
          event_name: input.event_name,
          message_id: input.message_id,
          payload: input.payload as never,
          status: 'received',
          next_attempt_at: new Date().toISOString(),
        })
        .select('id')
        .single();

      if (error) {
        if (error.code === UNIQUE_VIOLATION) return { duplicate: true as const };
        throw new Error(`webhook.insertReceived: ${error.message}`);
      }
      return { id: data.id as string };
    },

    async claimEvent(id: string, leaseSeconds: number) {
      // Por RPC y no por UPDATE de PostgREST porque `attempts = attempts + 1`
      // tiene que ir en la MISMA sentencia que el cambio de estado. Hacerlo en
      // dos deja una ventana con la fila reclamada y el intento sin contar, que
      // es exactamente por donde se cuelan los reintentos infinitos.
      const { data, error } = await supabase.rpc('claim_webhook_event', {
        p_id: id,
        p_lease_seconds: leaseSeconds,
      });
      if (error) throw new Error(`webhook.claimEvent: ${error.message}`);
      const row = (data as Record<string, unknown>[] | null)?.[0];
      return row ? toRow(row) : null;
    },

    async releaseForRetry(id: string, nextAttemptAt: string, errorMessage: string) {
      const { error } = await supabase
        .from('webhook_events')
        .update({
          status: 'received',
          next_attempt_at: nextAttemptAt,
          error_message: errorMessage.slice(0, 500),
        })
        .eq('id', id);
      if (error) throw new Error(`webhook.releaseForRetry: ${error.message}`);
    },

    async reopenForRetry(id: string): Promise<boolean> {
      const { data, error } = await supabase
        .from('webhook_events')
        .update({
          status: 'received',
          next_attempt_at: new Date().toISOString(),
          error_message: null,
        })
        .eq('id', id)
        .eq('status', 'failed')
        .select('id');
      if (error) throw new Error(`webhook.reopenForRetry: ${error.message}`);
      return (data?.length ?? 0) > 0;
    },

    async markProcessed(id: string): Promise<void> {
      // `next_attempt_at = null` no es cosmético: un terminal agendado lo
      // seleccionaría el worker para siempre, y el CHECK de 0016 lo prohíbe.
      const { error } = await supabase
        .from('webhook_events')
        .update({
          status: 'processed',
          processed_at: new Date().toISOString(),
          next_attempt_at: null,
          error_message: null,
        })
        .eq('id', id);
      if (error) throw new Error(`webhook.markProcessed: ${error.message}`);
    },

    async markFailed(id: string, errorMessage: string): Promise<void> {
      const { error } = await supabase
        .from('webhook_events')
        .update({
          status: 'failed',
          next_attempt_at: null,
          error_message: errorMessage.slice(0, 500),
        })
        .eq('id', id);
      if (error) throw new Error(`webhook.markFailed: ${error.message}`);
    },
  };
}

/**
 * Selección de trabajo vencido para el recovery.
 *
 * Va por RPC porque `FOR UPDATE SKIP LOCKED` no se puede expresar desde
 * PostgREST, y sin él dos ticks solapados leerían la misma fila antes de que
 * ninguno la marcara. El caller NO elige qué fila: la elige la base.
 */
export interface DueWebhookEventSelector {
  claimDue(limit: number, leaseSeconds: number): Promise<WebhookEventRow[]>;
}

export function createSupabaseDueSelector(supabase: SupabaseClient): DueWebhookEventSelector {
  return {
    async claimDue(limit: number, leaseSeconds: number) {
      const { data, error } = await supabase.rpc('claim_due_webhook_events', {
        p_limit: limit,
        p_lease_seconds: leaseSeconds,
      });
      if (error) throw new Error(`webhook.claimDue: ${error.message}`);
      return ((data ?? []) as Record<string, unknown>[]).map(toRow);
    },
  };
}
