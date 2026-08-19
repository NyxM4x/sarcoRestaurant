import type { ProvenanceMessage } from '@/lib/kapso/channel/provenance';
import type { AgentStore, PersistInboundResult } from '@/lib/agent/core/types';

/**
 * Persistencia del historial ENTRANTE del cliente — lógica PURA (Fase 6D.2F.2B).
 *
 * Se ejecuta para todo mensaje real del cliente, sea del tipo que sea: texto,
 * ubicación, imagen, audio, vídeo, documento, sticker, interactivo o desconocido.
 *
 * Dos reglas que no se negocian:
 *
 *  1. NO se inventan marcadores. Un pin de GPS se guarda con `content = NULL` y
 *     sus coordenadas en `metadata`; jamás como el texto `[LOCATION]`.
 *  2. NO se consulta el estado de pausa. Que un humano tenga el control impide
 *     que hable la IA, nunca que se registre la conversación. Este módulo ni
 *     siquiera importa `control/`, de modo que no puede leer ese estado aunque
 *     alguien lo intentara más adelante.
 */
export async function persistCustomerInbound(
  message: ProvenanceMessage,
  store: AgentStore,
  now: () => string = () => new Date().toISOString(),
): Promise<PersistInboundResult> {
  if (message.customerPhone === '') {
    return { result: 'rejected', reason: 'missing_phone' };
  }

  const conversation = await store.upsertConversation({
    customerPhone: message.customerPhone,
    providerConversationId: message.providerConversationId,
    providerPhoneNumberId: message.providerPhoneNumberId,
  });

  // Instante del proveedor; el fallback explícito evita que un timestamp
  // ilegible bloquee el registro del historial.
  const messageTimestamp = message.messageTimestamp ?? now();

  const inserted = await store.insertMessage({
    agentConversationId: conversation.id,
    providerMessageId: message.providerMessageId,
    providerConversationId: message.providerConversationId,
    direction: 'inbound',
    role: 'user',
    actor: 'customer',
    content: message.content,
    contentType: message.contentType,
    metadata: message.metadata,
    messageTimestamp,
  });

  await store.touchCustomerMessageAt(conversation.id, messageTimestamp);

  return {
    result: inserted === 'duplicate' ? 'duplicate' : 'persisted',
    conversationId: conversation.id,
  };
}
