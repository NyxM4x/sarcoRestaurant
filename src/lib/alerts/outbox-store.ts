import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import { getServerEnv } from '@/lib/env/env';
import { log } from '@/lib/log';
import { createTelegramAlertSender } from './telegram';
import type { AlertSendOutcome, TelegramAlertKind, TelegramAlertRow } from './outbox';
import type { AlertOutboxStore, AlertSender, RunAlertDeps } from './outbox-runner';

/**
 * Outbox de alertas sobre Supabase — server-only.
 *
 * Traduce a SQL lo que el runner decide. Ninguna regla vive aquí: el backoff, el
 * qué se reintenta y el cuándo están en `outbox.ts`, que es puro y probado.
 */

const ALERT_COLUMNS = 'id,kind,target_ref,body,attempts,max_attempts';

interface RawAlertRow {
  id: string;
  kind: TelegramAlertKind;
  target_ref: string;
  body: string;
  attempts: number;
  max_attempts: number;
}

function toRow(raw: RawAlertRow): TelegramAlertRow {
  return {
    id: raw.id,
    kind: raw.kind,
    targetRef: raw.target_ref,
    body: raw.body,
    attempts: raw.attempts,
    maxAttempts: raw.max_attempts,
  };
}

export function createSupabaseAlertOutbox(
  client: SupabaseClient = getSupabaseAdmin(),
): AlertOutboxStore {
  return {
    async claimDue(limit, leaseSeconds) {
      // El trabajo lo elige la BASE. La RPC de 0028 hace el reclamo atómico con
      // `for update skip locked`, así que dos ticks concurrentes no se pelean
      // por la misma fila ni se bloquean esperándola.
      const { data, error } = await client.rpc('claim_due_telegram_alerts', {
        p_limit: limit,
        p_lease_seconds: leaseSeconds,
      });
      if (error) throw new Error('alert_claim_failed');
      return ((data ?? []) as RawAlertRow[]).map(toRow);
    },

    async claimById(id, leaseSeconds) {
      // Reclamo por id para el fast path, con la MISMA condición que la RPC:
      // solo gana si nadie más la tiene con lease vigente. Es un UPDATE
      // condicionado, no un SELECT seguido de UPDATE — no hay ventana.
      const ahora = new Date();
      const { data, error } = await client
        .from('telegram_alerts')
        .update({
          status: 'sending',
          claimed_until: new Date(ahora.getTime() + leaseSeconds * 1000).toISOString(),
          updated_at: ahora.toISOString(),
        })
        .eq('id', id)
        .eq('status', 'pending')
        .select(ALERT_COLUMNS)
        .maybeSingle();

      if (error || !data) return null;
      const raw = data as unknown as RawAlertRow;
      // `attempts` lo sube la RPC en el reclamo; aquí se cuenta igual para que
      // el backoff avance también por el fast path.
      await client
        .from('telegram_alerts')
        .update({ attempts: raw.attempts + 1 })
        .eq('id', id);
      return toRow({ ...raw, attempts: raw.attempts + 1 });
    },

    async markSent(id, sentAtIso) {
      const { error } = await client
        .from('telegram_alerts')
        .update({
          status: 'sent',
          sent_at: sentAtIso,
          // Un terminal NUNCA queda agendado: lo exige el CHECK de 0028 y evita
          // que una fila cerrada resucite sola en un tick futuro.
          next_attempt_at: null,
          claimed_until: null,
          updated_at: sentAtIso,
        })
        .eq('id', id);
      if (error) {
        // Un desenlace que no se escribe es un aviso que SE REPITE: la fila se
        // queda en `sending` y el worker la recupera al vencer el lease, con el
        // mismo body. Sin esta línea el tick reporta éxito mientras el grupo de
        // reparto recibe el mismo mensaje cada minuto — que es exactamente cómo
        // pasó inadvertido el `not null` que arregló 0029.
        log.error('alert_mark_sent_failed', { code: error.code });
        throw new Error('alert_mark_sent_failed');
      }
    },

    async reschedule(id, nextAttemptAtIso, errorCode) {
      const { error } = await client
        .from('telegram_alerts')
        .update({
          status: 'pending',
          next_attempt_at: nextAttemptAtIso,
          claimed_until: null,
          last_error: errorCode,
          updated_at: new Date().toISOString(),
        })
        .eq('id', id);
      if (error) {
        // Igual que arriba: sin cita nueva, la fila vuelve por lease vencido.
        log.error('alert_reschedule_failed', { code: error.code });
        throw new Error('alert_reschedule_failed');
      }
    },

    async markFailed(id, errorCode) {
      const { error } = await client
        .from('telegram_alerts')
        .update({
          status: 'failed',
          next_attempt_at: null,
          claimed_until: null,
          last_error: errorCode,
          updated_at: new Date().toISOString(),
        })
        .eq('id', id);
      if (error) {
        // La alerta se rindió pero no consta: no aparecerá en el panel.
        log.error('alert_mark_failed_failed', { code: error.code });
        throw new Error('alert_mark_failed_failed');
      }
    },
  };
}

/**
 * Encola una alerta. Devuelve su id, o `null` si no había nada que encolar.
 *
 * ── El índice único es la protección, no el orden de escrituras ─────────────
 *
 * `(kind, target_ref)` es único en 0028, así que encolar dos veces el aviso del
 * mismo pedido no crea dos avisos: el segundo choca y se retira. Eso es lo que
 * permite reintentar el ENVÍO sin arriesgar que dos repartidores salgan con lo
 * mismo, que es el motivo por el que el diseño anterior prefería perder el
 * aviso antes que reintentarlo.
 *
 * Nunca lanza: quien llama ya hizo lo importante —aceptar el pago, pausar al
 * agente— y no puede caerse porque el outbox no esté disponible.
 */
export async function enqueueAlert(
  kind: TelegramAlertKind,
  targetRef: string,
  body: string,
  client: SupabaseClient = getSupabaseAdmin(),
): Promise<string | null> {
  // ── Sin canal no se encola: es una función APAGADA, no una avería ────────
  //
  // Lo dice el código desde siempre y sigue siendo cierto. Encolar igualmente
  // dejaría una fila por cada pago aceptado y cada handoff, todas destinadas a
  // acabar `failed` con `config_missing` — una tabla llena de basura que
  // además ahogaría las alertas que sí importan, que son las que fallaron
  // teniendo canal.
  //
  // La comprobación va AQUÍ y no en el runner por eso mismo: el runner decide
  // qué hacer con un envío que se intentó, y esto decide si hay algo que
  // intentar. Si las credenciales existen pero están mal, sí se encola y sí
  // queda constancia — que es justo lo que hay que ver.
  if (!isTelegramConfiguredFor(kind)) return null;

  try {
    const { data, error } = await client
      .from('telegram_alerts')
      .insert({ kind, target_ref: targetRef, body, status: 'pending' })
      .select('id')
      .maybeSingle();

    if (error) {
      // 23505 = ya existe esa alerta. No es un fallo: es la garantía haciendo
      // su trabajo, y significa que el aviso ya está encolado o ya salió.
      if (error.code !== '23505') log.error('alert_enqueue_failed', { kind });
      return null;
    }
    return (data as { id: string } | null)?.id ?? null;
  } catch {
    log.error('alert_enqueue_error', { kind });
    return null;
  }
}

/**
 * ¿Hay canal para esta clase de aviso?
 *
 * Se pregunta antes de encolar. `handoff_notice` cae al chat general cuando no
 * tiene el suyo, así que le basta con que exista uno de los dos.
 */
export function isTelegramConfiguredFor(kind: TelegramAlertKind): boolean {
  try {
    const env = getServerEnv();
    return Boolean(env.TELEGRAM_BOT_TOKEN) && Boolean(chatIdFor(kind, env));
  } catch {
    // Sin entorno válido no hay canal. Fail-closed, como el resto del proyecto.
    return false;
  }
}

/**
 * A qué chat va cada clase de aviso.
 *
 * `TELEGRAM_HANDOFF_CHAT_ID` separa los reclamos de clientes del grupo de
 * reparto, donde serían ruido para quien está montado en una moto. Con fallback
 * al chat de siempre: exigir un grupo nuevo antes de tenerlo creado apagaría la
 * función entera, y un aviso en el grupo equivocado sirve más que ninguno.
 */
function chatIdFor(kind: TelegramAlertKind, env: ReturnType<typeof getServerEnv>): string | null {
  if (kind === 'handoff_notice') return env.TELEGRAM_HANDOFF_CHAT_ID || env.TELEGRAM_CHAT_ID || null;
  return env.TELEGRAM_CHAT_ID || null;
}

/** Transporte real. Sin credenciales devuelve `permanent`: es una función apagada. */
export function createRealAlertSender(): AlertSender {
  return async (kind, body): Promise<AlertSendOutcome> => {
    let env;
    try {
      env = getServerEnv();
    } catch {
      return { kind: 'permanent', code: 'env_unavailable' };
    }
    const chatId = chatIdFor(kind, env);
    if (!env.TELEGRAM_BOT_TOKEN || !chatId) {
      // No es un error transitorio: sin credenciales no hay canal, y reintentar
      // cinco veces solo retrasaría media hora el momento de verlo en el panel.
      return { kind: 'permanent', code: 'config_missing' };
    }
    return createTelegramAlertSender({ botToken: env.TELEGRAM_BOT_TOKEN, chatId }).send(body);
  };
}

/** Dependencias reales del runner. */
export function createAlertRunnerDeps(
  client: SupabaseClient = getSupabaseAdmin(),
): RunAlertDeps {
  return {
    store: createSupabaseAlertOutbox(client),
    send: createRealAlertSender(),
    now: () => Date.now(),
  };
}
