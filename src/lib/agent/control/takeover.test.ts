import { describe, it, expect, beforeEach } from 'vitest';
import {
  DEFAULT_HUMAN_TAKEOVER_PAUSE_MINUTES,
  handleHumanTakeover,
  humanTakeoverPauseMinutes,
  MAX_HUMAN_TAKEOVER_PAUSE_MINUTES,
  MIN_HUMAN_TAKEOVER_PAUSE_MINUTES,
  pauseExpiryFrom,
} from './takeover';
import { resolveExpiredPause } from './pause-expiry';
import { resumeAgentConversation } from './resume';
import { PAUSE_REASON_HUMAN_BUSINESS_APP } from '@/lib/agent/core/types';
import type {
  AgentConversationRef,
  AgentPauseState,
  AgentStore,
  InsertAgentMessageInput,
  InsertControlEventInput,
  InsertControlEventResult,
  InsertMessageResult,
  PauseConversationInput,
  PauseConversationResult,
  RenewPauseInput,
  RenewPauseResult,
  ResumeConversationInput,
  ResumeConversationResult,
  UpsertConversationInput,
} from '@/lib/agent/core/types';
import { parseKapsoProvenance } from '@/lib/kapso/channel/provenance';
import type { AgentConversationState } from '@/types';

/**
 * Human takeover (Fase 6D.2F.2B).
 *
 * El doble de `AgentStore` no es un mock permisivo: reproduce las garantías que
 * la migración 0014 impone en Postgres, porque son ellas las que hacen seguro el
 * takeover. Un fake que aceptase todo daría tests verdes sobre un sistema roto.
 *
 *   · agent_conversations.customer_phone            UNIQUE
 *   · agent_messages.provider_message_id            UNIQUE parcial (where not null)
 *   · agent_control_events (conv, action, wamid)    UNIQUE parcial (where not null)
 *   · combinaciones direction × role × actor        solo 4 representables
 *   · pausa                                         guardada por state='active'
 *   · CHECK de estado                               paused ⇒ paused_at/reason/source
 *                                                   no nulos y resumed_at nulo
 */

interface FakeConversation {
  id: string;
  customer_phone: string;
  last_provider_conversation_id: string | null;
  provider_phone_number_id: string | null;
  state: AgentConversationState;
  paused_at: string | null;
  pause_expires_at: string | null;
  pause_reason: string | null;
  pause_source: string | null;
  resumed_at: string | null;
  first_customer_message_at: string | null;
  last_customer_message_at: string | null;
  last_human_message_at: string | null;
}

/** Las 4 combinaciones representables de las 16 posibles (0014). */
const REPRESENTABLE = new Set([
  'inbound|user|customer',
  'outbound|assistant|ai',
  'outbound|assistant|human',
  'outbound|assistant|automation',
]);

class FakeAgentStore implements AgentStore {
  conversations: FakeConversation[] = [];
  messages: InsertAgentMessageInput[] = [];
  controlEvents: InsertControlEventInput[] = [];
  calls: string[] = [];

  private seq = 0;

  private byId(id: string): FakeConversation {
    const found = this.conversations.find((c) => c.id === id);
    if (!found) throw new Error(`fk violation: conversation ${id} no existe`);
    return found;
  }

  async upsertConversation(input: UpsertConversationInput): Promise<AgentConversationRef> {
    this.calls.push('upsertConversation');
    let row = this.conversations.find((c) => c.customer_phone === input.customerPhone);
    if (!row) {
      row = {
        id: `conv-${++this.seq}`,
        customer_phone: input.customerPhone,
        last_provider_conversation_id: null,
        provider_phone_number_id: null,
        state: 'active',
        paused_at: null,
        pause_expires_at: null,
        pause_reason: null,
        pause_source: null,
        resumed_at: null,
        first_customer_message_at: null,
        last_customer_message_at: null,
        last_human_message_at: null,
      };
      this.conversations.push(row);
    }
    // Un null no debe borrar la referencia que ya teníamos guardada.
    if (input.providerConversationId !== null) {
      row.last_provider_conversation_id = input.providerConversationId;
    }
    if (input.providerPhoneNumberId !== null) {
      row.provider_phone_number_id = input.providerPhoneNumberId;
    }
    return { id: row.id, state: row.state };
  }

  async insertMessage(input: InsertAgentMessageInput): Promise<InsertMessageResult> {
    this.calls.push('insertMessage');
    this.byId(input.agentConversationId);

    const combo = `${input.direction}|${input.role}|${input.actor}`;
    if (!REPRESENTABLE.has(combo)) {
      throw new Error(`check violation: combinación no representable ${combo}`);
    }
    if (input.direction === 'inbound' && input.content === null && input.contentType === 'text') {
      throw new Error('check violation: text sin contenido');
    }
    // UNIQUE parcial: solo colisiona cuando hay wamid.
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
    this.calls.push('touchCustomerMessageAt');
    const row = this.byId(id);
    if (row.first_customer_message_at === null) {
      row.first_customer_message_at = timestamp;
      row.last_customer_message_at = timestamp;
      return;
    }
    if (timestamp > row.last_customer_message_at!) row.last_customer_message_at = timestamp;
    if (timestamp < row.first_customer_message_at) row.first_customer_message_at = timestamp;
  }

  async touchHumanMessageAt(id: string, timestamp: string): Promise<void> {
    this.calls.push('touchHumanMessageAt');
    const row = this.byId(id);
    if (row.last_human_message_at === null || timestamp > row.last_human_message_at) {
      row.last_human_message_at = timestamp;
    }
  }

  async pauseConversation(input: PauseConversationInput): Promise<PauseConversationResult> {
    this.calls.push('pauseConversation');
    const row = this.byId(input.agentConversationId);
    // UPDATE ... where state='active': una reentrega no reescribe paused_at.
    if (row.state !== 'active') return 'already_paused';
    row.state = 'paused';
    row.paused_at = input.pausedAt;
    row.pause_expires_at = input.pauseExpiresAt;
    row.pause_reason = input.reason;
    row.pause_source = input.source;
    row.resumed_at = null;
    assertStateInvariant(row);
    return 'paused';
  }

  async renewPause(input: RenewPauseInput): Promise<RenewPauseResult> {
    this.calls.push('renewPause');
    const row = this.byId(input.agentConversationId);
    // Los tres guards del UPDATE real: pausada, y del MISMO tipo de pausa.
    if (
      row.state !== 'paused' ||
      row.pause_reason !== input.reason ||
      row.pause_source !== input.source
    ) {
      return 'not_renewable';
    }
    // Cuarto guard, el de monotonía: `pause_expires_at IS NULL OR < nuevo`. La
    // comparación de cadenas ISO en UTC es la misma que hace Postgres sobre
    // timestamptz, porque el formato está ordenado lexicográficamente.
    if (row.pause_expires_at !== null && row.pause_expires_at >= input.pauseExpiresAt) {
      return 'not_extended';
    }
    row.pause_expires_at = input.pauseExpiresAt;
    assertStateInvariant(row);
    return 'renewed';
  }

  async resumeConversation(input: ResumeConversationInput): Promise<ResumeConversationResult> {
    this.calls.push('resumeConversation');
    const row = this.byId(input.agentConversationId);
    // UPDATE ... where state='paused': contraparte del guard de la pausa.
    if (row.state !== 'paused') return 'already_active';
    row.state = 'active';
    row.paused_at = null;
    row.pause_expires_at = null;
    row.pause_reason = null;
    row.pause_source = null;
    row.resumed_at = input.resumedAt;
    assertStateInvariant(row);
    return 'resumed';
  }

  async hasResumeEvent(id: string, resumedAt: string): Promise<boolean> {
    this.calls.push('hasResumeEvent');
    return this.controlEvents.some(
      (e) =>
        e.agentConversationId === id &&
        e.action === 'resume' &&
        (e.metadata as { resumed_at?: string } | null)?.resumed_at === resumedAt,
    );
  }

  async hasPauseEventForMessage(id: string, providerMessageId: string): Promise<boolean> {
    this.calls.push('hasPauseEventForMessage');
    return this.controlEvents.some(
      (e) =>
        e.agentConversationId === id &&
        e.action === 'pause' &&
        e.providerMessageId === providerMessageId,
    );
  }

  async insertControlEvent(input: InsertControlEventInput): Promise<InsertControlEventResult> {
    this.calls.push('insertControlEvent');
    this.byId(input.agentConversationId);
    if (
      input.providerMessageId !== null &&
      this.controlEvents.some(
        (e) =>
          e.agentConversationId === input.agentConversationId &&
          e.action === input.action &&
          e.providerMessageId === input.providerMessageId,
      )
    ) {
      return 'duplicate';
    }
    this.controlEvents.push(input);
    return 'inserted';
  }

  async findPauseStateByPhone(customerPhone: string): Promise<AgentPauseState | null> {
    this.calls.push('findPauseStateByPhone');
    const row = this.conversations.find((c) => c.customer_phone === customerPhone);
    if (!row) return null;
    return {
      conversationId: row.id,
      state: row.state,
      pausedAt: row.paused_at,
      pauseExpiresAt: row.pause_expires_at,
      pauseReason: row.pause_reason,
      pauseSource: row.pause_source,
      resumedAt: row.resumed_at,
    };
  }
}

/** CHECK de coherencia del estado de control (0014). */
function assertStateInvariant(row: FakeConversation): void {
  if (row.state === 'paused') {
    if (row.paused_at === null || row.pause_reason === null || row.pause_source === null) {
      throw new Error('check violation: paused exige paused_at, pause_reason y pause_source');
    }
    if (row.resumed_at !== null) {
      throw new Error('check violation: paused no admite resumed_at');
    }
  }
  if (row.state === 'active') {
    const dirty =
      row.paused_at !== null ||
      row.pause_expires_at !== null ||
      row.pause_reason !== null ||
      row.pause_source !== null;
    if (dirty) throw new Error('check violation: active exige los campos de pausa a NULL');
  }
}

// ── Payloads del proveedor ───────────────────────────────────────────────────

const WAMID = 'wamid.HBgMNTkxNzAwMDAwMDAxFQIAERgS';
const PHONE_RAW = '+591 700-00001';
const PHONE_DIGITS = '59170000001';

function sentPayload(
  overrides: {
    origin?: string | null;
    direction?: string | null;
    wamid?: string | null;
    phone?: string | null;
    rootPhoneNumberId?: string | null;
    conversationPhoneNumberId?: string | null;
    text?: string;
    /** Epoch en SEGUNDOS, como lo manda el proveedor. */
    timestamp?: number;
  } = {},
): Record<string, unknown> {
  const kapso: Record<string, unknown> = {
    direction: overrides.direction === undefined ? 'outbound' : overrides.direction,
    origin: overrides.origin === undefined ? 'business_app' : overrides.origin,
    status: 'sent',
  };
  const message: Record<string, unknown> = {
    type: 'text',
    text: { body: overrides.text ?? 'Ya te lo mando, jefe' },
    to: overrides.phone === undefined ? PHONE_RAW : overrides.phone,
    from: '59177777777', // número del NEGOCIO: nunca es la identidad del cliente
    timestamp: overrides.timestamp ?? 1_760_000_000,
    kapso,
  };
  if (overrides.wamid !== null) message.id = overrides.wamid ?? WAMID;

  const conversation: Record<string, unknown> = {
    id: 'kapso-conv-1',
    phone_number: overrides.phone === undefined ? PHONE_RAW : overrides.phone,
  };
  if (overrides.conversationPhoneNumberId !== undefined) {
    conversation.phone_number_id = overrides.conversationPhoneNumberId;
  }

  const root: Record<string, unknown> = { message, conversation };
  if (overrides.rootPhoneNumberId !== undefined) {
    root.phone_number_id = overrides.rootPhoneNumberId;
  }
  return root;
}

function receivedPayload(): Record<string, unknown> {
  return {
    message: {
      id: 'wamid.INBOUND',
      type: 'text',
      text: { body: 'hola' },
      from: PHONE_RAW,
      timestamp: 1_760_000_100,
      kapso: { direction: 'inbound', origin: 'business_app', status: 'received' },
    },
    conversation: { id: 'kapso-conv-1', phone_number: PHONE_RAW },
  };
}

/**
 * Enrutado equivalente al del webhook: SOLO `human_outbound` llega al takeover.
 * Devuelve la clasificación para poder afirmar también qué NO se ejecutó.
 */
async function route(
  eventName: string,
  payload: unknown,
  store: AgentStore,
  pauseMinutes?: number,
): Promise<{ kind: string; takeover: Awaited<ReturnType<typeof handleHumanTakeover>> | null }> {
  const provenance = parseKapsoProvenance(eventName, payload);
  if (provenance.kind === 'human_outbound') {
    return {
      kind: provenance.kind,
      takeover: await handleHumanTakeover(provenance.message, store, undefined, pauseMinutes),
    };
  }
  return { kind: provenance.kind, takeover: null };
}

let store: FakeAgentStore;
beforeEach(() => {
  store = new FakeAgentStore();
});

// ── A–E, N: qué dispara el takeover y qué no ─────────────────────────────────

describe('takeover — disparo (A/B/C/D/E/N)', () => {
  it('A · sent + outbound + business_app => takeover completo', async () => {
    const { kind, takeover } = await route('whatsapp.message.sent', sentPayload(), store);

    expect(kind).toBe('human_outbound');
    expect(takeover).toEqual({
      result: 'ok',
      conversationId: 'conv-1',
      message: 'inserted',
      pause: 'paused',
      controlEvent: 'inserted',
    });
    expect(store.messages).toHaveLength(1);
    expect(store.controlEvents).toHaveLength(1);
    expect(store.conversations[0].state).toBe('paused');
  });

  it('B/N · sent + cloud_api => ni pausa ni mensaje humano', async () => {
    const { kind, takeover } = await route(
      'whatsapp.message.sent',
      sentPayload({ origin: 'cloud_api' }),
      store,
    );

    expect(kind).toBe('system_outbound');
    expect(takeover).toBeNull();
    expect(store.conversations).toHaveLength(0);
    expect(store.messages).toHaveLength(0);
    expect(store.controlEvents).toHaveLength(0);
    expect(store.calls).toEqual([]);
  });

  it('C · delivered + business_app => lifecycle, no toca nada', async () => {
    const { kind } = await route(
      'whatsapp.message.delivered',
      sentPayload({ origin: 'business_app' }),
      store,
    );

    expect(kind).toBe('lifecycle');
    expect(store.calls).toEqual([]);
  });

  it('D · read + business_app => lifecycle, no toca nada', async () => {
    const { kind } = await route(
      'whatsapp.message.read',
      sentPayload({ origin: 'business_app' }),
      store,
    );

    expect(kind).toBe('lifecycle');
    expect(store.calls).toEqual([]);
  });

  it('E · received (entrante del cliente) nunca es takeover', async () => {
    const { kind, takeover } = await route(
      'whatsapp.message.received',
      receivedPayload(),
      store,
    );

    expect(kind).toBe('customer_inbound');
    expect(takeover).toBeNull();
    expect(store.controlEvents).toHaveLength(0);
  });

  it('N · un envío nuestro no pausa aunque el cliente ya tuviera conversación', async () => {
    // Primero un takeover humano real, luego un envío cloud_api posterior.
    await route('whatsapp.message.sent', sentPayload(), store);
    const before = { ...store.conversations[0] };

    await route(
      'whatsapp.message.sent',
      sentPayload({ origin: 'cloud_api', wamid: 'wamid.CLOUD' }),
      store,
    );

    expect(store.messages).toHaveLength(1);
    expect(store.messages[0].actor).toBe('human');
    expect(store.conversations[0]).toEqual(before);
  });
});

// ── F/G/H: identidad y referencias del proveedor ─────────────────────────────

describe('takeover — identidad y referencias (F/G/H)', () => {
  it('F · prefiere el phone_number_id de la raíz del payload', async () => {
    await route(
      'whatsapp.message.sent',
      sentPayload({ rootPhoneNumberId: 'pnid-root', conversationPhoneNumberId: 'pnid-conv' }),
      store,
    );

    expect(store.conversations[0].provider_phone_number_id).toBe('pnid-root');
  });

  it('G · cae a conversation.phone_number_id cuando falta en la raíz', async () => {
    await route(
      'whatsapp.message.sent',
      sentPayload({ conversationPhoneNumberId: 'pnid-conv' }),
      store,
    );

    expect(store.conversations[0].provider_phone_number_id).toBe('pnid-conv');
  });

  it('H · el teléfono se guarda normalizado a solo dígitos', async () => {
    await route('whatsapp.message.sent', sentPayload(), store);

    expect(store.conversations[0].customer_phone).toBe(PHONE_DIGITS);
    // Y jamás el número del negocio (message.from) en un saliente.
    expect(store.conversations[0].customer_phone).not.toBe('59177777777');
  });

  it('conversation.id se guarda como referencia técnica, no como identidad', async () => {
    await route('whatsapp.message.sent', sentPayload(), store);

    expect(store.conversations[0].last_provider_conversation_id).toBe('kapso-conv-1');
    // La identidad sigue siendo el teléfono: un conversation.id nuevo no crea otra fila.
    const payload = sentPayload({ wamid: 'wamid.SEGUNDO' });
    (payload.conversation as Record<string, unknown>).id = 'kapso-conv-2';
    await route('whatsapp.message.sent', payload, store);

    expect(store.conversations).toHaveLength(1);
    expect(store.conversations[0].last_provider_conversation_id).toBe('kapso-conv-2');
  });

  it('un evento sin conversation.id no borra la referencia guardada', async () => {
    await route('whatsapp.message.sent', sentPayload(), store);
    const payload = sentPayload({ wamid: 'wamid.SEGUNDO' });
    delete (payload.conversation as Record<string, unknown>).id;
    await route('whatsapp.message.sent', payload, store);

    expect(store.conversations[0].last_provider_conversation_id).toBe('kapso-conv-1');
  });
});

// ── I: forma exacta del mensaje humano ───────────────────────────────────────

describe('takeover — persistencia del mensaje humano (I)', () => {
  it('I · direction=outbound, role=assistant, actor=human y WAMID real', async () => {
    await route('whatsapp.message.sent', sentPayload({ text: 'ya sale tu pedido' }), store);

    expect(store.messages[0]).toMatchObject({
      agentConversationId: 'conv-1',
      providerMessageId: WAMID,
      providerConversationId: 'kapso-conv-1',
      direction: 'outbound',
      role: 'assistant',
      actor: 'human',
      content: 'ya sale tu pedido',
      contentType: 'text',
    });
  });

  it('avanza last_human_message_at con el instante del proveedor', async () => {
    await route('whatsapp.message.sent', sentPayload(), store);

    const expected = new Date(1_760_000_000 * 1000).toISOString();
    expect(store.conversations[0].last_human_message_at).toBe(expected);
    expect(store.conversations[0].paused_at).toBe(expected);
  });

  it('un timestamp ilegible cae a "ahora" decidido en el core, no en la base', async () => {
    const payload = sentPayload();
    (payload.message as Record<string, unknown>).timestamp = 'no-es-una-fecha';
    const provenance = parseKapsoProvenance('whatsapp.message.sent', payload);
    if (provenance.kind !== 'human_outbound') throw new Error('clasificación inesperada');

    await handleHumanTakeover(provenance.message, store, () => '2026-08-13T12:00:00.000Z');

    expect(store.messages[0].messageTimestamp).toBe('2026-08-13T12:00:00.000Z');
  });

  it('no persiste ni pausa sin teléfono resoluble', async () => {
    const { takeover } = await route(
      'whatsapp.message.sent',
      sentPayload({ phone: null }),
      store,
    );

    expect(takeover).toEqual({ result: 'rejected', reason: 'missing_phone' });
    expect(store.calls).toEqual([]);
  });

  it('no persiste ni pausa sin WAMID (sin él no hay idempotencia)', async () => {
    const { takeover } = await route(
      'whatsapp.message.sent',
      sentPayload({ wamid: null }),
      store,
    );

    expect(takeover).toEqual({ result: 'rejected', reason: 'missing_message_id' });
    expect(store.calls).toEqual([]);
  });
});

// ── J: idempotencia semántica por WAMID ──────────────────────────────────────

describe('takeover — idempotencia por WAMID (J)', () => {
  it('J · el mismo WAMID dos veces: un mensaje, un evento de control, sin error', async () => {
    const first = await route('whatsapp.message.sent', sentPayload(), store);
    const second = await route('whatsapp.message.sent', sentPayload(), store);

    expect(first.takeover).toMatchObject({
      message: 'inserted',
      pause: 'paused',
      controlEvent: 'inserted',
    });
    // `already_applied`, no `already_paused`: la segunda entrega ni siquiera
    // intentó escribir. Ver la barrera de ejecución única del hardening.
    expect(second.takeover).toMatchObject({
      result: 'ok',
      message: 'duplicate',
      pause: 'already_applied',
      controlEvent: 'duplicate',
    });
    expect(store.messages).toHaveLength(1);
    expect(store.controlEvents).toHaveLength(1);
    expect(store.conversations).toHaveLength(1);
  });

  it('J · deduplica por WAMID aunque el evento del proveedor sea otro', async () => {
    // Dos entregas distintas a nivel de transporte (otro conversation.id, otro
    // instante) que describen el MISMO mensaje humano. `webhook_events` no las
    // vería como duplicadas; la barrera semántica es el WAMID.
    await route('whatsapp.message.sent', sentPayload(), store);

    const redelivered = sentPayload();
    (redelivered.conversation as Record<string, unknown>).id = 'kapso-conv-otra';
    (redelivered.message as Record<string, unknown>).timestamp = 1_760_000_999;
    await route('whatsapp.message.sent', redelivered, store);

    expect(store.messages).toHaveLength(1);
    expect(store.controlEvents).toHaveLength(1);
  });

  it('una reentrega no reescribe paused_at (no falsea el momento del takeover)', async () => {
    await route('whatsapp.message.sent', sentPayload(), store);
    const pausedAt = store.conversations[0].paused_at;

    const later = sentPayload();
    (later.message as Record<string, unknown>).timestamp = 1_770_000_000;
    await route('whatsapp.message.sent', later, store);

    expect(store.conversations[0].paused_at).toBe(pausedAt);
  });

  it('si una ejecución previa murió tras insertar el mensaje, el reintento sí pausa', async () => {
    // Estado dejado por un crash: mensaje persistido, conversación aún activa.
    const conversation = await store.upsertConversation({
      customerPhone: PHONE_DIGITS,
      providerConversationId: 'kapso-conv-1',
      providerPhoneNumberId: null,
    });
    await store.insertMessage({
      agentConversationId: conversation.id,
      providerMessageId: WAMID,
      providerConversationId: 'kapso-conv-1',
      direction: 'outbound',
      role: 'assistant',
      actor: 'human',
      content: 'Ya te lo mando, jefe',
      contentType: 'text',
      metadata: null,
      messageTimestamp: '2026-08-13T10:00:00.000Z',
    });

    const { takeover } = await route('whatsapp.message.sent', sentPayload(), store);

    // El duplicado NO corta la secuencia: la pausa pendiente se completa.
    expect(takeover).toMatchObject({ message: 'duplicate', pause: 'paused', controlEvent: 'inserted' });
    expect(store.conversations[0].state).toBe('paused');
  });
});

// ── K/L: forma exacta de la pausa ────────────────────────────────────────────

describe('takeover — forma de la pausa (K/L)', () => {
  it('K · state pasa a paused', async () => {
    await route('whatsapp.message.sent', sentPayload(), store);

    expect(store.conversations[0].state).toBe('paused');
  });

  it('L · paused_at set, expires_at con plazo, reason/source canónicos, resumed_at NULL', async () => {
    // Desde 5C.1 la pausa es TEMPORAL: `pause_expires_at` deja de ser NULL.
    // Una conversación que nadie reanuda ya no se queda muerta para siempre.
    await route('whatsapp.message.sent', sentPayload(), store);

    expect(store.conversations[0]).toMatchObject({
      state: 'paused',
      paused_at: '2025-10-09T08:53:20.000Z',
      pause_expires_at: '2025-10-09T09:23:20.000Z', // +30 min por defecto
      pause_reason: PAUSE_REASON_HUMAN_BUSINESS_APP,
      pause_source: 'business_app',
      resumed_at: null,
    });
    expect(PAUSE_REASON_HUMAN_BUSINESS_APP).toBe('human_whatsapp_business_app');
  });

  it('el evento de control queda registrado con acción, fuente y WAMID', async () => {
    await route('whatsapp.message.sent', sentPayload({ text: 'texto privado del negocio' }), store);

    expect(store.controlEvents[0]).toEqual({
      agentConversationId: 'conv-1',
      action: 'pause',
      source: 'business_app',
      reason: PAUSE_REASON_HUMAN_BUSINESS_APP,
      providerMessageId: WAMID,
      // El historial dice hasta cuándo iba a durar ESTA intervención, no solo
      // que ocurrió: sin eso no se puede reconstruir por qué el agente calló.
      expiresAt: '2025-10-09T09:23:20.000Z',
      metadata: { trigger: 'whatsapp.message.sent' },
    });
    // El evento de control no arrastra el contenido del mensaje.
    expect(JSON.stringify(store.controlEvents[0])).not.toContain('texto privado');
  });
});

// ── §15 / §4: no depender de delivered ni read ───────────────────────────────

describe('takeover — no depende de delivered/read (§4/§15)', () => {
  it('business_app sent pausa INMEDIATAMENTE, sin esperar ningún lifecycle', async () => {
    await route('whatsapp.message.sent', sentPayload(), store);

    // Con un solo evento ya está pausada. En Coexistence delivered/read pueden
    // no llegar nunca; esperarlos dejaría a la IA hablando sobre una persona.
    expect(store.conversations[0].state).toBe('paused');
    expect(store.controlEvents).toHaveLength(1);
  });

  it('delivered y read del MISMO WAMID no crean otro mensaje ni otra pausa', async () => {
    await route('whatsapp.message.sent', sentPayload(), store);
    const snapshot = { ...store.conversations[0] };

    await route('whatsapp.message.delivered', sentPayload(), store);
    await route('whatsapp.message.read', sentPayload(), store);
    await route('whatsapp.message.failed', sentPayload(), store);

    expect(store.messages).toHaveLength(1);
    expect(store.controlEvents).toHaveLength(1);
    expect(store.conversations[0]).toEqual(snapshot);
  });

  it('un lifecycle sin sent previo tampoco pausa nada por su cuenta', async () => {
    await route('whatsapp.message.delivered', sentPayload(), store);

    expect(store.conversations).toHaveLength(0);
  });
});

// ── Convergencia ante fallos parciales (microfase 6D.2F.2B.1) ────────────────

/**
 * Envuelve el store y hace fallar UNA vez el paso indicado. Reproduce lo que
 * pasa de verdad cuando Supabase se cae a mitad de la secuencia: la ejecución
 * muere, el webhook marca el evento `failed` y Kapso reentrega.
 */
function failOnce(store: FakeAgentStore, step: keyof AgentStore): AgentStore {
  let pending = 1;
  const guard = <T>(name: keyof AgentStore, run: () => Promise<T>): Promise<T> => {
    if (name === step && pending > 0) {
      pending -= 1;
      return Promise.reject(new Error(`fallo simulado en ${String(step)}`));
    }
    return run();
  };

  return {
    upsertConversation: (i) => guard('upsertConversation', () => store.upsertConversation(i)),
    insertMessage: (i) => guard('insertMessage', () => store.insertMessage(i)),
    touchCustomerMessageAt: (id, ts) =>
      guard('touchCustomerMessageAt', () => store.touchCustomerMessageAt(id, ts)),
    touchHumanMessageAt: (id, ts) =>
      guard('touchHumanMessageAt', () => store.touchHumanMessageAt(id, ts)),
    pauseConversation: (i) => guard('pauseConversation', () => store.pauseConversation(i)),
    renewPause: (i) => guard('renewPause', () => store.renewPause(i)),
    resumeConversation: (i) => guard('resumeConversation', () => store.resumeConversation(i)),
    insertControlEvent: (i) => guard('insertControlEvent', () => store.insertControlEvent(i)),
    hasResumeEvent: (id, ts) => guard('hasResumeEvent', () => store.hasResumeEvent(id, ts)),
    hasPauseEventForMessage: (id, wamid) =>
      guard('hasPauseEventForMessage', () => store.hasPauseEventForMessage(id, wamid)),
    findPauseStateByPhone: (p) => guard('findPauseStateByPhone', () => store.findPauseStateByPhone(p)),
  };
}

describe('takeover — convergencia ante fallos parciales', () => {
  it('CASO A · falla la pausa: el reintento pausa sin duplicar el mensaje', async () => {
    const flaky = failOnce(store, 'pauseConversation');

    await expect(route('whatsapp.message.sent', sentPayload(), flaky)).rejects.toThrow(
      /pauseConversation/,
    );
    // Estado intermedio real: el mensaje humano ya está, la pausa no.
    expect(store.messages).toHaveLength(1);
    expect(store.conversations[0].state).toBe('active');
    expect(store.controlEvents).toHaveLength(0);

    const { takeover } = await route('whatsapp.message.sent', sentPayload(), flaky);

    expect(takeover).toMatchObject({
      result: 'ok',
      message: 'duplicate', // no se reinserta
      pause: 'paused', // ahora sí
      controlEvent: 'inserted', // exactamente uno
    });
    expect(store.messages).toHaveLength(1);
    expect(store.controlEvents).toHaveLength(1);
    expect(store.conversations[0].state).toBe('paused');
  });

  it('CASO B · falla el evento de control: el reintento lo repara y conserva la pausa', async () => {
    const flaky = failOnce(store, 'insertControlEvent');

    await expect(route('whatsapp.message.sent', sentPayload(), flaky)).rejects.toThrow(
      /insertControlEvent/,
    );
    // Estado intermedio: mensaje y pausa sí, historial de control no.
    expect(store.messages).toHaveLength(1);
    expect(store.conversations[0].state).toBe('paused');
    expect(store.controlEvents).toHaveLength(0);
    const pausedAt = store.conversations[0].paused_at;

    // El reintento llega con un instante POSTERIOR (Kapso reentrega más tarde):
    // aun así `paused_at` no debe moverse.
    const later = sentPayload();
    (later.message as Record<string, unknown>).timestamp = 1_770_000_000;
    const { takeover } = await route('whatsapp.message.sent', later, flaky);

    expect(takeover).toMatchObject({
      result: 'ok',
      message: 'duplicate',
      pause: 'already_paused', // no se reabre ni se pierde
      controlEvent: 'inserted', // la escritura que faltaba
    });
    expect(store.conversations[0].paused_at).toBe(pausedAt);
    expect(store.conversations[0].state).toBe('paused');
    expect(store.messages).toHaveLength(1);
    expect(store.controlEvents).toHaveLength(1);
  });

  it('CASO C · reejecución completa tras converger: ningún efecto nuevo', async () => {
    await route('whatsapp.message.sent', sentPayload(), store);
    const snapshot = { ...store.conversations[0] };
    const antes = store.calls.length;

    const { takeover } = await route('whatsapp.message.sent', sentPayload(), store);

    expect(takeover).toMatchObject({
      result: 'ok',
      message: 'duplicate',
      pause: 'already_applied',
      controlEvent: 'duplicate',
    });
    expect(store.messages).toHaveLength(1);
    expect(store.controlEvents).toHaveLength(1);
    expect(store.conversations[0]).toEqual(snapshot);
    // Ni una escritura: la barrera corta antes de `insertMessage`.
    expect(store.calls.slice(antes)).toEqual(['upsertConversation', 'hasPauseEventForMessage']);
  });

  it('§3 · con la conversación YA pausada se sigue reparando el evento que falta', async () => {
    // Escenario exacto que se quiere descartar: una implementación que hiciera
    // `if (alreadyPaused) return` abandonaría la secuencia y dejaría el
    // historial de control incompleto para siempre.
    const conversation = await store.upsertConversation({
      customerPhone: PHONE_DIGITS,
      providerConversationId: 'kapso-conv-1',
      providerPhoneNumberId: null,
    });
    await store.pauseConversation({
      agentConversationId: conversation.id,
      pausedAt: '2026-08-13T09:00:00.000Z',
      pauseExpiresAt: '2026-08-13T09:30:00.000Z',
      reason: PAUSE_REASON_HUMAN_BUSINESS_APP,
      source: 'business_app',
    });
    expect(store.controlEvents).toHaveLength(0);

    const { takeover } = await route('whatsapp.message.sent', sentPayload(), store);

    expect(takeover).toMatchObject({ pause: 'already_paused', controlEvent: 'inserted' });
    expect(store.controlEvents).toHaveLength(1);
    // La pausa preexistente se respeta: no se reabre con el instante nuevo.
    expect(store.conversations[0].paused_at).toBe('2026-08-13T09:00:00.000Z');
  });

  it('la idempotencia es por PASO, no por abandono: cada fallo se repara solo', async () => {
    // Se recorre la secuencia entera fallando en cada paso, uno por ejecución.
    for (const step of ['insertMessage', 'touchHumanMessageAt', 'pauseConversation', 'insertControlEvent'] as const) {
      const fresh = new FakeAgentStore();
      const flaky = failOnce(fresh, step);

      await expect(route('whatsapp.message.sent', sentPayload(), flaky)).rejects.toThrow();
      const { takeover } = await route('whatsapp.message.sent', sentPayload(), flaky);

      expect(takeover, `paso ${step}`).toMatchObject({ result: 'ok' });
      expect(fresh.messages, `paso ${step}`).toHaveLength(1);
      expect(fresh.controlEvents, `paso ${step}`).toHaveLength(1);
      expect(fresh.conversations[0].state, `paso ${step}`).toBe('paused');
    }
  });

  it('si falla el upsert inicial no queda ningún rastro a medias', async () => {
    const flaky = failOnce(store, 'upsertConversation');

    await expect(route('whatsapp.message.sent', sentPayload(), flaky)).rejects.toThrow();
    expect(store.conversations).toHaveLength(0);
    expect(store.messages).toHaveLength(0);

    const { takeover } = await route('whatsapp.message.sent', sentPayload(), flaky);
    expect(takeover).toMatchObject({ message: 'inserted', pause: 'paused', controlEvent: 'inserted' });
  });

  it('un mensaje humano NUEVO sobre una pausa vigente sí registra su propio evento', async () => {
    // Semántica congelada: la deduplicación es por WAMID, así que dos mensajes
    // humanos distintos dejan dos entradas en el historial de control aunque la
    // conversación ya estuviera pausada. Es un registro fiel de la intervención,
    // no una segunda pausa: `paused_at` no se toca.
    await route('whatsapp.message.sent', sentPayload(), store);
    const pausedAt = store.conversations[0].paused_at;

    await route('whatsapp.message.sent', sentPayload({ wamid: 'wamid.HUMANO_2' }), store);

    expect(store.messages).toHaveLength(2);
    expect(store.controlEvents).toHaveLength(2);
    expect(store.conversations[0].paused_at).toBe(pausedAt);
  });
});

// ── 6D.2F.5C.1: la pausa es TEMPORAL y RENOVABLE ────────────────────────────

/**
 * El cambio de producto: un takeover ya no deja la conversación muerta hasta que
 * alguien se acuerde de reanudarla.
 *
 * El reloj cuenta desde la ÚLTIMA intervención humana, no desde la primera —
 * mientras alguien atienda, la pausa no se agota. Y la renovación distingue una
 * intervención nueva de una reentrega del mismo mensaje, que es lo que impide
 * que tres entregas de Kapso alarguen la pausa a hora y media.
 */

/** 2025-10-09T08:53:20Z, el instante del payload por defecto. */
const T0 = 1_760_000_000;
const MINUTO = 60;

describe('takeover — pausa temporal (6D.2F.5C.1)', () => {
  it('1 · el primer mensaje humano fija el vencimiento a los 30 minutos', async () => {
    await route('whatsapp.message.sent', sentPayload(), store);

    const conv = store.conversations[0];
    expect(conv.paused_at).toBe('2025-10-09T08:53:20.000Z');
    expect(conv.pause_expires_at).toBe('2025-10-09T09:23:20.000Z');
    // El CHECK `pause_expires_at > paused_at` de 0014, comprobado de verdad.
    expect(Date.parse(conv.pause_expires_at!)).toBeGreaterThan(Date.parse(conv.paused_at!));
  });

  it('2 · un mensaje humano NUEVO diez minutos después mueve el vencimiento', async () => {
    await route('whatsapp.message.sent', sentPayload(), store);
    await route(
      'whatsapp.message.sent',
      sentPayload({ wamid: 'wamid.SEGUNDO', timestamp: T0 + 10 * MINUTO }),
      store,
    );

    const conv = store.conversations[0];
    // El plazo cuenta desde el SEGUNDO mensaje: 09:03:20 + 30m.
    expect(conv.pause_expires_at).toBe('2025-10-09T09:33:20.000Z');
    // Pero `paused_at` NO se mueve: marca cuándo empezó el takeover, y moverlo
    // borraría el dato de cuánto lleva la persona atendiendo.
    expect(conv.paused_at).toBe('2025-10-09T08:53:20.000Z');
  });

  it('2 · el reloj se renueva desde la ÚLTIMA intervención, no desde la primera', async () => {
    // Tres intervenciones espaciadas: el vencimiento persigue a la última.
    for (const [i, offset] of [0, 10, 25].entries()) {
      await route(
        'whatsapp.message.sent',
        sentPayload({ wamid: `wamid.H${i}`, timestamp: T0 + offset * MINUTO }),
        store,
      );
    }

    // Última a las 09:18:20 → vence a las 09:48:20.
    expect(store.conversations[0].pause_expires_at).toBe('2025-10-09T09:48:20.000Z');
  });

  it('3 · la reentrega del MISMO wamid no renueva nada', async () => {
    await route('whatsapp.message.sent', sentPayload(), store);
    const trasPrimero = store.conversations[0].pause_expires_at;

    // Misma entrega otra vez, y otra. Kapso reentrega hasta cuatro veces.
    await route('whatsapp.message.sent', sentPayload(), store);
    await route('whatsapp.message.sent', sentPayload(), store);

    expect(store.conversations[0].pause_expires_at).toBe(trasPrimero);
    // Ni mensaje duplicado, ni evento de control duplicado.
    expect(store.messages).toHaveLength(1);
    expect(store.controlEvents).toHaveLength(1);
    // Y `renewPause` ni se llegó a llamar: la decisión la da el resultado de la
    // inserción, no una comprobación aparte que pudiera desincronizarse.
    expect(store.calls.filter((c) => c === 'renewPause')).toEqual([]);
  });

  it('3 · una reentrega TARDÍA tampoco alarga la pausa', async () => {
    // El caso que más engaña: la reentrega llega media hora después, pero es el
    // MISMO mensaje. Si renovase, un fallo de red le regalaría media hora extra.
    await route('whatsapp.message.sent', sentPayload(), store);
    const trasPrimero = store.conversations[0].pause_expires_at;

    await route('whatsapp.message.sent', sentPayload({ timestamp: T0 + 29 * MINUTO }), store);

    expect(store.conversations[0].pause_expires_at).toBe(trasPrimero);
  });

  it('la reentrega SÍ completa una pausa que la ejecución anterior no aplicó', async () => {
    // Idempotencia por PASO, no por mensaje: si la primera ejecución murió tras
    // insertar el mensaje, el reintento tiene que poder pausar.
    const conversation = await store.upsertConversation({
      customerPhone: PHONE_DIGITS,
      providerConversationId: null,
      providerPhoneNumberId: null,
    });
    await store.insertMessage({
      agentConversationId: conversation.id,
      providerMessageId: WAMID,
      providerConversationId: null,
      direction: 'outbound',
      role: 'assistant',
      actor: 'human',
      content: 'Ya te lo mando, jefe',
      contentType: 'text',
      metadata: null,
      messageTimestamp: '2025-10-09T08:53:20.000Z',
    });

    const { takeover } = await route('whatsapp.message.sent', sentPayload(), store);

    expect(takeover).toMatchObject({ message: 'duplicate', pause: 'paused' });
    // Y la pausa que se aplica trae su plazo, no queda indefinida.
    expect(store.conversations[0].pause_expires_at).toBe('2025-10-09T09:23:20.000Z');
  });

  it('6 · renovar NO borra el historial: un evento por intervención real', async () => {
    await route('whatsapp.message.sent', sentPayload(), store);
    await route(
      'whatsapp.message.sent',
      sentPayload({ wamid: 'wamid.SEGUNDO', timestamp: T0 + 10 * MINUTO }),
      store,
    );

    // Append-only: dos intervenciones, dos eventos de pausa, cada uno con SU
    // vencimiento. Nada se actualiza ni se borra — 0014 ni siquiera concede
    // UPDATE sobre esa tabla.
    expect(store.controlEvents).toHaveLength(2);
    expect(store.controlEvents.map((e) => e.expiresAt)).toEqual([
      '2025-10-09T09:23:20.000Z',
      '2025-10-09T09:33:20.000Z',
    ]);
    expect(store.controlEvents.every((e) => e.action === 'pause')).toBe(true);
  });

  it('9 · el plazo es configurable: con 60 minutos, vence a los 60', async () => {
    await route('whatsapp.message.sent', sentPayload(), store, 60);

    expect(store.conversations[0].pause_expires_at).toBe('2025-10-09T09:53:20.000Z');
  });

  it('7 · una pausa INDEFINIDA de otro origen no se convierte en temporal', async () => {
    // El escenario que justifica los guards de `renewPause`: un "IA OFF"
    // explícito no puede quedar reducido a treinta minutos porque alguien
    // escriba desde la app. Si el panel dijo que no, es que no.
    const conversation = await store.upsertConversation({
      customerPhone: PHONE_DIGITS,
      providerConversationId: null,
      providerPhoneNumberId: null,
    });
    await store.pauseConversation({
      agentConversationId: conversation.id,
      pausedAt: '2025-10-09T08:00:00.000Z',
      pauseExpiresAt: null, // indefinida
      reason: 'manual_dashboard_off',
      source: 'dashboard',
    });

    await route('whatsapp.message.sent', sentPayload(), store);

    const conv = store.conversations[0];
    expect(conv.pause_expires_at).toBeNull(); // sigue sin vencimiento
    expect(conv.pause_source).toBe('dashboard'); // y sigue siendo del panel
    expect(conv.paused_at).toBe('2025-10-09T08:00:00.000Z');
  });

  it('el mensaje humano se registra igual aunque la pausa fuerte no se toque', async () => {
    // Que no se renueve el plazo no significa ignorar la intervención: el
    // mensaje y su evento son reales y quedan.
    const conversation = await store.upsertConversation({
      customerPhone: PHONE_DIGITS,
      providerConversationId: null,
      providerPhoneNumberId: null,
    });
    await store.pauseConversation({
      agentConversationId: conversation.id,
      pausedAt: '2025-10-09T08:00:00.000Z',
      pauseExpiresAt: null,
      reason: 'manual_dashboard_off',
      source: 'dashboard',
    });

    await route('whatsapp.message.sent', sentPayload(), store);

    expect(store.messages.filter((m) => m.actor === 'human')).toHaveLength(1);
    expect(store.controlEvents).toHaveLength(1);
  });
});

// ── 5C.1 hardening: un WAMID humano produce UN takeover, y solo uno ─────────

/**
 * El agujero que cierran estos tests era real, y no lo tapaba `webhook_events`.
 *
 * Esa capa deduplica por CLAVE DE IDEMPOTENCIA. Kapso puede reentregar el mismo
 * mensaje con otra clave —el propio CASO D de la suite del webhook lo da por
 * supuesto—, y entonces el evento se procesa de verdad y llega al takeover. Si
 * para ese momento la pausa había vencido o alguien la había levantado, la
 * conversación estaba `active`, el guard de `pauseConversation` dejaba pasar y
 * la volvía a pausar: un reintento de red deshaciendo una decisión humana.
 *
 * La barrera es el EVENTO DE CONTROL de ese wamid, que se escribe el último y
 * por tanto prueba que todo lo anterior ocurrió. Sin columnas nuevas y sin
 * heurísticas de tiempo.
 */

describe('takeover — un WAMID no puede pausar dos veces', () => {
  /** Deja la conversación pausada por WAMID-A, como una intervención real. */
  async function takeoverInicial(): Promise<void> {
    await route('whatsapp.message.sent', sentPayload(), store);
    expect(store.conversations[0].state).toBe('paused');
  }

  it('§3 · tras VENCER y reanudarse, la reentrega del mismo wamid no re-pausa', async () => {
    await takeoverInicial();

    // Pasa el plazo y llega un mensaje del cliente: la expiración perezosa
    // devuelve el control. Es el mismo camino que corre en producción.
    const despues = () => '2025-10-09T10:00:00.000Z';
    expect(await resolveExpiredPause(PHONE_DIGITS, store, despues)).toBe('resumed');
    expect(store.conversations[0].state).toBe('active');
    const trasResume = { ...store.conversations[0] };
    const eventos = store.controlEvents.length;

    const { takeover } = await route('whatsapp.message.sent', sentPayload(), store);

    expect(takeover).toMatchObject({ pause: 'already_applied', message: 'duplicate' });
    // La conversación sigue activa, byte a byte como la dejó el resume.
    expect(store.conversations[0]).toEqual(trasResume);
    expect(store.controlEvents).toHaveLength(eventos);
    expect(store.messages).toHaveLength(1);
  });

  it('§3 · y la expiración no reaparece: no hay nada que volver a expirar', async () => {
    await takeoverInicial();
    const despues = () => '2025-10-09T10:00:00.000Z';
    await resolveExpiredPause(PHONE_DIGITS, store, despues);

    await route('whatsapp.message.sent', sentPayload(), store);

    // Si la reentrega hubiera re-pausado, esto volvería a decir 'resumed' y el
    // ciclo se repetiría en cada mensaje del cliente.
    expect(await resolveExpiredPause(PHONE_DIGITS, store, despues)).toBe('not_expired');
    expect(store.conversations[0].resumed_at).toBe('2025-10-09T10:00:00.000Z');
  });

  it('§4 · tras un resume MANUAL, la reentrega del mismo wamid no re-pausa', async () => {
    await takeoverInicial();

    // Resume explícito: alguien devolvió el control a propósito, antes de tiempo.
    const cuando = () => '2025-10-09T09:05:00.000Z';
    const resume = await resumeAgentConversation(PHONE_DIGITS, store, cuando);
    expect(resume).toMatchObject({ result: 'ok', transition: 'resumed' });
    const trasResume = { ...store.conversations[0] };
    const eventos = store.controlEvents.length;

    const { takeover } = await route('whatsapp.message.sent', sentPayload(), store);

    expect(takeover).toMatchObject({ pause: 'already_applied' });
    expect(store.conversations[0]).toEqual(trasResume);
    expect(store.conversations[0].state).toBe('active');
    expect(store.conversations[0].resumed_at).toBe('2025-10-09T09:05:00.000Z');
    expect(store.controlEvents).toHaveLength(eventos);
    expect(store.messages).toHaveLength(1);
  });

  it('§4 · una intervención humana NUEVA sí vuelve a pausar tras el resume', async () => {
    // El contrapunto imprescindible: la barrera es por wamid, no un cierre
    // permanente. Si la persona escribe otra vez, el takeover se aplica entero.
    await takeoverInicial();
    await resumeAgentConversation(PHONE_DIGITS, store, () => '2025-10-09T09:05:00.000Z');

    const { takeover } = await route(
      'whatsapp.message.sent',
      sentPayload({ wamid: 'wamid.OTRO', timestamp: T0 + 15 * MINUTO }),
      store,
    );

    expect(takeover).toMatchObject({ pause: 'paused', message: 'inserted' });
    expect(store.conversations[0].state).toBe('paused');
    expect(store.conversations[0].pause_expires_at).toBe('2025-10-09T09:38:20.000Z');
    // Append-only, y la historia se lee entera: pausa, devolución, pausa nueva.
    expect(store.controlEvents.map((e) => e.action)).toEqual(['pause', 'resume', 'pause']);
  });

  it('el marcador es el EVENTO, no el mensaje: una ejecución a medias se repara', async () => {
    // La distinción entera del hardening. Aquí el mensaje ya está guardado (la
    // ejecución anterior murió justo después) pero no hay evento de control:
    // eso NO es una reentrega completada, es una reparación pendiente.
    const flaky = failOnce(store, 'pauseConversation');
    await expect(route('whatsapp.message.sent', sentPayload(), flaky)).rejects.toThrow();
    expect(store.messages).toHaveLength(1);
    expect(store.controlEvents).toHaveLength(0);
    expect(store.conversations[0].state).toBe('active');

    const { takeover } = await route('whatsapp.message.sent', sentPayload(), store);

    expect(takeover).toMatchObject({ message: 'duplicate', pause: 'paused' });
    expect(store.conversations[0].state).toBe('paused');
    expect(store.conversations[0].pause_expires_at).toBe('2025-10-09T09:23:20.000Z');
  });

  it('la barrera se consulta ANTES de escribir nada', async () => {
    await takeoverInicial();
    const antes = store.calls.length;

    await route('whatsapp.message.sent', sentPayload(), store);

    // Orden exacto: identidad, barrera, y fuera. `insertMessage` no se intenta.
    expect(store.calls.slice(antes)).toEqual(['upsertConversation', 'hasPauseEventForMessage']);
  });

  it('la barrera es por conversación: el mismo wamid en otro teléfono no se bloquea', async () => {
    // Defensivo. `provider_message_id` es único en `agent_messages`, pero el
    // UNIQUE de los eventos de control incluye la conversación, y la consulta
    // tiene que respetar esa forma para no inventar una idempotencia global.
    await takeoverInicial();

    const otro = await store.upsertConversation({
      customerPhone: '59170000002',
      providerConversationId: null,
      providerPhoneNumberId: null,
    });

    expect(await store.hasPauseEventForMessage(otro.id, WAMID)).toBe(false);
    expect(await store.hasPauseEventForMessage(store.conversations[0].id, WAMID)).toBe(true);
  });
});

// ── §5: la renovación es MONÓTONA ──────────────────────────────────────────

/**
 * Una intervención humana puede alargar el takeover o dejarlo como está. Nunca
 * acortarlo.
 *
 * El caso que lo exige no es teórico: dos mensajes humanos seguidos pueden
 * llegarnos en orden inverso —reintentos, reordenación en el proveedor— y el
 * segundo en llegar traer un `timestamp` anterior. Recalcular a ciegas movería
 * el vencimiento hacia atrás y devolvería el control al agente antes de tiempo,
 * que es justo lo contrario de lo que significa que alguien acabe de escribir.
 */

describe('takeover — renovación monótona (§5)', () => {
  it('§5 · un mensaje humano nuevo pero ANTERIOR no acorta el vencimiento', async () => {
    // WAMID-B a las 09:03:20 → vence 09:33:20.
    await route(
      'whatsapp.message.sent',
      sentPayload({ wamid: 'wamid.B', timestamp: T0 + 10 * MINUTO }),
      store,
    );
    expect(store.conversations[0].pause_expires_at).toBe('2025-10-09T09:33:20.000Z');

    // WAMID-A llega DESPUÉS pero se escribió antes, a las 08:58:20 → 09:28:20.
    const { takeover } = await route(
      'whatsapp.message.sent',
      sentPayload({ wamid: 'wamid.A', timestamp: T0 + 5 * MINUTO }),
      store,
    );

    expect(takeover).toMatchObject({ message: 'inserted', pause: 'already_paused' });
    // El vencimiento se queda donde estaba: max(vigente, candidato).
    expect(store.conversations[0].pause_expires_at).toBe('2025-10-09T09:33:20.000Z');
    // Y `paused_at` tampoco se mueve.
    expect(store.conversations[0].paused_at).toBe('2025-10-09T09:03:20.000Z');
  });

  it('§5 · la intervención tardía SÍ queda registrada, aunque no extienda', async () => {
    // No extender no es ignorar: el mensaje y su evento son reales.
    await route(
      'whatsapp.message.sent',
      sentPayload({ wamid: 'wamid.B', timestamp: T0 + 10 * MINUTO }),
      store,
    );
    await route(
      'whatsapp.message.sent',
      sentPayload({ wamid: 'wamid.A', timestamp: T0 + 5 * MINUTO }),
      store,
    );

    expect(store.messages).toHaveLength(2);
    expect(store.controlEvents).toHaveLength(2);
    // Cada evento cuenta hasta cuándo habría durado SU intervención: el
    // historial es append-only y no se reescribe con lo que acabó pasando.
    expect(store.controlEvents.map((e) => e.expiresAt)).toEqual([
      '2025-10-09T09:33:20.000Z',
      '2025-10-09T09:28:20.000Z',
    ]);
  });

  it('§5 · `renewPause` distingue no-extender de no-renovable', async () => {
    await route(
      'whatsapp.message.sent',
      sentPayload({ wamid: 'wamid.B', timestamp: T0 + 10 * MINUTO }),
      store,
    );
    const id = store.conversations[0].id;

    // Más corto que el vigente: renovable, pero no se extiende.
    expect(
      await store.renewPause({
        agentConversationId: id,
        pauseExpiresAt: '2025-10-09T09:20:00.000Z',
        reason: PAUSE_REASON_HUMAN_BUSINESS_APP,
        source: 'business_app',
      }),
    ).toBe('not_extended');

    // Exactamente igual: tampoco se escribe. `<`, no `<=`.
    expect(
      await store.renewPause({
        agentConversationId: id,
        pauseExpiresAt: '2025-10-09T09:33:20.000Z',
        reason: PAUSE_REASON_HUMAN_BUSINESS_APP,
        source: 'business_app',
      }),
    ).toBe('not_extended');

    // Más largo: se extiende.
    expect(
      await store.renewPause({
        agentConversationId: id,
        pauseExpiresAt: '2025-10-09T09:40:00.000Z',
        reason: PAUSE_REASON_HUMAN_BUSINESS_APP,
        source: 'business_app',
      }),
    ).toBe('renewed');

    // Otro tipo de pausa: ni siquiera es renovable.
    expect(
      await store.renewPause({
        agentConversationId: id,
        pauseExpiresAt: '2025-10-09T23:00:00.000Z',
        reason: 'manual_dashboard_off',
        source: 'dashboard',
      }),
    ).toBe('not_renewable');

    expect(store.conversations[0].pause_expires_at).toBe('2025-10-09T09:40:00.000Z');
  });

  it('§5 · una pausa de takeover ANTIGUA (sin plazo) sí adopta el vencimiento', async () => {
    // El guard de monotonía no puede dejar fuera el caso NULL: una pausa
    // indefinida heredada de antes de 5C.1 debe pasar al comportamiento nuevo
    // en cuanto la persona vuelva a escribir. `NULL` no es "infinito" aquí.
    const conversation = await store.upsertConversation({
      customerPhone: PHONE_DIGITS,
      providerConversationId: null,
      providerPhoneNumberId: null,
    });
    await store.pauseConversation({
      agentConversationId: conversation.id,
      pausedAt: '2025-10-09T08:00:00.000Z',
      pauseExpiresAt: null,
      reason: PAUSE_REASON_HUMAN_BUSINESS_APP,
      source: 'business_app',
    });

    await route('whatsapp.message.sent', sentPayload(), store);

    expect(store.conversations[0].pause_expires_at).toBe('2025-10-09T09:23:20.000Z');
    expect(store.conversations[0].paused_at).toBe('2025-10-09T08:00:00.000Z');
  });

  it('§6 · el vencimiento sale del timestamp del proveedor, y el CHECK aguanta', async () => {
    // Se mantiene la decisión de 5C.1: `pause_expires_at` se deriva del MISMO
    // instante que `paused_at`, así que `pause_expires_at > paused_at` no puede
    // violarse por mucho que el reloj del proveedor vaya adelantado o atrasado
    // respecto al nuestro. Un `Date.now()` sí podría romperlo.
    for (const offset of [-86_400, -3600, 0, 3600, 86_400]) {
      const fresh = new FakeAgentStore();
      await route(
        'whatsapp.message.sent',
        sentPayload({ wamid: `wamid.T${offset}`, timestamp: T0 + offset }),
        fresh,
      );

      const conv = fresh.conversations[0];
      expect(Date.parse(conv.pause_expires_at!), `offset ${offset}`).toBeGreaterThan(
        Date.parse(conv.paused_at!),
      );
      expect(
        Date.parse(conv.pause_expires_at!) - Date.parse(conv.paused_at!),
        `offset ${offset}`,
      ).toBe(DEFAULT_HUMAN_TAKEOVER_PAUSE_MINUTES * 60_000);
    }
  });
});

// ── 8/9/10: la variable de entorno ──────────────────────────────────────────

describe('humanTakeoverPauseMinutes — fail-safe', () => {
  it('8 · el default es 30', () => {
    expect(DEFAULT_HUMAN_TAKEOVER_PAUSE_MINUTES).toBe(30);
    expect(humanTakeoverPauseMinutes(undefined)).toBe(30);
    expect(humanTakeoverPauseMinutes(null)).toBe(30);
    expect(humanTakeoverPauseMinutes('')).toBe(30);
  });

  it('9 · un valor válido se respeta, con espacios alrededor incluidos', () => {
    expect(humanTakeoverPauseMinutes('60')).toBe(60);
    expect(humanTakeoverPauseMinutes(' 15 ')).toBe(15);
    expect(humanTakeoverPauseMinutes('1')).toBe(MIN_HUMAN_TAKEOVER_PAUSE_MINUTES);
    expect(humanTakeoverPauseMinutes('1440')).toBe(MAX_HUMAN_TAKEOVER_PAUSE_MINUTES);
  });

  it('10 · cualquier valor imposible cae al default, y NUNCA lanza', () => {
    // Una variable mal escrita no puede dejar al negocio sin recibir mensajes:
    // esto corre dentro del webhook, en la ruta síncrona del takeover.
    for (const raw of [
      '0',
      '-5',
      '1441',
      '99999',
      'treinta',
      '30m',
      '1e3',
      '30.5',
      ' ',
      'NaN',
      'Infinity',
    ]) {
      expect(humanTakeoverPauseMinutes(raw), raw).toBe(DEFAULT_HUMAN_TAKEOVER_PAUSE_MINUTES);
    }
  });

  it('10 · fuera de rango cae al default, no se recorta', () => {
    // Recortar 5000 a 1440 sería honrar a medias algo que casi seguro es un
    // error de tecleo, y en silencio. El default está documentado.
    expect(humanTakeoverPauseMinutes('5000')).toBe(30);
  });

  it('el rango declarado es 1..1440', () => {
    expect(MIN_HUMAN_TAKEOVER_PAUSE_MINUTES).toBe(1);
    expect(MAX_HUMAN_TAKEOVER_PAUSE_MINUTES).toBe(1440);
  });

  it('pauseExpiryFrom suma minutos sobre el instante dado', () => {
    expect(pauseExpiryFrom('2026-08-16T10:00:00.000Z', 30)).toBe('2026-08-16T10:30:00.000Z');
    expect(pauseExpiryFrom('2026-08-16T23:50:00.000Z', 30)).toBe('2026-08-17T00:20:00.000Z');
  });
});
