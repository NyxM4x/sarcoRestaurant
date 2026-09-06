import 'server-only';
import { getKapsoClient } from './client';
import { CASH_WAIT_TEXT, PROOF_WAIT_TEXT, deliveryRelayText } from './messages';
import { log } from '@/lib/log';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import { createAgentStore } from '@/lib/agent/memory/repository';

/**
 * "Tu pedido ya está en nuestras manos" — envío y memoria (06-09-2026).
 *
 * Los tres salientes del tramo en que el cliente ya no puede hacer nada más por
 * su pedido: el acuse del comprobante, el acuse del efectivo confirmado, y la
 * frase que manda con el repartidor a quien pide un cambio cuando ya no cabe.
 * Ver `waitingOnUs` en `webhook/default-reply.ts` para cuándo sale cada uno.
 *
 * ── Por qué los tres en un módulo ───────────────────────────────────────────
 *
 * Porque son un solo mecanismo: el mismo transporte, la misma memoria y la
 * misma pregunta —¿ya se le dijo?— resuelta por la misma consulta. Lo único que
 * cambia es el texto y la clave con la que se anota. Separarlos en tres
 * archivos calcados haría que el día que uno se retoque, los otros dos se
 * queden atrás.
 *
 * ── La fila de memoria no es contabilidad: es el freno ──────────────────────
 *
 * Igual que en `send-proof-reminder`, pero con un reloj distinto. Allí la fila
 * caduca a los 15 minutos porque el recordatorio del pago DEBE repetirse;
 * aquí no caduca, porque el acuse sale UNA vez por pedido y después el agente
 * calla. `customer-state-service` la busca desde que el pedido entró en espera.
 *
 * Si no se llega a anotar, lo que se pierde es el freno: el cliente recibirá el
 * acuse otra vez con su siguiente mensaje. Es molesto y recuperable —muy por
 * debajo de mentir diciendo que el envío falló cuando el mensaje ya está en su
 * teléfono—, así que se deja constancia y `ok` sigue siendo `true`.
 */

/**
 * Valores de `metadata.action`. Son las claves con las que
 * `customer-state-service` sabe que el aviso ya salió, así que viven en un solo
 * sitio y se importan; dos literales iguales escritos por separado se separan a
 * la primera.
 *
 * Están también en la lista blanca de `agent/core/context.ts`, que es lo que
 * permite que el modelo sepa que estos mensajes salieron sin leer su texto.
 */
export const PROOF_WAIT_ACTION = 'proof_wait';
export const CASH_WAIT_ACTION = 'cash_wait';
export const DELIVERY_RELAY_ACTION = 'delivery_relay';

/**
 * Cuál de los tres avisos.
 *
 * `proof_wait` y `cash_wait` son el acuse —salen una vez y después hay
 * silencio—; `delivery_relay` contesta a una petición concreta del cliente, y
 * por eso sale cada vez que la hace: es una pregunta nueva suya, no una
 * repetición nuestra.
 */
export type WaitNoticeKind = 'proof_wait' | 'cash_wait' | 'delivery_relay';

export interface SendWaitNoticeInput {
  /** Teléfono del cliente, solo dígitos. */
  toDigits: string;
  phoneNumberId: string | null;
  /** WAMID del mensaje del cliente que provocó el aviso. */
  sourceMessageId: string;
  kind: WaitNoticeKind;
  /**
   * Solo lo usa `delivery_relay`, y solo para el copy: a quien pasa a recoger
   * no se le puede decir que el delivery lo va a llamar.
   */
  deliveryType?: 'delivery' | 'pickup' | null;
}

/** El texto que le toca a cada aviso. */
function textoDe(input: SendWaitNoticeInput): string {
  if (input.kind === 'proof_wait') return PROOF_WAIT_TEXT;
  if (input.kind === 'cash_wait') return CASH_WAIT_TEXT;
  return deliveryRelayText(input.deliveryType ?? null);
}

/**
 * A qué se refiere la fila. Es solo para leerla después: el acuse del
 * comprobante habla de un pago, los otros dos del pedido.
 */
function recursoDe(kind: WaitNoticeKind): string {
  return kind === 'proof_wait' ? 'payment_proof' : 'order';
}

/** La clave con la que se anota. Ver las constantes de arriba. */
function accionDe(kind: WaitNoticeKind): string {
  if (kind === 'proof_wait') return PROOF_WAIT_ACTION;
  if (kind === 'cash_wait') return CASH_WAIT_ACTION;
  return DELIVERY_RELAY_ACTION;
}

/**
 * Manda el aviso y lo anota. NUNCA lanza.
 *
 * `ok: false` significa que el cliente puede no haberlo recibido, y el webhook
 * lo refleja en su cuerpo sin reintentar. El siguiente mensaje del cliente
 * vuelve a pasar por aquí, que es un reintento mejor que cualquiera nuestro:
 * viene con la prueba de que sigue esperando.
 */
export async function sendWaitNotice(input: SendWaitNoticeInput): Promise<{ ok: boolean }> {
  const texto = textoDe(input);

  let wamid: string;
  try {
    const enviado = await getKapsoClient().sendText(input.toDigits, texto, {
      phoneNumberId: input.phoneNumberId ?? undefined,
    });
    if (!enviado.ok) {
      // El código de error es un enum del transporte, nunca texto del proveedor.
      log.warn('wait_notice_send_failed', { kind: input.kind, error: enviado.error });
      return { ok: false };
    }
    wamid = enviado.wamid;
  } catch {
    log.warn('wait_notice_send_failed', { kind: input.kind, error: 'threw' });
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
      metadata: { action: accionDe(input.kind), resource_type: recursoDe(input.kind) },
      messageTimestamp: new Date().toISOString(),
    });
  } catch {
    // Ver la cabecera: el mensaje ya está en el teléfono del cliente, así que
    // `ok` sigue siendo true. Lo que se pierde es el freno.
    log.warn('wait_notice_memory_failed', { kind: input.kind });
  }

  return { ok: true };
}
