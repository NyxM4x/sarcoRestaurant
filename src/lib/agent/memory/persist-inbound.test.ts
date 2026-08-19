import { describe, it, expect, beforeEach } from 'vitest';
import { persistCustomerInbound } from './persist-inbound';
import { parseKapsoProvenance } from '@/lib/kapso/channel/provenance';
import type {
  AgentConversationRef,
  AgentPauseState,
  AgentStore,
  InsertAgentMessageInput,
  InsertMessageResult,
  UpsertConversationInput,
} from '@/lib/agent/core/types';
import type { AgentConversationState } from '@/types';

/**
 * Persistencia del historial entrante del cliente (Fase 6D.2F.2B).
 *
 * El doble hace cumplir lo que hace cumplir 0014, y además LANZA en las tres
 * operaciones de control. Eso convierte en un test verificable la regla de que
 * la pausa no bloquea el historial: si `persistCustomerInbound` consultara o
 * tocara el estado de pausa, estos tests reventarían.
 */

class InboundOnlyStore implements AgentStore {
  conversations: {
    id: string;
    customer_phone: string;
    last_provider_conversation_id: string | null;
    provider_phone_number_id: string | null;
    state: AgentConversationState;
    first_customer_message_at: string | null;
    last_customer_message_at: string | null;
  }[] = [];
  messages: InsertAgentMessageInput[] = [];

  /** Estado inicial que tendrá una conversación creada por este store. */
  initialState: AgentConversationState = 'active';

  private seq = 0;

  async upsertConversation(input: UpsertConversationInput): Promise<AgentConversationRef> {
    let row = this.conversations.find((c) => c.customer_phone === input.customerPhone);
    if (!row) {
      row = {
        id: `conv-${++this.seq}`,
        customer_phone: input.customerPhone,
        last_provider_conversation_id: null,
        provider_phone_number_id: null,
        state: this.initialState,
        first_customer_message_at: null,
        last_customer_message_at: null,
      };
      this.conversations.push(row);
    }
    if (input.providerConversationId !== null) {
      row.last_provider_conversation_id = input.providerConversationId;
    }
    if (input.providerPhoneNumberId !== null) {
      row.provider_phone_number_id = input.providerPhoneNumberId;
    }
    return { id: row.id, state: row.state };
  }

  async insertMessage(input: InsertAgentMessageInput): Promise<InsertMessageResult> {
    // CHECK content_coherence de 0014: 'text' exige contenido real.
    if (input.contentType === 'text' && (input.content === null || input.content.trim() === '')) {
      throw new Error('check violation: content_type=text exige contenido no vacío');
    }
    if (input.content !== null && input.content.trim() === '') {
      throw new Error('check violation: content en blanco disfrazado de contenido');
    }
    if (
      input.providerMessageId !== null &&
      this.messages.some((m) => m.providerMessageId === input.providerMessageId)
    ) {
      return 'duplicate';
    }
    this.messages.push(input);
    return 'inserted';
  }

  async touchCustomerMessageAt(id: string, timestamp: string): Promise<void> {
    const row = this.conversations.find((c) => c.id === id)!;
    // El CHECK customer_first_last_paired: ambos NULL o ambos no NULL.
    if (row.first_customer_message_at === null) {
      row.first_customer_message_at = timestamp;
      row.last_customer_message_at = timestamp;
      return;
    }
    if (timestamp > row.last_customer_message_at!) row.last_customer_message_at = timestamp;
    if (timestamp < row.first_customer_message_at) row.first_customer_message_at = timestamp;
  }

  // ── Operaciones de CONTROL: el historial jamás debe tocarlas ───────────────

  async touchHumanMessageAt(): Promise<void> {
    throw new Error('el historial entrante no debe tocar last_human_message_at');
  }
  async pauseConversation(): Promise<never> {
    throw new Error('el historial entrante no debe pausar');
  }
  async renewPause(): Promise<never> {
    throw new Error('el historial entrante no debe renovar ninguna pausa');
  }
  async resumeConversation(): Promise<never> {
    throw new Error('el historial entrante no debe reanudar');
  }
  async insertControlEvent(): Promise<never> {
    throw new Error('el historial entrante no debe registrar eventos de control');
  }
  async hasResumeEvent(): Promise<never> {
    throw new Error('el historial entrante no debe consultar eventos de control');
  }
  async hasPauseEventForMessage(): Promise<never> {
    throw new Error('el historial entrante no debe consultar eventos de control');
  }
  async findPauseStateByPhone(): Promise<AgentPauseState | null> {
    throw new Error('el historial entrante no debe consultar el estado de pausa');
  }
}

const PHONE_RAW = '+591 700-00001';
const PHONE_DIGITS = '59170000001';

function inbound(message: Record<string, unknown> = {}, phone: string | null = PHONE_RAW) {
  const conversation: Record<string, unknown> = { id: 'kapso-conv-1' };
  if (phone !== null) conversation.phone_number = phone;

  return {
    phone_number_id: 'PNID_ROOT',
    message: {
      id: 'wamid.IN_1',
      type: 'text',
      text: { body: 'quiero pedir' },
      from: phone ?? undefined,
      timestamp: 1_760_000_000,
      kapso: { direction: 'inbound', origin: 'business_app', status: 'received' },
      ...message,
    },
    conversation,
  };
}

async function persist(store: AgentStore, payload: unknown) {
  const provenance = parseKapsoProvenance('whatsapp.message.received', payload);
  if (provenance.kind !== 'customer_inbound') throw new Error(`clasificación inesperada: ${provenance.kind}`);
  return persistCustomerInbound(provenance.message, store, () => '2026-08-13T12:00:00.000Z');
}

let store: InboundOnlyStore;
beforeEach(() => {
  store = new InboundOnlyStore();
});

describe('persist-inbound — forma de la fila', () => {
  it('direction=inbound, role=user, actor=customer y WAMID real', async () => {
    const result = await persist(store, inbound());

    expect(result).toEqual({ result: 'persisted', conversationId: 'conv-1' });
    expect(store.messages[0]).toMatchObject({
      agentConversationId: 'conv-1',
      providerMessageId: 'wamid.IN_1',
      providerConversationId: 'kapso-conv-1',
      direction: 'inbound',
      role: 'user',
      actor: 'customer',
      contentType: 'text',
      content: 'quiero pedir',
    });
  });

  it('identidad durable: el teléfono normalizado, no el conversation.id', async () => {
    await persist(store, inbound());
    const otherConversation = inbound({ id: 'wamid.IN_2' });
    (otherConversation.conversation as Record<string, unknown>).id = 'kapso-conv-2';
    await persist(store, otherConversation);

    expect(store.conversations).toHaveLength(1);
    expect(store.conversations[0].customer_phone).toBe(PHONE_DIGITS);
  });

  it('inicializa first y last a la vez (CHECK customer_first_last_paired)', async () => {
    await persist(store, inbound());

    const iso = new Date(1_760_000_000 * 1000).toISOString();
    expect(store.conversations[0].first_customer_message_at).toBe(iso);
    expect(store.conversations[0].last_customer_message_at).toBe(iso);
  });

  it('mensajes posteriores solo avanzan last (greatest), nunca retroceden', async () => {
    await persist(store, inbound());
    await persist(store, inbound({ id: 'wamid.IN_2', timestamp: 1_760_000_500 }));

    expect(store.conversations[0].first_customer_message_at).toBe(
      new Date(1_760_000_000 * 1000).toISOString(),
    );
    expect(store.conversations[0].last_customer_message_at).toBe(
      new Date(1_760_000_500 * 1000).toISOString(),
    );
  });

  it('el mismo WAMID no se duplica', async () => {
    await persist(store, inbound());
    const again = await persist(store, inbound());

    expect(again).toEqual({ result: 'duplicate', conversationId: 'conv-1' });
    expect(store.messages).toHaveLength(1);
  });

  it('sin teléfono resoluble se rechaza de forma determinista, sin escribir nada', async () => {
    const payload = inbound({ from: undefined }, null);
    const result = await persist(store, payload);

    expect(result).toEqual({ result: 'rejected', reason: 'missing_phone' });
    expect(store.conversations).toHaveLength(0);
    expect(store.messages).toHaveLength(0);
  });

  it('un timestamp ilegible cae a "ahora" decidido en el core', async () => {
    await persist(store, inbound({ timestamp: 'basura' }));

    expect(store.messages[0].messageTimestamp).toBe('2026-08-13T12:00:00.000Z');
  });
});

// ── M: la pausa no bloquea el historial ──────────────────────────────────────

describe('persist-inbound — M: se persiste igual con la conversación pausada', () => {
  it('M · un entrante durante el takeover humano SÍ se guarda', async () => {
    store.initialState = 'paused';

    const result = await persist(store, inbound({ text: { body: 'sigo ahí?' } }));

    expect(result.result).toBe('persisted');
    expect(store.messages).toHaveLength(1);
    expect(store.conversations[0].state).toBe('paused'); // la pausa no se altera
  });

  it('no consulta el estado de pausa en ningún momento', async () => {
    // El store lanza en findPauseStateByPhone / pauseConversation /
    // insertControlEvent: llegar hasta aquí demuestra que no se llamaron.
    store.initialState = 'paused';
    await expect(persist(store, inbound())).resolves.toMatchObject({ result: 'persisted' });
  });
});

// ── §5: tipos de contenido reales, sin marcadores inventados ─────────────────

describe('persist-inbound — contenido por tipo, sin marcadores (§5)', () => {
  it('texto: content real', async () => {
    await persist(store, inbound({ text: { body: 'dos hamburguesas' } }));

    expect(store.messages[0]).toMatchObject({ contentType: 'text', content: 'dos hamburguesas' });
  });

  it('ubicación: content NULL y coordenadas en metadata', async () => {
    await persist(
      store,
      inbound({
        type: 'location',
        text: undefined,
        location: { latitude: -17.7833, longitude: -63.1821, address: 'Av. Banzer', name: 'Casa' },
      }),
    );

    expect(store.messages[0]).toMatchObject({
      contentType: 'location',
      content: null,
      metadata: { latitude: -17.7833, longitude: -63.1821 },
    });
    // metadata es estructural: ni dirección textual ni nombre del lugar.
    expect(Object.keys(store.messages[0].metadata!)).toEqual(['latitude', 'longitude']);
  });

  it('imagen, audio, vídeo y documento: content nullable sin caption', async () => {
    for (const [i, type] of ['image', 'audio', 'video', 'document'].entries()) {
      await persist(store, inbound({ id: `wamid.MEDIA_${i}`, type, text: undefined, [type]: {} }));
    }

    expect(store.messages.map((m) => [m.contentType, m.content])).toEqual([
      ['image', null],
      ['audio', null],
      ['video', null],
      ['document', null],
    ]);
  });

  it('caption o transcripción real: se conserva tal cual', async () => {
    await persist(store, inbound({ type: 'image', text: undefined, image: { caption: 'es esta casa' } }));
    await persist(
      store,
      inbound({ id: 'wamid.IN_2', type: 'audio', text: undefined, audio: { caption: 'quiero dos pollos' } }),
    );

    expect(store.messages[0]).toMatchObject({ contentType: 'image', content: 'es esta casa' });
    expect(store.messages[1]).toMatchObject({ contentType: 'audio', content: 'quiero dos pollos' });
  });

  it('sticker: sin contenido y sin metadata inventada', async () => {
    await persist(store, inbound({ type: 'sticker', text: undefined }));

    expect(store.messages[0]).toMatchObject({ contentType: 'sticker', content: null, metadata: null });
  });

  it('interactivo: body real y tipo estructural en metadata', async () => {
    await persist(
      store,
      inbound({
        type: 'interactive',
        text: undefined,
        interactive: { type: 'nfm_reply', body: { text: 'pedido enviado' } },
      }),
    );

    expect(store.messages[0]).toMatchObject({
      contentType: 'interactive',
      content: 'pedido enviado',
      metadata: { interactive_type: 'nfm_reply' },
    });
  });

  it('tipo desconocido: representable, no descartado', async () => {
    await persist(store, inbound({ type: 'contacts', text: undefined }));

    expect(store.messages).toHaveLength(1);
    expect(store.messages[0].contentType).toBe('unknown');
  });

  it('nunca guarda marcadores internos ni el payload crudo del webhook', async () => {
    await persist(store, inbound({ type: 'location', text: undefined, location: { latitude: 1, longitude: 2 } }));
    await persist(store, inbound({ id: 'wamid.IN_2', type: 'image', text: undefined, image: {} }));
    await persist(store, inbound({ id: 'wamid.IN_3', type: 'sticker', text: undefined }));

    const dump = JSON.stringify(store.messages);
    for (const marker of ['[LOCATION]', '[IMAGE]', '[MEDIA_SENT]', '[PRODUCT_CONTEXT]']) {
      expect(dump).not.toContain(marker);
    }
    // Nada del sobre del webhook: ni kapso, ni conversation, ni phone_number_id.
    expect(dump).not.toContain('PNID_ROOT');
    expect(dump).not.toContain('"kapso"');
    expect(dump).not.toContain('"conversation"');
  });
});
