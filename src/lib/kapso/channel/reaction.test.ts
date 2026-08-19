import { describe, it, expect } from 'vitest';
import { isReactionMessage, isReactionType, parseReaction, reactionMetadata } from './reaction';
import { parseKapsoProvenance, KAPSO_EVENT_RECEIVED } from './provenance';
import {
  reactionAddEnvelope,
  reactionRemoveEnvelope,
  REACTION_ADD_WAMID,
  REACTION_REMOVE_WAMID,
  REACTION_TARGET_WAMID,
  REACTION_EMOJI,
} from './reaction.fixtures';

/**
 * REACCIONES (Fase 6D.2F.5C.4).
 *
 * Los fixtures son el contrato REAL capturado en Production, sanitizado. Lo que
 * se prueba aquí no es "el parser hace lo que dice el parser": es que la frase
 * que Kapso redacta —"Reacted with ❤️ to message wamid…"— no llega jamás a
 * `content`, que es por donde se colaría al modelo.
 */

function mensajeDe(envelope: Record<string, unknown>): Record<string, unknown> {
  return envelope.message as Record<string, unknown>;
}

describe('reaction — parseo del contrato real', () => {
  it('1 · ADD: emoji presente → operation add, con target y emoji', () => {
    const parsed = parseReaction(mensajeDe(reactionAddEnvelope()));

    expect(parsed).toEqual({
      operation: 'add',
      targetMessageId: REACTION_TARGET_WAMID,
      emoji: REACTION_EMOJI,
    });
  });

  it('2 · REMOVE: emoji AUSENTE → operation remove, sin emoji', () => {
    const message = mensajeDe(reactionRemoveEnvelope());

    // El contrato observado: el campo no viene, no viene vacío.
    expect('emoji' in (message.reaction as Record<string, unknown>)).toBe(false);

    expect(parseReaction(message)).toEqual({
      operation: 'remove',
      targetMessageId: REACTION_TARGET_WAMID,
      emoji: null,
    });
  });

  it('la operación NO se deduce de kapso.content', () => {
    // Se invierte la frase de Kapso dejando la estructura intacta. Si el parseo
    // mirara el texto, este caso diría `remove`.
    const message = mensajeDe(reactionAddEnvelope());
    (message.kapso as Record<string, unknown>).content =
      `Reaction removed from message ${REACTION_TARGET_WAMID}`;

    expect(parseReaction(message)?.operation).toBe('add');
  });

  it('type=reaction sin objeto reaction: no se inventa una operación', () => {
    const message = { id: 'wamid.X', type: 'reaction' };

    // Sigue siendo una reacción —y por tanto sigue callando— pero no se afirma
    // que alguien haya quitado nada.
    expect(isReactionMessage(message)).toBe(true);
    expect(parseReaction(message)).toBeNull();
    expect(reactionMetadata(message)).toEqual({ channel_event: 'reaction' });
  });

  it('un mensaje de texto no es una reacción', () => {
    expect(isReactionMessage({ type: 'text', text: { body: 'hola' } })).toBe(false);
    expect(isReactionType('text')).toBe(false);
    expect(isReactionType(null)).toBe(false);
  });
});

describe('reaction — metadata que se persiste', () => {
  it('3 · ADD: operation, emoji y target', () => {
    expect(reactionMetadata(mensajeDe(reactionAddEnvelope()))).toEqual({
      channel_event: 'reaction',
      reaction: {
        operation: 'add',
        emoji: REACTION_EMOJI,
        target_message_id: REACTION_TARGET_WAMID,
      },
    });
  });

  it('4 · REMOVE: sin clave emoji, no con emoji null', () => {
    const metadata = reactionMetadata(mensajeDe(reactionRemoveEnvelope()));

    expect(metadata).toEqual({
      channel_event: 'reaction',
      reaction: {
        operation: 'remove',
        target_message_id: REACTION_TARGET_WAMID,
      },
    });
    // Un `emoji: null` sería un campo que el evento no tiene.
    expect('emoji' in ((metadata.reaction as Record<string, unknown>) ?? {})).toBe(false);
  });
});

describe('reaction — provenance', () => {
  it('5 · kapso.content NO se persiste como texto del cliente', () => {
    const provenance = parseKapsoProvenance(KAPSO_EVENT_RECEIVED, reactionAddEnvelope());

    expect(provenance.kind).toBe('customer_inbound');
    const message = (provenance as { message: { content: string | null } }).message;

    // Lo que importa: la frase de Kapso existe en el payload y NO llega aquí.
    expect(message.content).toBeNull();
  });

  it('la reacción conserva su WAMID propio y su tipo unknown', () => {
    const add = parseKapsoProvenance(KAPSO_EVENT_RECEIVED, reactionAddEnvelope());
    const remove = parseKapsoProvenance(KAPSO_EVENT_RECEIVED, reactionRemoveEnvelope());

    const uno = (add as { message: { providerMessageId: string | null; contentType: string } })
      .message;
    const dos = (remove as { message: { providerMessageId: string | null; contentType: string } })
      .message;

    expect(uno.providerMessageId).toBe(REACTION_ADD_WAMID);
    expect(dos.providerMessageId).toBe(REACTION_REMOVE_WAMID);
    // Sin migración: la semántica vive en metadata, no en el dominio de la columna.
    expect(uno.contentType).toBe('unknown');
    expect(dos.contentType).toBe('unknown');
  });

  it('10 · add y remove del MISMO target son dos eventos distintos', () => {
    const add = parseKapsoProvenance(KAPSO_EVENT_RECEIVED, reactionAddEnvelope());
    const remove = parseKapsoProvenance(KAPSO_EVENT_RECEIVED, reactionRemoveEnvelope());

    const uno = (add as { message: { providerMessageId: string | null } }).message;
    const dos = (remove as { message: { providerMessageId: string | null } }).message;

    // Dos WAMID = dos filas legítimas. No se deduplica por target: una persona
    // puede poner, quitar y volver a poner una reacción cuantas veces quiera.
    expect(uno.providerMessageId).not.toBe(dos.providerMessageId);
  });

  it('la metadata viaja en el mensaje de provenance', () => {
    const provenance = parseKapsoProvenance(KAPSO_EVENT_RECEIVED, reactionRemoveEnvelope());
    const message = (provenance as { message: { metadata: Record<string, unknown> | null } })
      .message;

    expect(message.metadata).toEqual({
      channel_event: 'reaction',
      reaction: { operation: 'remove', target_message_id: REACTION_TARGET_WAMID },
    });
  });
});
