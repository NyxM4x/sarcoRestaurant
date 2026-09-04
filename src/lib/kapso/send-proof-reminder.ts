import 'server-only';
import { getKapsoClient } from './client';
import { proofAckText, proofReminderText } from './messages';
import { log } from '@/lib/log';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import { createAgentStore } from '@/lib/agent/memory/repository';

/**
 * "Falta tu comprobante" — envío y memoria (server-only, 03-09-2026).
 *
 * Es la respuesta por defecto del cliente que ya tiene su pedido cotizado y su
 * QR, y escribe antes de mandar el pago. Ver `webhook/default-reply.ts` para
 * cuándo se elige esta rama y no el botón del menú.
 *
 * ── La fila de memoria no es contabilidad: es el reloj ──────────────────────
 *
 * El recordatorio contesta a un mensaje del cliente, así que sin freno saldría
 * uno por cada cosa que escriba. El freno es esta fila: `customer-state-service`
 * pregunta por ella antes de decidir, y mientras esté fresca no se manda otro.
 *
 * Por eso, y a diferencia de la memoria del menú —que se traga sus errores
 * porque el CTA ya está en el teléfono del cliente—, aquí un fallo al persistir
 * SÍ se reporta al llamador. Un recordatorio enviado y no anotado es un
 * recordatorio que se va a repetir con el siguiente mensaje.
 */

/**
 * Valor de `metadata.action` de la fila. Es la clave con la que el cooldown la
 * encuentra, así que vive en un solo sitio y se importa; dos literales iguales
 * escritos por separado se separan a la primera.
 *
 * Está también en la lista blanca de `agent/core/context.ts`, que es lo que
 * permite que el modelo sepa que este mensaje salió sin llegar a leer su texto.
 */
export const PROOF_REMINDER_ACTION = 'proof_reminder';

export interface SendProofReminderInput {
  /** Teléfono del cliente, solo dígitos. */
  toDigits: string;
  phoneNumberId: string | null;
  /** WAMID del mensaje del cliente que provocó el recordatorio. */
  sourceMessageId: string;
  /** Número interno (`ORD-260903-007`); el copy lo acorta a `#7`. */
  orderNumber: string;
  totalAmount: number;
  /**
   * Qué se le dice del pago. Ausente = `missing`, que es como se comportaba
   * antes de que existiera la otra mitad. Ver `DefaultReplyDecision`.
   */
  variant?: 'missing' | 'received';
}

/**
 * Manda el recordatorio y lo anota. NUNCA lanza.
 *
 * `ok: false` significa que el cliente puede no haberlo recibido, y el webhook
 * lo refleja en su cuerpo sin reintentar: el siguiente mensaje del cliente
 * vuelve a pasar por aquí, que es un reintento mejor que cualquiera nuestro
 * —viene con la prueba de que sigue esperando—.
 */
export async function sendProofReminder(
  input: SendProofReminderInput,
): Promise<{ ok: boolean }> {
  const texto =
    input.variant === 'received'
      ? proofAckText(input.orderNumber)
      : proofReminderText(input.orderNumber, input.totalAmount);

  let wamid: string;
  try {
    const enviado = await getKapsoClient().sendText(input.toDigits, texto, {
      phoneNumberId: input.phoneNumberId ?? undefined,
    });
    if (!enviado.ok) {
      // El código de error es un enum del transporte, nunca texto del proveedor.
      log.warn('proof_reminder_send_failed', { error: enviado.error });
      return { ok: false };
    }
    wamid = enviado.wamid;
  } catch {
    log.warn('proof_reminder_send_failed', { error: 'threw' });
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
      // El texto REAL que vio el cliente. El contexto del modelo NO lo lee: lo
      // proyecta como un evento del canal a partir de `metadata.action`.
      content: texto,
      contentType: 'text',
      metadata: { action: PROOF_REMINDER_ACTION, resource_type: 'payment_proof' },
      messageTimestamp: new Date().toISOString(),
    });
  } catch {
    // El mensaje YA está en el teléfono del cliente: `ok` sigue siendo true —
    // mentir sobre eso sería peor. Lo que se pierde es el freno, y por eso se
    // deja constancia: el próximo mensaje del cliente podría traerle otro.
    log.warn('proof_reminder_memory_failed');
  }

  return { ok: true };
}
