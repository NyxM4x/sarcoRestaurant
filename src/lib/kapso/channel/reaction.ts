/**
 * REACCIONES DE WHATSAPP — parseo PURO (Fase 6D.2F.5C.4).
 *
 * Contrato OBSERVADO en Production el 16-08-2026, no documentación:
 *
 *   AGREGAR                                  QUITAR
 *   message.type = 'reaction'                message.type = 'reaction'
 *   message.id   = WAMID propio              message.id   = OTRO WAMID propio
 *   reaction = { message_id, emoji }         reaction = { message_id }
 *                                            ← NO existe `reaction.emoji`
 *
 * Los dos son `whatsapp.message.received` y los dos traen WAMID propio, así que
 * deduplican por la vía normal y ninguno es "el mismo evento" que el otro.
 *
 * ── La fuente de verdad es `reaction`, nunca `kapso.content` ────────────────
 *
 * Kapso además redacta una frase:
 *
 *     "Reacted with ❤️ to message <wamid>"
 *     "Reaction removed from message <wamid>"
 *
 * Es texto GENERADO POR EL PROVEEDOR, en inglés, sobre un tipo de mensaje que
 * no es textual. No lo escribió el cliente. Deducir la operación leyendo esa
 * frase ataría el sistema a un copy que Kapso puede cambiar, traducir o
 * localizar sin avisar; la presencia o ausencia de `reaction.emoji` es
 * estructura, y la estructura es lo que se parsea.
 *
 * Esa frase tampoco se persiste como contenido del cliente. Ver `provenance.ts`.
 */

/** `message.type` de una reacción. */
export const KAPSO_MESSAGE_TYPE_REACTION = 'reaction';

/** Qué hizo la persona con la reacción. */
export type ReactionOperation = 'add' | 'remove';

/** Vista estructurada de una reacción, lista para `metadata`. */
export interface ReactionEvent {
  operation: ReactionOperation;
  /** WAMID del mensaje al que se reacciona. */
  targetMessageId: string | null;
  /** Solo en `add`. En `remove` el campo no viene y aquí es `null`. */
  emoji: string | null;
}

function rec(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** ¿El `message.type` declarado es una reacción? */
export function isReactionType(messageType: string | null | undefined): boolean {
  return messageType === KAPSO_MESSAGE_TYPE_REACTION;
}

/** ¿El mensaje declara ser una reacción? */
export function isReactionMessage(message: Record<string, unknown> | undefined | null): boolean {
  return isReactionType(str(message?.type));
}

/**
 * Vista estructurada, o `null` si el mensaje no trae objeto `reaction`.
 *
 * Devolver `null` en vez de un evento con huecos es deliberado: un
 * `type='reaction'` sin `reaction` es una forma que NO hemos observado, y
 * rellenarla con `operation: 'remove'` afirmaría que alguien quitó una reacción
 * cuando lo único que consta es que no sabemos leer el mensaje.
 *
 * El silencio no depende de esta función: lo decide el TIPO declarado, que sigue
 * siendo `reaction` aunque el parseo devuelva `null`.
 */
export function parseReaction(message: Record<string, unknown> | undefined): ReactionEvent | null {
  if (!isReactionMessage(message)) return null;

  const reaction = rec(message?.reaction);
  if (!reaction) return null;

  // Presencia estructural del emoji, no su contenido: `add` si viene y dice
  // algo, `remove` si no viene. Un `emoji: ""` no se ha observado nunca; se
  // trata como `remove` porque una cadena vacía no es un emoji que registrar,
  // y almacenarla como `add` guardaría una reacción sin reacción.
  const emoji = str(reaction.emoji);

  return {
    operation: emoji !== null ? 'add' : 'remove',
    targetMessageId: str(reaction.message_id),
    emoji,
  };
}

/**
 * `metadata` de un mensaje de reacción — la forma exacta que se persiste.
 *
 *     { "channel_event": "reaction",
 *       "reaction": { "operation": "add",
 *                     "emoji": "❤️",
 *                     "target_message_id": "wamid..." } }
 *
 * `emoji` solo aparece en `add`, porque en `remove` el proveedor no lo manda y
 * escribir `null` sería inventar un campo que el evento no tiene.
 *
 * `channel_event` es la marca que hace la fila legible sin adivinar: dice que
 * esto es algo que PASÓ en el canal, no algo que alguien DIJO. Nace pensada para
 * más de un tipo — 5C.5 tendrá el mismo problema con la media.
 */
export function reactionMetadata(
  message: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const parsed = parseReaction(message);
  if (parsed === null) return { channel_event: KAPSO_MESSAGE_TYPE_REACTION };

  const reaction: Record<string, unknown> = { operation: parsed.operation };
  if (parsed.emoji !== null) reaction.emoji = parsed.emoji;
  if (parsed.targetMessageId !== null) reaction.target_message_id = parsed.targetMessageId;

  return { channel_event: KAPSO_MESSAGE_TYPE_REACTION, reaction };
}
