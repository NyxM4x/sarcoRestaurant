import 'server-only';
import { getKapsoClient } from './client';
import { cashPolicyText } from './messages';
import { log } from '@/lib/log';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import { createAgentStore } from '@/lib/agent/memory/repository';

/**
 * "Desde ahora los pedidos se pagan solo por QR" — envío y memoria
 * (server-only, 27-09-2026).
 *
 * Es la respuesta a quien pregunta por el efectivo, o dice que no tiene QR,
 * con un pedido por QR todavía sin pagar. Ver `webhook/default-reply.ts` para
 * cuándo se elige esta rama, y `kapso/messages.ts` (`cashPolicyText`) para el
 * texto.
 *
 * ── Por qué se anota en la memoria conversacional ───────────────────────────
 *
 * Por dos cosas, y la segunda es la que importa: el modelo tiene que ver que
 * este mensaje salió, y la fila es además el freno de "una vez por pedido"
 * (`cashPolicySent`, en `customer-state-service`). Un fallo al persistir no se
 * propaga: el cliente ya lo leyó, y lo peor que pasa es que se le repita.
 */

/**
 * Valor de `metadata.action` de la fila.
 *
 * Vive en un solo sitio y se importa: dos literales iguales escritos por
 * separado se separan a la primera.
 */
export const CASH_POLICY_ACTION = 'cash_policy';

export interface SendCashPolicyInput {
  /** Teléfono del cliente, solo dígitos. */
  toDigits: string;
  phoneNumberId: string | null;
  /** WAMID del mensaje del cliente que preguntó. */
  sourceMessageId: string;
  orderNumber: string;
  foodAmount: number;
  totalAmount: number;
  awaitingLocation: boolean;
}

/**
 * Manda el aviso y lo anota. NUNCA lanza.
 *
 * `ok: false` significa que el cliente puede no haberlo recibido. No se
 * reintenta: sin la fila, su siguiente mensaje sobre el efectivo vuelve a
 * pasar por aquí.
 */
export async function sendCashPolicy(input: SendCashPolicyInput): Promise<{ ok: boolean }> {
  const texto = cashPolicyText({
    orderNumber: input.orderNumber,
    foodAmount: input.foodAmount,
    totalAmount: input.totalAmount,
    awaitingLocation: input.awaitingLocation,
  });

  let wamid: string;
  try {
    const enviado = await getKapsoClient().sendText(input.toDigits, texto, {
      phoneNumberId: input.phoneNumberId ?? undefined,
    });
    if (!enviado.ok) {
      // El código de error es un enum del transporte, nunca texto del proveedor.
      log.warn('cash_policy_send_failed', { error: enviado.error });
      return { ok: false };
    }
    wamid = enviado.wamid;
  } catch {
    log.warn('cash_policy_send_failed', { error: 'threw' });
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
      metadata: { action: CASH_POLICY_ACTION },
      messageTimestamp: new Date().toISOString(),
    });
  } catch {
    // El mensaje YA está en el teléfono del cliente: `ok` sigue siendo true.
    log.warn('cash_policy_memory_failed');
  }

  return { ok: true };
}
