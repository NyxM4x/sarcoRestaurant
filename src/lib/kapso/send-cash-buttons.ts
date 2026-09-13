import 'server-only';
import { getKapsoClient } from './client';
import { CASH_LAST_CALL_TEXT, CASH_REPROMPT_TEXT, cashDecisionButtons } from './messages';
import { log } from '@/lib/log';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import { createAgentStore } from '@/lib/agent/memory/repository';

/**
 * Volver a ponerle los botones delante al que escribió — envío y memoria
 * (13-09-2026).
 *
 * Hermano de `send-wait-notice`: mismo transporte, misma memoria, misma forma
 * de no lanzar nunca. Lo que cambia es que este mensaje sale con los DOS
 * BOTONES pegados en vez de con texto pelado, porque su único propósito es que
 * el cliente tenga qué tocar sin subir el chat a buscarlo.
 *
 * ── La fila de memoria ES el contador ───────────────────────────────────────
 *
 * `customer-state-service` cuenta las filas con `metadata.action = cash_reprompt`
 * desde que nació el pedido, y `decideDefaultReply` deja de avisar a la segunda.
 * Si la anotación falla, lo que se pierde es el freno: el cliente podría recibir
 * un aviso de más. Molesto y recuperable, muy por debajo de no avisarle — así
 * que `ok` sigue siendo `true`, igual que en `send-wait-notice`.
 */

/** La clave con la que se anota. Vive aquí y se importa; nunca se recopia. */
export const CASH_REPROMPT_ACTION = 'cash_reprompt';

export interface SendCashButtonsInput {
  /** Teléfono del cliente, solo dígitos. */
  toDigits: string;
  phoneNumberId: string | null;
  /** El pedido cuyos botones se reponen. Viaja dentro del id de cada botón. */
  orderNumber: string;
  /**
   * Cuál de los dos avisos.
   *
   * `first` recuerda que hay que tocar; `last` dice lo que pasa si no toca. No
   * hay un tercero: después de `last` el agente calla y el pedido lo cierra el
   * barrido de los veinte minutos.
   */
  step: 'first' | 'last';
}

export async function sendCashButtons(input: SendCashButtonsInput): Promise<{ ok: boolean }> {
  const texto = input.step === 'first' ? CASH_REPROMPT_TEXT : CASH_LAST_CALL_TEXT;
  const botones = cashDecisionButtons(input.orderNumber);

  let wamid: string;
  try {
    const enviado = await getKapsoClient().sendButtons(input.toDigits, texto, botones, {
      phoneNumberId: input.phoneNumberId ?? undefined,
    });
    if (!enviado.ok) {
      // El código de error es un enum del transporte, nunca texto del proveedor,
      // y el número de pedido no viaja al log.
      log.warn('cash_reprompt_send_failed', { step: input.step, error: enviado.error });
      return { ok: false };
    }
    wamid = enviado.wamid;
  } catch {
    log.warn('cash_reprompt_send_failed', { step: input.step, error: 'threw' });
    return { ok: false };
  }

  try {
    const store = createAgentStore(getSupabaseAdmin());
    const conversation = await store.upsertConversation({
      customerPhone: input.toDigits,
      providerConversationId: null,
      providerPhoneNumberId: input.phoneNumberId,
    });

    await store.insertMessage({
      agentConversationId: conversation.id,
      providerMessageId: wamid,
      providerConversationId: null,
      direction: 'outbound',
      role: 'assistant',
      actor: 'automation',
      content: texto,
      contentType: 'text',
      metadata: { action: CASH_REPROMPT_ACTION, resource_type: 'order' },
      messageTimestamp: new Date().toISOString(),
    });
  } catch {
    log.warn('cash_reprompt_memory_failed', { step: input.step });
  }

  return { ok: true };
}
