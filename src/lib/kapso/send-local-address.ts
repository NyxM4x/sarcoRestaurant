import 'server-only';
import { getKapsoClient } from './client';
import { localAddressText } from './messages';
import { log } from '@/lib/log';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import { createAgentStore } from '@/lib/agent/memory/repository';

/**
 * "Estamos en la Doble Vía La Guardia" — envío y memoria (server-only).
 *
 * Es la respuesta a quien pregunta dónde queda el LOCAL. Ver
 * `webhook/local-address-intent.ts` para cuándo se elige esta rama, y
 * `kapso/messages.ts` para el texto.
 *
 * ── Por qué se anota en la memoria conversacional ───────────────────────────
 *
 * Por lo mismo que el recordatorio del comprobante: sin la fila, el modelo no
 * sabe que este mensaje salió. Si el cliente escribe después "y eso queda
 * lejos?", el agente tiene que poder ver que ya se le mandó la dirección — si
 * no, contesta como si fuera la primera vez.
 *
 * A diferencia de aquel, aquí un fallo al persistir NO se propaga al llamador:
 * no hay ningún cooldown colgando de esta fila. Repetir la dirección a quien la
 * pregunta dos veces es la respuesta correcta las dos veces.
 */

/**
 * Valor de `metadata.action` de la fila.
 *
 * Vive en un solo sitio y se importa: dos literales iguales escritos por
 * separado se separan a la primera.
 */
export const LOCAL_ADDRESS_ACTION = 'local_address';

export interface SendLocalAddressInput {
  /** Teléfono del cliente, solo dígitos. */
  toDigits: string;
  phoneNumberId: string | null;
  /** WAMID del mensaje del cliente que preguntó. */
  sourceMessageId: string;
}

/**
 * Manda la dirección y la anota. NUNCA lanza.
 *
 * `ok: false` significa que el cliente puede no haberla recibido. No se
 * reintenta: el siguiente mensaje suyo vuelve a pasar por aquí, y ese es un
 * reintento mejor que cualquiera nuestro porque viene con la prueba de que
 * sigue preguntando.
 */
export async function sendLocalAddress(
  input: SendLocalAddressInput,
): Promise<{ ok: boolean }> {
  const texto = localAddressText();

  let wamid: string;
  try {
    const enviado = await getKapsoClient().sendText(input.toDigits, texto, {
      phoneNumberId: input.phoneNumberId ?? undefined,
    });
    if (!enviado.ok) {
      // El código de error es un enum del transporte, nunca texto del proveedor.
      log.warn('local_address_send_failed', { error: enviado.error });
      return { ok: false };
    }
    wamid = enviado.wamid;
  } catch {
    log.warn('local_address_send_failed', { error: 'threw' });
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
      metadata: { action: LOCAL_ADDRESS_ACTION },
      messageTimestamp: new Date().toISOString(),
    });
  } catch {
    // El mensaje YA está en el teléfono del cliente: `ok` sigue siendo true.
    // Lo que se pierde es que el modelo sepa que salió.
    log.warn('local_address_memory_failed');
  }

  return { ok: true };
}
