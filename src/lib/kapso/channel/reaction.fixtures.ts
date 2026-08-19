/**
 * Fixtures de REACCIÓN derivados del payload REAL capturado en Production
 * (16-08-2026, teléfono de pruebas, buffering ON con ventana de 5 s).
 *
 * Sanitizado: teléfono, WAMIDs, `conversation.id`, BSUID y `phone_number_id`.
 * NO sanitizado: la ESTRUCTURA. La presencia y la ausencia de cada campo se
 * conservan exactamente como llegaron, porque es justo lo que distingue las dos
 * operaciones:
 *
 *   · ADD    → `reaction.emoji` PRESENTE
 *   · REMOVE → `reaction.emoji` AUSENTE  (no vacío: ausente)
 *
 * No existe un fixture con `emoji: ""` porque eso no fue lo observado, y un
 * fixture que inventa una forma acaba defendiendo un comportamiento que el
 * proveedor nunca produce.
 *
 * `kapso.content` se conserva a propósito, con su frase en inglés incluida: es
 * la contaminación concreta que 5C.4 impide que llegue ni a `agent_messages` ni
 * al contexto del modelo. Un fixture sin ella no probaría nada.
 */

/** WAMID del mensaje del bot al que se reacciona. */
export const REACTION_TARGET_WAMID = 'wamid.TARGET_SANITIZED';
/** WAMID propio del evento "agregar reacción". */
export const REACTION_ADD_WAMID = 'wamid.REACTION_ADD_SANITIZED';
/** WAMID propio del evento "quitar reacción" — distinto del anterior. */
export const REACTION_REMOVE_WAMID = 'wamid.REACTION_REMOVE_SANITIZED';

export const REACTION_EMOJI = '❤️';

const CUSTOMER_PHONE = '59100000000';
const CONVERSATION_ID = '00000000-0000-4000-8000-000000000001';
const PHONE_NUMBER_ID = '000000000000000';
const BSUID = 'BOSANITIZED0000000000';

/** Sobre canónico V2, igual que un elemento de `data[]` en un lote. */
function envelope(message: Record<string, unknown>): Record<string, unknown> {
  return {
    message,
    conversation: {
      id: CONVERSATION_ID,
      phone_number: CUSTOMER_PHONE,
      // Evidencia para la futura fase BSUID. Solo se documenta; 5C.4 no toca
      // identidad y sigue resolviendo por `conversation.phone_number`.
      business_scoped_user_id: BSUID,
    },
    is_new_conversation: false,
    phone_number_id: PHONE_NUMBER_ID,
  };
}

/** AGREGAR reacción: `reaction.emoji` presente. */
export function reactionAddEnvelope(
  wamid: string = REACTION_ADD_WAMID,
  target: string = REACTION_TARGET_WAMID,
): Record<string, unknown> {
  return envelope({
    id: wamid,
    type: 'reaction',
    from: CUSTOMER_PHONE,
    from_user_id: BSUID,
    timestamp: 1_760_000_000,
    reaction: {
      message_id: target,
      emoji: REACTION_EMOJI,
    },
    kapso: {
      direction: 'inbound',
      origin: 'business_app',
      status: 'received',
      content: `Reacted with ${REACTION_EMOJI} to message ${target}`,
      message_type_data: {
        message_id: target,
        emoji: REACTION_EMOJI,
      },
    },
  });
}

/** QUITAR reacción: `reaction.emoji` AUSENTE, y WAMID propio distinto. */
export function reactionRemoveEnvelope(
  wamid: string = REACTION_REMOVE_WAMID,
  target: string = REACTION_TARGET_WAMID,
): Record<string, unknown> {
  return envelope({
    id: wamid,
    type: 'reaction',
    from: CUSTOMER_PHONE,
    from_user_id: BSUID,
    timestamp: 1_760_000_060,
    reaction: {
      message_id: target,
    },
    kapso: {
      direction: 'inbound',
      origin: 'business_app',
      status: 'received',
      content: `Reaction removed from message ${target}`,
      message_type_data: {
        message_id: target,
      },
    },
  });
}
