import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  handleKapsoWebhook,
  KAPSO_PAYLOAD_VERSION,
  KAPSO_SUPPORTED_EVENT,
  type AttachOrderLocation,
  type ConfirmOrder,
  type EnsureLocationRequest,
  type SendMenuCta,
} from './kapso';
import { FakeWebhookEventStore } from './fake-store';
import { MENU_TRIGGER_TEXT } from './menu-trigger';
import { handleHumanTakeover } from '@/lib/agent/control/takeover';
import { persistCustomerInbound } from '@/lib/agent/memory/persist-inbound';
import type {
  AgentChannelPort,
  AgentTurnResult,
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
import type { AgentConversationState } from '@/types';
import type * as OutboundStore from '@/lib/orders/notifications/outbound-webhook';

/**
 * Integración del Agent Core en el webhook de Kapso (Fase 6D.2F.2B).
 *
 * Lo que se verifica aquí y no se puede verificar en los módulos puros:
 *
 *   · el ORDEN — firma → claim de `webhook_events` → procedencia → takeover;
 *   · que un saliente `business_app` NO llega a `processMessage` ni a la
 *     reconciliación de notificaciones;
 *   · que un fallo al persistir el historial entrante IMPIDE `processMessage`
 *     y deja el evento reintentable (fail-before-side-effect);
 *   · que los flujos determinísticos siguen exactamente igual, con y sin Agent
 *     Core inyectado, y también con la conversación pausada.
 */

const SECRET = 'test-webhook-secret';
const CUSTOMER_RAW = '+591 700-00001';
const CUSTOMER_DIGITS = '59170000001';
const BUSINESS_PHONE = '59180000000';
const HUMAN_WAMID = 'wamid.HUMAN_1';
/** Copy real de una notificación nuestra: lleva el número de pedido incrustado. */
const NOTIFICATION_COPY = '📦 ¡Recibí tu pedido ORD-000009!';

function sign(rawBody: string): string {
  return createHmac('sha256', SECRET).update(rawBody, 'utf8').digest('hex');
}

// ── webhook_events (transporte) ──────────────────────────────────────────────

const FakeStore = FakeWebhookEventStore;
type FakeStore = FakeWebhookEventStore;

// ── agent_* (semántica) ──────────────────────────────────────────────────────

class MemoryAgentStore implements AgentStore {
  conversations: {
    id: string;
    customer_phone: string;
    state: AgentConversationState;
    paused_at: string | null;
    pause_expires_at: string | null;
    pause_reason: string | null;
    pause_source: string | null;
    resumed_at: string | null;
    first_customer_message_at: string | null;
    last_customer_message_at: string | null;
    last_human_message_at: string | null;
  }[] = [];
  messages: InsertAgentMessageInput[] = [];
  controlEvents: InsertControlEventInput[] = [];

  private seq = 0;

  async upsertConversation(input: UpsertConversationInput): Promise<AgentConversationRef> {
    let row = this.conversations.find((c) => c.customer_phone === input.customerPhone);
    if (!row) {
      row = {
        id: `conv-${++this.seq}`,
        customer_phone: input.customerPhone,
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
    return { id: row.id, state: row.state };
  }

  async insertMessage(input: InsertAgentMessageInput): Promise<InsertMessageResult> {
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
    if (row.first_customer_message_at === null) row.first_customer_message_at = timestamp;
    row.last_customer_message_at = timestamp;
  }

  async touchHumanMessageAt(id: string, timestamp: string): Promise<void> {
    this.conversations.find((c) => c.id === id)!.last_human_message_at = timestamp;
  }

  async pauseConversation(input: PauseConversationInput): Promise<PauseConversationResult> {
    const row = this.conversations.find((c) => c.id === input.agentConversationId)!;
    if (row.state !== 'active') return 'already_paused';
    row.state = 'paused';
    row.paused_at = input.pausedAt;
    row.pause_expires_at = input.pauseExpiresAt;
    row.pause_reason = input.reason;
    row.pause_source = input.source;
    return 'paused';
  }

  async renewPause(input: RenewPauseInput): Promise<RenewPauseResult> {
    const row = this.conversations.find((c) => c.id === input.agentConversationId)!;
    if (
      row.state !== 'paused' ||
      row.pause_reason !== input.reason ||
      row.pause_source !== input.source
    ) {
      return 'not_renewable';
    }
    // Guard de monotonía: el vencimiento solo avanza.
    if (row.pause_expires_at !== null && row.pause_expires_at >= input.pauseExpiresAt) {
      return 'not_extended';
    }
    row.pause_expires_at = input.pauseExpiresAt;
    return 'renewed';
  }

  async resumeConversation(input: ResumeConversationInput): Promise<ResumeConversationResult> {
    const row = this.conversations.find((c) => c.id === input.agentConversationId)!;
    if (row.state !== 'paused') return 'already_active';
    row.state = 'active';
    row.paused_at = null;
    row.pause_expires_at = null;
    row.pause_reason = null;
    row.pause_source = null;
    row.resumed_at = input.resumedAt;
    return 'resumed';
  }

  async hasResumeEvent(id: string, resumedAt: string): Promise<boolean> {
    return this.controlEvents.some(
      (e) =>
        e.agentConversationId === id &&
        e.action === 'resume' &&
        (e.metadata as { resumed_at?: string } | null)?.resumed_at === resumedAt,
    );
  }

  async hasPauseEventForMessage(id: string, providerMessageId: string): Promise<boolean> {
    return this.controlEvents.some(
      (e) =>
        e.agentConversationId === id &&
        e.action === 'pause' &&
        e.providerMessageId === providerMessageId,
    );
  }

  async insertControlEvent(input: InsertControlEventInput): Promise<InsertControlEventResult> {
    const clash = this.controlEvents.some(
      (e) =>
        input.providerMessageId !== null &&
        e.agentConversationId === input.agentConversationId &&
        e.action === input.action &&
        e.providerMessageId === input.providerMessageId,
    );
    if (clash) return 'duplicate';
    this.controlEvents.push(input);
    return 'inserted';
  }

  async findPauseStateByPhone(customerPhone: string): Promise<AgentPauseState | null> {
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

/** Puerto real (funciones puras de producción) sobre el store en memoria. */
function testAgentChannel(store: AgentStore): AgentChannelPort {
  return {
    handleHumanTakeover: (message) => handleHumanTakeover(message, store),
    persistCustomerInbound: (message) => persistCustomerInbound(message, store),
  };
}

/**
 * Hace fallar UNA vez el paso indicado del store: simula que Supabase se cae a
 * mitad de la secuencia del takeover, con el webhook real por encima.
 */
function failOnce(store: MemoryAgentStore, step: keyof AgentStore): AgentStore {
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

// ── Dependencias determinísticas: fallan el test si se invocan sin querer ────

const NEVER_CONFIRM: ConfirmOrder = async () => {
  throw new Error('confirmOrder no debía llamarse');
};
const NEVER_ENSURE: EnsureLocationRequest = async () => {
  throw new Error('ensureLocationRequest no debía llamarse');
};
const NEVER_ATTACH: AttachOrderLocation = async () => {
  throw new Error('attachOrderLocation no debía llamarse');
};
const NEVER_SEND_CTA: SendMenuCta = async () => {
  throw new Error('sendMenuCta no debía llamarse');
};

/** Reconciliación de notificaciones: registra qué se le pidió resolver. */
function fakeOutbound() {
  const calls: string[] = [];
  const store: OutboundStore.OutboundReconciliationStore = {
    resolveOrder: async (orderNumber) => {
      calls.push(`resolve:${orderNumber}`);
      return { id: 'ord-uuid', customerPhoneDigits: CUSTOMER_DIGITS };
    },
    markSentByWebhook: async (_orderId, type, wamid) => {
      calls.push(`markSent:${type}:${wamid}`);
      return 'sent';
    },
    loadStates: async () => ({ rows: [], unknownStateCount: 0 }),
    markTerminalByType: async () => {
      calls.push('markTerminal');
      return true;
    },
  };
  return { store, calls };
}

// ── Payloads ────────────────────────────────────────────────────────────────

function outboundBody(
  over: { origin?: string; wamid?: string; text?: string } = {},
): string {
  return JSON.stringify({
    phone_number_id: 'pnid-1',
    message: {
      id: over.wamid ?? HUMAN_WAMID,
      type: 'text',
      from: BUSINESS_PHONE,
      to: CUSTOMER_RAW,
      text: { body: over.text ?? 'ya te lo mando' },
      timestamp: 1_760_000_000,
      kapso: {
        direction: 'outbound',
        origin: over.origin ?? 'business_app',
        status: 'sent',
      },
    },
    conversation: { id: 'kapso-conv-1', phone_number: CUSTOMER_RAW },
  });
}

function inboundBody(message: Record<string, unknown> = {}): string {
  return JSON.stringify({
    phone_number_id: 'pnid-1',
    message: {
      id: 'wamid.IN_1',
      type: 'text',
      from: CUSTOMER_RAW,
      text: { body: 'gracias' },
      timestamp: 1_760_000_100,
      kapso: { direction: 'inbound', origin: 'business_app', status: 'received' },
      ...message,
    },
    conversation: { id: 'kapso-conv-1', phone_number: CUSTOMER_RAW },
  });
}

function headers(rawBody: string, overrides: Record<string, string | null> = {}) {
  return {
    signature: sign(rawBody),
    version: KAPSO_PAYLOAD_VERSION,
    event: KAPSO_SUPPORTED_EVENT,
    idempotencyKey: 'idem-1',
    ...overrides,
  };
}

type CallOverrides = Partial<Parameters<typeof handleKapsoWebhook>[0]>;

function call(rawBody: string, hdrs: ReturnType<typeof headers>, over: CallOverrides = {}) {
  return handleKapsoWebhook({
    rawBody,
    headers: hdrs,
    secret: SECRET,
    store: over.store!,
    confirmOrder: over.confirmOrder ?? NEVER_CONFIRM,
    ensureLocationRequest: over.ensureLocationRequest ?? NEVER_ENSURE,
    attachOrderLocation: over.attachOrderLocation ?? NEVER_ATTACH,
    sendMenuCta: over.sendMenuCta ?? NEVER_SEND_CTA,
    ...over,
  });
}

let events: FakeStore;
let agent: MemoryAgentStore;
let channel: AgentChannelPort;

beforeEach(() => {
  events = new FakeStore();
  agent = new MemoryAgentStore();
  channel = testAgentChannel(agent);
});

/**
 * Canal con turno de agente instrumentado (Fase 6D.2F.3). Registra cada
 * invocación para poder afirmar que NO ocurre en las rutas determinísticas.
 */
function channelWithAgent(
  turn: AgentTurnResult = { result: 'replied', runId: 'run-1' },
  onCall?: () => void,
) {
  const calls: string[] = [];
  const channel: AgentChannelPort = {
    ...testAgentChannel(agent),
    runAgentTurn: async (message) => {
      calls.push(message.providerMessageId ?? 'sin-wamid');
      onCall?.();
      return turn;
    },
  };
  return { channel, calls };
}

// ── Orden del pipeline ──────────────────────────────────────────────────────

describe('webhook + agent — orden del pipeline', () => {
  it('business_app sent: takeover, sin processMessage y sin reconciliación', async () => {
    const raw = outboundBody();
    const { store: outbound, calls } = fakeOutbound();

    const res = await call(raw, headers(raw, { event: 'whatsapp.message.sent' }), {
      store: events,
      outbound,
      agentChannel: channel,
    });

    expect(res.status).toBe(200);
    expect(res.outcome).toBe('processed');
    expect(res.body).toEqual({
      ok: true,
      handled: 'human_takeover',
      result: 'paused',
      message: 'inserted',
      control_event: 'inserted',
    });
    // El takeover corta antes que la reconciliación de notificaciones: ese
    // saliente no es nuestro y no debe buscarse como `no_order_number`.
    expect(calls).toEqual([]);
    // Y antes que processMessage: las dependencias determinísticas lanzarían.
    expect(agent.messages).toHaveLength(1);
    expect(events.statuses()).toEqual(['processed']);
  });

  it('el takeover funciona aunque la reconciliación outbound no esté inyectada', async () => {
    const raw = outboundBody();

    const res = await call(raw, headers(raw, { event: 'whatsapp.message.sent' }), {
      store: events,
      agentChannel: channel,
    });

    expect(res.body).toMatchObject({ handled: 'human_takeover', result: 'paused' });
    expect(agent.conversations[0].state).toBe('paused');
  });

  it('la respuesta del takeover no filtra teléfono, wamid ni contenido', async () => {
    const raw = outboundBody({ text: 'dato privado del negocio' });

    const res = await call(raw, headers(raw, { event: 'whatsapp.message.sent' }), {
      store: events,
      agentChannel: channel,
    });

    const body = JSON.stringify(res.body);
    expect(body).not.toContain(CUSTOMER_DIGITS);
    expect(body).not.toContain(HUMAN_WAMID);
    expect(body).not.toContain('dato privado');
  });

  it('firma inválida: ni claim de webhook_events ni escritura en agent_*', async () => {
    const raw = outboundBody();

    const res = await call(
      raw,
      headers(raw, { event: 'whatsapp.message.sent', signature: 'deadbeef' }),
      { store: events, agentChannel: channel },
    );

    expect(res.status).toBe(401);
    expect(events.rows.size).toBe(0);
    expect(agent.conversations).toHaveLength(0);
  });

  it('sin idempotency key no se toca el agente', async () => {
    const raw = outboundBody();

    const res = await call(
      raw,
      headers(raw, { event: 'whatsapp.message.sent', idempotencyKey: null }),
      { store: events, agentChannel: channel },
    );

    expect(res.status).toBe(400);
    expect(agent.conversations).toHaveLength(0);
  });

  it('evento ya procesado: duplicate sin reejecutar el takeover', async () => {
    const raw = outboundBody();
    const hdrs = headers(raw, { event: 'whatsapp.message.sent', idempotencyKey: 'takeover-1' });

    const first = await call(raw, hdrs, { store: events, agentChannel: channel });
    const second = await call(raw, hdrs, { store: events, agentChannel: channel });

    expect(first.outcome).toBe('processed');
    expect(second.outcome).toBe('duplicate');
    expect(agent.messages).toHaveLength(1);
    expect(agent.controlEvents).toHaveLength(1);
  });
});

// ── J a nivel de transporte: misma WAMID, claves de idempotencia distintas ───

describe('webhook + agent — idempotencia semántica por WAMID', () => {
  it('dos entregas con claves distintas del MISMO wamid: un mensaje, una pausa', async () => {
    const raw = outboundBody();

    const first = await call(
      raw,
      headers(raw, { event: 'whatsapp.message.sent', idempotencyKey: 'entrega-A' }),
      { store: events, agentChannel: channel },
    );
    const second = await call(
      raw,
      headers(raw, { event: 'whatsapp.message.sent', idempotencyKey: 'entrega-B' }),
      { store: events, agentChannel: channel },
    );

    // `webhook_events` las ve como dos eventos distintos: ambas se procesan.
    expect(first.outcome).toBe('processed');
    expect(second.outcome).toBe('processed');
    expect(second.status).toBe(200);
    // La barrera semántica (wamid) evita duplicar el historial y la pausa.
    expect(agent.messages).toHaveLength(1);
    expect(agent.controlEvents).toHaveLength(1);
    // `already_applied`: el WAMID ya había completado su takeover, así que esta
    // segunda entrega no escribió absolutamente nada. Es lo que hace que una
    // reentrega no pueda re-pausar una conversación ya reanudada.
    expect(second.body).toMatchObject({
      result: 'already_applied',
      message: 'duplicate',
      control_event: 'duplicate',
    });
  });

  it('delivered y read posteriores no crean otro mensaje ni otra pausa', async () => {
    const raw = outboundBody();
    const { store: outbound } = fakeOutbound();

    await call(raw, headers(raw, { event: 'whatsapp.message.sent', idempotencyKey: 'k1' }), {
      store: events,
      agentChannel: channel,
    });
    const snapshot = { ...agent.conversations[0] };

    for (const [i, event] of ['whatsapp.message.delivered', 'whatsapp.message.read'].entries()) {
      await call(raw, headers(raw, { event, idempotencyKey: `k-life-${i}` }), {
        store: events,
        outbound,
        agentChannel: channel,
      });
    }

    expect(agent.messages).toHaveLength(1);
    expect(agent.controlEvents).toHaveLength(1);
    expect(agent.conversations[0]).toEqual(snapshot);
  });
});

// ── Fallos parciales del takeover: failed → claim → processed ───────────────

describe('webhook + agent — el takeover converge tras un fallo parcial', () => {
  /** Reentrega de Kapso: misma clave de idempotencia, mismo cuerpo. */
  const KEY = 'takeover-retry';

  it('CASO A · falla la pausa: evento failed, y el reintento lo deja processed', async () => {
    const raw = outboundBody();
    const hdrs = headers(raw, { event: 'whatsapp.message.sent', idempotencyKey: KEY });
    const flaky = testAgentChannel(failOnce(agent, 'pauseConversation'));

    const first = await call(raw, hdrs, { store: events, agentChannel: flaky });

    expect(first.status).toBe(500);
    expect(first.outcome).toBe('failed');
    // NO se marcó processed a medias: el evento sigue reclamable.
    expect(events.statuses()).toEqual(['received']);
    expect(agent.messages).toHaveLength(1);
    expect(agent.conversations[0].state).toBe('active');
    expect(agent.controlEvents).toHaveLength(0);

    const retry = await call(raw, hdrs, { store: events, agentChannel: flaky });

    expect(retry.status).toBe(200);
    expect(retry.outcome).toBe('processed');
    expect(retry.body).toMatchObject({
      handled: 'human_takeover',
      result: 'paused',
      message: 'duplicate',
      control_event: 'inserted',
    });
    expect(events.statuses()).toEqual(['processed']);
    expect(agent.messages).toHaveLength(1);
    expect(agent.controlEvents).toHaveLength(1);
  });

  it('CASO B · falla el evento de control: se repara sin mover paused_at', async () => {
    const raw = outboundBody();
    const hdrs = headers(raw, { event: 'whatsapp.message.sent', idempotencyKey: KEY });
    const flaky = testAgentChannel(failOnce(agent, 'insertControlEvent'));

    const first = await call(raw, hdrs, { store: events, agentChannel: flaky });

    expect(first.outcome).toBe('failed');
    expect(events.statuses()).toEqual(['received']);
    // La pausa ya está puesta; lo que falta es el historial de control.
    expect(agent.conversations[0].state).toBe('paused');
    expect(agent.controlEvents).toHaveLength(0);
    const pausedAt = agent.conversations[0].paused_at;

    const retry = await call(raw, hdrs, { store: events, agentChannel: flaky });

    expect(retry.outcome).toBe('processed');
    expect(retry.body).toMatchObject({
      result: 'already_paused', // la pausa no se pierde ni se reabre
      message: 'duplicate', // el mensaje humano no se duplica
      control_event: 'inserted', // la escritura que faltaba
    });
    expect(agent.conversations[0].paused_at).toBe(pausedAt);
    expect(agent.messages).toHaveLength(1);
    expect(agent.controlEvents).toHaveLength(1);
    expect(events.statuses()).toEqual(['processed']);
  });

  it('un evento en `processing` no se procesa dos veces en paralelo', async () => {
    const raw = outboundBody();
    const hdrs = headers(raw, { event: 'whatsapp.message.sent', idempotencyKey: KEY });
    const slow = testAgentChannel(agent);

    const [a, b] = await Promise.all([
      call(raw, hdrs, { store: events, agentChannel: slow }),
      call(raw, hdrs, { store: events, agentChannel: slow }),
    ]);

    // Una gana el claim; la otra ve `processing` y se retira sin tocar nada.
    const outcomes = [a.outcome, b.outcome].sort();
    expect(outcomes).toEqual(['in_progress', 'processed']);
    expect(agent.messages).toHaveLength(1);
    expect(agent.controlEvents).toHaveLength(1);
  });

  it('CASO C · reentrega con la MISMA clave tras converger: duplicate sin reejecutar', async () => {
    const raw = outboundBody();
    const hdrs = headers(raw, { event: 'whatsapp.message.sent', idempotencyKey: KEY });

    await call(raw, hdrs, { store: events, agentChannel: channel });
    const snapshot = { ...agent.conversations[0] };

    const again = await call(raw, hdrs, { store: events, agentChannel: channel });

    expect(again.status).toBe(200);
    expect(again.outcome).toBe('duplicate');
    expect(agent.messages).toHaveLength(1);
    expect(agent.controlEvents).toHaveLength(1);
    expect(agent.conversations[0]).toEqual(snapshot);
  });

  it('CASO D · reentrega con OTRA clave: se reejecuta y no cambia nada semántico', async () => {
    const raw = outboundBody();

    await call(raw, headers(raw, { event: 'whatsapp.message.sent', idempotencyKey: 'k-A' }), {
      store: events,
      agentChannel: channel,
    });
    const pausedAt = agent.conversations[0].paused_at;

    const second = await call(
      raw,
      headers(raw, { event: 'whatsapp.message.sent', idempotencyKey: 'k-B' }),
      { store: events, agentChannel: channel },
    );

    expect(second.status).toBe(200);
    expect(second.outcome).toBe('processed');
    expect(agent.messages).toHaveLength(1);
    expect(agent.controlEvents).toHaveLength(1);
    expect(agent.conversations[0].paused_at).toBe(pausedAt);
    // Ambos eventos de transporte quedan cerrados: ninguno se queda colgado.
    expect(events.statuses()).toEqual(['processed', 'processed']);
  });

  /**
   * Los dos casos del hardening de 5C.1, por el camino REAL: `webhook_events`
   * deduplica por clave de idempotencia, así que una reentrega con otra clave
   * atraviesa esa capa entera y llega al takeover. Si para entonces alguien
   * devolvió el control, la reentrega no puede quitárselo otra vez.
   */
  it('§4 · reentrega con OTRA clave DESPUÉS de un resume: no vuelve a pausar', async () => {
    const raw = outboundBody();

    await call(raw, headers(raw, { event: 'whatsapp.message.sent', idempotencyKey: 'k-A' }), {
      store: events,
      agentChannel: channel,
    });
    expect(agent.conversations[0].state).toBe('paused');

    // Resume explícito: se devuelve el control al agente a propósito.
    await agent.resumeConversation({
      agentConversationId: agent.conversations[0].id,
      resumedAt: '2026-08-16T12:00:00.000Z',
    });
    const trasResume = { ...agent.conversations[0] };

    const second = await call(
      raw,
      headers(raw, { event: 'whatsapp.message.sent', idempotencyKey: 'k-B' }),
      { store: events, agentChannel: channel },
    );

    expect(second.status).toBe(200);
    expect(second.outcome).toBe('processed');
    expect(second.body).toMatchObject({ result: 'already_applied' });
    // Sigue activa, con su `resumed_at` intacto. Nada de re-pausar.
    expect(agent.conversations[0]).toEqual(trasResume);
    expect(agent.messages).toHaveLength(1);
    expect(agent.controlEvents).toHaveLength(1);
    // El evento de transporte igualmente se cierra: no queda colgado ni falla.
    expect(events.statuses()).toEqual(['processed', 'processed']);
  });
});

// ── cloud_api: nuestro propio envío ─────────────────────────────────────────

describe('webhook + agent — cloud_api no es takeover', () => {
  it('sent + cloud_api sigue por la reconciliación y no toca agent_*', async () => {
    const raw = outboundBody({ origin: 'cloud_api', text: NOTIFICATION_COPY });
    const { store: outbound, calls } = fakeOutbound();

    const res = await call(raw, headers(raw, { event: 'whatsapp.message.sent' }), {
      store: events,
      outbound,
      agentChannel: channel,
    });

    expect(res.outcome).toBe('processed');
    expect(res.body).toMatchObject({ handled: 'outbound', outcome: 'sent' });
    expect(calls).toEqual([
      'resolve:ORD-000009',
      `markSent:confirmation:${HUMAN_WAMID}`,
    ]);
    expect(agent.conversations).toHaveLength(0);
    expect(agent.messages).toHaveLength(0);
    expect(agent.controlEvents).toHaveLength(0);
  });
});

// ── Entrante: historial + flujo determinístico ──────────────────────────────

describe('webhook + agent — historial entrante', () => {
  it('persiste el entrante y AUN ASÍ procesa el mensaje', async () => {
    const raw = inboundBody({ type: 'text', text: { body: MENU_TRIGGER_TEXT } });
    const sent: string[] = [];
    const sendMenuCta: SendMenuCta = async (input) => {
      sent.push(input.sourceMessageId);
      return { result: 'sent', deliveryId: 'del-cta', wamid: 'wamid.CTA' } as Awaited<ReturnType<SendMenuCta>>;
    };

    const res = await call(raw, headers(raw), { store: events, sendMenuCta, agentChannel: channel });

    expect(res.outcome).toBe('processed');
    expect(res.body).toEqual({
      ok: true,
      handled: 'menu_cta',
      result: 'sent',
      agent_history: 'persisted',
    });
    expect(agent.messages[0]).toMatchObject({ direction: 'inbound', actor: 'customer' });
    expect(sent).toEqual(['wamid.IN_1']);
  });

  it('M · con la conversación PAUSADA el entrante se persiste y el flujo sigue igual', async () => {
    // Primero un humano toma el control.
    const takeoverRaw = outboundBody();
    await call(takeoverRaw, headers(takeoverRaw, { event: 'whatsapp.message.sent' }), {
      store: events,
      agentChannel: channel,
    });
    expect(agent.conversations[0].state).toBe('paused');

    // Después el cliente escribe el trigger del menú.
    const raw = inboundBody({ id: 'wamid.IN_2', text: { body: MENU_TRIGGER_TEXT } });
    const sendMenuCta: SendMenuCta = async () =>
      ({ result: 'sent', deliveryId: 'del-cta', wamid: 'wamid.CTA' }) as Awaited<ReturnType<SendMenuCta>>;

    const res = await call(raw, headers(raw, { idempotencyKey: 'in-2' }), {
      store: events,
      sendMenuCta,
      agentChannel: channel,
    });

    // El historial se guarda…
    expect(agent.messages.filter((m) => m.actor === 'customer')).toHaveLength(1);
    // …y el flujo determinístico NO se detiene por la pausa.
    expect(res.body).toMatchObject({ handled: 'menu_cta', result: 'sent' });
    expect(agent.conversations[0].state).toBe('paused');
  });

  it('un entrante sin teléfono resoluble no bloquea el procesamiento', async () => {
    const raw = JSON.stringify({
      message: { id: 'wamid.IN_9', type: 'text', text: { body: 'gracias' }, timestamp: 1_760_000_100 },
      conversation: {},
    });

    const res = await call(raw, headers(raw), { store: events, agentChannel: channel });

    expect(res.outcome).toBe('processed');
    expect(res.body).toMatchObject({ handled: 'ignored', agent_history: 'rejected' });
    expect(agent.messages).toHaveLength(0);
  });
});

// ── Fail-before-side-effect ─────────────────────────────────────────────────

describe('webhook + agent — un fallo de historial NO pierde el mensaje', () => {
  function brokenChannel(): AgentChannelPort {
    return {
      handleHumanTakeover: (message) => handleHumanTakeover(message, agent),
      persistCustomerInbound: async () => {
        throw new Error('supabase caída');
      },
    };
  }

  it('si falla la persistencia del entrante: no se procesa, no se marca processed, 500', async () => {
    const raw = inboundBody({ text: { body: MENU_TRIGGER_TEXT } });
    const sendMenuCta = vi.fn<SendMenuCta>();

    const res = await call(raw, headers(raw), {
      store: events,
      // Si processMessage llegara a ejecutarse, este spy lo delataría; además
      // confirmOrder/ensureLocation/attach lanzan por defecto.
      sendMenuCta,
      agentChannel: brokenChannel(),
    });

    expect(sendMenuCta).not.toHaveBeenCalled();
    expect(res.status).toBe(500);
    expect(res.outcome).toBe('failed');
    // El evento queda `failed`: reclamable por el mecanismo ya existente.
    expect(events.statuses()).toEqual(['received']);
    const row = [...events.rows.values()][0];
    expect(row.error).toContain('agent_history_persist_failed');
  });

  it('el reintento del mismo evento vuelve a intentarlo y, ya sano, lo completa', async () => {
    const raw = inboundBody({ text: { body: MENU_TRIGGER_TEXT } });
    const hdrs = headers(raw, { idempotencyKey: 'retry-1' });
    const sendMenuCta: SendMenuCta = async () =>
      ({ result: 'sent', deliveryId: 'del-cta', wamid: 'wamid.CTA' }) as Awaited<ReturnType<SendMenuCta>>;

    const failed = await call(raw, hdrs, {
      store: events,
      sendMenuCta,
      agentChannel: brokenChannel(),
    });
    expect(failed.outcome).toBe('failed');

    // Kapso reentrega la misma clave; `claimFailedForRetry` la reclama.
    const retried = await call(raw, hdrs, { store: events, sendMenuCta, agentChannel: channel });

    expect(retried.outcome).toBe('processed');
    expect(retried.body).toMatchObject({ handled: 'menu_cta', agent_history: 'persisted' });
    expect(agent.messages).toHaveLength(1); // el mensaje no se perdió ni se duplicó
    expect(events.statuses()).toEqual(['processed']);
  });

  it('si falla el takeover humano el evento también queda reintentable', async () => {
    const raw = outboundBody();
    const failing: AgentChannelPort = {
      handleHumanTakeover: async () => {
        throw new Error('supabase caída');
      },
      persistCustomerInbound: (message) => persistCustomerInbound(message, agent),
    };

    const res = await call(raw, headers(raw, { event: 'whatsapp.message.sent' }), {
      store: events,
      agentChannel: failing,
    });

    expect(res.status).toBe(500);
    expect(events.statuses()).toEqual(['received']);
  });
});

// ── O/P: regresión de los caminos existentes ────────────────────────────────

describe('webhook + agent — P: sin agentChannel el comportamiento es el de antes', () => {
  it('business_app sent sin Agent Core: se reconcilia como cualquier saliente', async () => {
    const raw = outboundBody({ text: NOTIFICATION_COPY });
    const { store: outbound, calls } = fakeOutbound();

    const res = await call(raw, headers(raw, { event: 'whatsapp.message.sent' }), {
      store: events,
      outbound,
    });

    expect(res.outcome).toBe('processed');
    expect(res.body).toMatchObject({ handled: 'outbound', outcome: 'sent' });
    expect(calls).toEqual(['resolve:ORD-000009', `markSent:confirmation:${HUMAN_WAMID}`]);
    expect(agent.conversations).toHaveLength(0);
  });

  it('saliente sin Agent Core y sin outbound: se ignora con 200, como antes', async () => {
    const raw = outboundBody();

    const res = await call(raw, headers(raw, { event: 'whatsapp.message.sent' }), {
      store: events,
    });

    expect(res.status).toBe(200);
    expect(res.outcome).toBe('ignored');
    expect(res.body).toEqual({ ok: true, ignored: true });
  });

  it('entrante sin Agent Core: cuerpo sin agent_history y sin escrituras agent_*', async () => {
    const raw = inboundBody({ text: { body: MENU_TRIGGER_TEXT } });
    const sendMenuCta: SendMenuCta = async () =>
      ({ result: 'sent', deliveryId: 'del-cta', wamid: 'wamid.CTA' }) as Awaited<ReturnType<SendMenuCta>>;

    const res = await call(raw, headers(raw), { store: events, sendMenuCta });

    expect(res.body).toEqual({ ok: true, handled: 'menu_cta', result: 'sent' });
    expect(res.body).not.toHaveProperty('agent_history');
    expect(agent.messages).toHaveLength(0);
  });
});

describe('webhook + agent — O: los caminos determinísticos no cambian', () => {
  it('nfm_reply confirma el pedido igual, con historial persistido', async () => {
    const draftId = '9f1c8f2e-1a2b-4c3d-8e4f-5a6b7c8d9e0f';
    const raw = inboundBody({
      type: 'interactive',
      text: undefined,
      interactive: { type: 'nfm_reply', nfm_reply: { response_json: '{}' } },
      kapso: {
        direction: 'inbound',
        origin: 'business_app',
        status: 'received',
        flow_response: { order_draft_id: draftId, flow_token: `order_${draftId}` },
      },
    });
    const confirmOrder: ConfirmOrder = async () => ({
      result: 'confirmed',
      order: { id: 'ord-uuid', order_number: 'ORD-000001', status: 'confirmed' },
    });

    const res = await call(raw, headers(raw), { store: events, confirmOrder, agentChannel: channel });

    expect(res.body).toMatchObject({
      handled: 'nfm_reply',
      order_number: 'ORD-000001',
      result: 'confirmed',
      agent_history: 'persisted',
    });
    expect(agent.messages[0].contentType).toBe('interactive');
  });

  it('la ubicación se adjunta igual y se guarda sin marcador inventado', async () => {
    const raw = inboundBody({
      type: 'location',
      text: undefined,
      context: { id: 'wamid.LOCATION_REQUEST_1' },
      location: { latitude: -17.7833, longitude: -63.1821, address: 'Av. X 123', name: 'Casa' },
    });
    const attached: string[] = [];
    const attachOrderLocation: AttachOrderLocation = async (input) => {
      attached.push(input.contextId);
      return {
        result: 'attached',
        order: { id: 'ord-uuid', order_number: 'ORD-000002', status: 'confirmed' },
      };
    };

    const res = await call(raw, headers(raw), {
      store: events,
      attachOrderLocation,
      agentChannel: channel,
    });

    expect(attached).toEqual(['wamid.LOCATION_REQUEST_1']);
    expect(res.body).toMatchObject({ handled: 'location', result: 'attached' });
    expect(agent.messages[0]).toMatchObject({
      contentType: 'location',
      content: null,
      metadata: { latitude: -17.7833, longitude: -63.1821 },
    });
  });

  it('un tipo no soportado se sigue ignorando, pero ya queda en el historial', async () => {
    const raw = inboundBody({ type: 'sticker', text: undefined });

    const res = await call(raw, headers(raw), { store: events, agentChannel: channel });

    expect(res.body).toMatchObject({ handled: 'ignored', result: 'ignored' });
    expect(agent.messages[0]).toMatchObject({ contentType: 'sticker', content: null });
  });
});

// ── Agent Core: dónde puede y dónde NO puede hablar (Fase 6D.2F.3) ──────────

describe('webhook + agent core — el agente no toca las rutas determinísticas', () => {
  const CTA_OK: SendMenuCta = async () =>
    ({ result: 'sent', deliveryId: 'del-cta', wamid: 'wamid.CTA' }) as Awaited<ReturnType<SendMenuCta>>;

  it('TESTMENU9842 se atiende por la ruta determinística, con CERO agente', async () => {
    const raw = inboundBody({ text: { body: MENU_TRIGGER_TEXT } });
    const { channel: withAgent, calls } = channelWithAgent();

    const res = await call(raw, headers(raw), {
      store: events,
      sendMenuCta: CTA_OK,
      agentChannel: withAgent,
    });

    expect(res.body).toMatchObject({ handled: 'menu_cta', result: 'sent' });
    expect(res.body).not.toHaveProperty('agent_turn');
    expect(calls).toEqual([]); // el modelo ni se rozó
  });

  it('la intención natural de menú tampoco pasa por el agente', async () => {
    // Frase real del detector (prefijo `quiero pedir`), no una inventada.
    const raw = inboundBody({ id: 'wamid.IN_MENU', text: { body: 'quiero pedir dos hamburguesas' } });
    const { channel: withAgent, calls } = channelWithAgent();

    const res = await call(raw, headers(raw), {
      store: events,
      sendMenuCta: CTA_OK,
      agentChannel: withAgent,
    });

    expect(res.body).toMatchObject({ handled: 'menu_cta' });
    expect(calls).toEqual([]);
  });

  it('una ubicación va a su flujo determinístico, no al agente', async () => {
    const raw = inboundBody({
      type: 'location',
      text: undefined,
      context: { id: 'wamid.LOCATION_REQUEST_1' },
      location: { latitude: -17.7833, longitude: -63.1821 },
    });
    const attachOrderLocation: AttachOrderLocation = async () => ({
      result: 'attached',
      order: { id: 'ord-uuid', order_number: 'ORD-000002', status: 'confirmed' },
    });
    const { channel: withAgent, calls } = channelWithAgent();

    const res = await call(raw, headers(raw), {
      store: events,
      attachOrderLocation,
      agentChannel: withAgent,
    });

    expect(res.body).toMatchObject({ handled: 'location', result: 'attached' });
    expect(calls).toEqual([]);
  });

  it('un nfm_reply confirma el pedido sin que el agente opine', async () => {
    const draftId = '9f1c8f2e-1a2b-4c3d-8e4f-5a6b7c8d9e0f';
    const raw = inboundBody({
      type: 'interactive',
      text: undefined,
      interactive: { type: 'nfm_reply', nfm_reply: { response_json: '{}' } },
      kapso: {
        direction: 'inbound',
        origin: 'business_app',
        status: 'received',
        flow_response: { order_draft_id: draftId, flow_token: `order_${draftId}` },
      },
    });
    const confirmOrder: ConfirmOrder = async () => ({
      result: 'confirmed',
      order: { id: 'ord-uuid', order_number: 'ORD-000001', status: 'confirmed' },
    });
    const { channel: withAgent, calls } = channelWithAgent();

    const res = await call(raw, headers(raw), {
      store: events,
      confirmOrder,
      agentChannel: withAgent,
    });

    expect(res.body).toMatchObject({ handled: 'nfm_reply', result: 'confirmed' });
    expect(calls).toEqual([]);
  });

  it('el saliente humano dispara el takeover, jamás un turno de agente', async () => {
    const raw = outboundBody();
    const { channel: withAgent, calls } = channelWithAgent();

    const res = await call(raw, headers(raw, { event: 'whatsapp.message.sent' }), {
      store: events,
      agentChannel: withAgent,
    });

    expect(res.body).toMatchObject({ handled: 'human_takeover' });
    expect(calls).toEqual([]);
  });
});

describe('webhook + agent core — el hueco donde sí habla', () => {
  it('un texto que nadie atiende llega al agente exactamente una vez', async () => {
    const raw = inboundBody({ text: { body: 'hola, estan abiertos?' } });
    const { channel: withAgent, calls } = channelWithAgent();

    const res = await call(raw, headers(raw), { store: events, agentChannel: withAgent });

    expect(res.outcome).toBe('processed');
    expect(res.body).toMatchObject({
      handled: 'ignored',
      result: 'ignored',
      agent_history: 'persisted',
      agent_turn: 'replied',
    });
    expect(calls).toEqual(['wamid.IN_1']);
  });

  it('la frase del primer turno real de producción cae en el hueco (6D.2F.4)', async () => {
    // Se comprueba AQUÍ y no a ojo: antes de escribir por WhatsApp hay que saber
    // que la frase no la captura ninguna ruta determinística. `sendMenuCta` es
    // NEVER_SEND_CTA, así que si el detector la tomara por intención de menú
    // esta prueba reventaría en vez de pasar de largo.
    const raw = inboundBody({ text: { body: '¿Quién eres y en qué puedes ayudarme?' } });
    const { channel: withAgent, calls } = channelWithAgent();

    const res = await call(raw, headers(raw), { store: events, agentChannel: withAgent });

    expect(res.outcome).toBe('processed');
    expect(res.body).toMatchObject({ handled: 'ignored', result: 'ignored' });
    expect(calls).toEqual(['wamid.IN_1']);
  });

  it('las frases naturales siguen llegando al agente: ninguna keyword nueva las intercepta', async () => {
    // 6D.2F.4.1: endurecer los HECHOS no debe estrechar la COMPRENSIÓN. Estas
    // son las frases reales del requisito; si alguien intentara "resolverlas"
    // metiendo palabras clave en el pipeline determinístico, este test lo
    // detectaría. `sendMenuCta` es NEVER_SEND_CTA: una interceptación revienta.
    //
    // Deja constancia además del reparto de hoy: "mandme la carta" y
    // "mandamelo otra vez" NO los detecta `isMenuIntent` y caen en el agente.
    const frases = [
      'q tienen?',
      'menu xfa',
      'mandme la carta',
      'cual ta mas rica?',
      'quiero algo sin carne',
      'no me llego',
      'mandamelo otra vez',
    ];

    for (const [i, texto] of frases.entries()) {
      events = new FakeStore();
      agent = new MemoryAgentStore();
      const raw = inboundBody({ id: `wamid.NL_${i}`, text: { body: texto } });
      const { channel: withAgent, calls } = channelWithAgent();

      const res = await call(raw, headers(raw, { idempotencyKey: `idem-nl-${i}` }), {
        store: events,
        agentChannel: withAgent,
      });

      expect(res.body, texto).toMatchObject({ handled: 'ignored', result: 'ignored' });
      expect(calls, texto).toEqual([`wamid.NL_${i}`]);
    }
  });

  it('el desenlace del turno viaja saneado en el cuerpo', async () => {
    const raw = inboundBody({ text: { body: 'gracias' } });
    const { channel: withAgent } = channelWithAgent({
      result: 'skipped',
      reason: 'phone_not_allowed',
    });

    const res = await call(raw, headers(raw), { store: events, agentChannel: withAgent });

    expect(res.body).toMatchObject({ agent_turn: 'skipped:phone_not_allowed' });
    const dump = JSON.stringify(res.body);
    expect(dump).not.toContain(CUSTOMER_DIGITS);
    expect(dump).not.toContain('gracias');
  });

  it('sin runAgentTurn cableado el cuerpo es el de 6D.2F.2B', async () => {
    const raw = inboundBody({ text: { body: 'gracias' } });

    const res = await call(raw, headers(raw), { store: events, agentChannel: channel });

    expect(res.body).toEqual({
      ok: true,
      handled: 'ignored',
      result: 'ignored',
      agent_history: 'persisted',
    });
    expect(res.body).not.toHaveProperty('agent_turn');
  });

  it('un fallo del turno NO tumba un webhook ya resuelto', async () => {
    // Asimetría deliberada con persistInbound: aquí el mensaje ya se atendió y
    // el run está reclamado, así que un 500 no arreglaría nada y marcaría como
    // failed un evento correcto.
    const raw = inboundBody({ text: { body: 'gracias' } });
    const roto: AgentChannelPort = {
      ...testAgentChannel(agent),
      runAgentTurn: async () => {
        throw new Error('openai caido');
      },
    };

    const res = await call(raw, headers(raw), { store: events, agentChannel: roto });

    expect(res.status).toBe(200);
    expect(res.outcome).toBe('processed');
    expect(res.body).toMatchObject({ agent_turn: 'error' });
    expect(events.statuses()).toEqual(['processed']);
  });

  it('el entrante se persiste ANTES del turno: el agente lo ve en su contexto', async () => {
    const raw = inboundBody({ text: { body: 'gracias' } });
    let messagesAlLlamar = -1;
    const { channel: withAgent } = channelWithAgent(
      { result: 'replied', runId: 'run-1' },
      () => {
        messagesAlLlamar = agent.messages.length;
      },
    );

    await call(raw, headers(raw), { store: events, agentChannel: withAgent });

    expect(messagesAlLlamar).toBe(1);
    expect(agent.messages[0]).toMatchObject({ actor: 'customer', direction: 'inbound' });
  });
});
