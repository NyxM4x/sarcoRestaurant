import { describe, it, expect, beforeEach } from 'vitest';
import { EXPIRED_TAKEOVER_RESUME, resolveExpiredPause } from './pause-expiry';
import {
  PAUSE_REASON_HUMAN_BUSINESS_APP,
  RESUME_REASON_TAKEOVER_EXPIRED,
} from '@/lib/agent/core/types';
import type {
  AgentConversationRef,
  AgentPauseState,
  AgentStore,
  InsertControlEventInput,
  InsertControlEventResult,
  InsertMessageResult,
  PauseConversationResult,
  RenewPauseResult,
  ResumeConversationInput,
  ResumeConversationResult,
} from '@/lib/agent/core/types';
import type { AgentConversationState } from '@/types';

/**
 * Expiración PEREZOSA de la pausa (Fase 6D.2F.5C.1).
 *
 * Lo que se prueba aquí es que una pausa vencida deje de retener al agente Y que
 * la fila quede coherente, con su evento de auditoría. Las dos mitades importan:
 * sin la primera el cliente se queda sin respuesta para siempre; sin la segunda
 * la base miente y el panel muestra una conversación pausada que en realidad
 * está siendo atendida por el agente.
 *
 * El doble reproduce los guards reales de 0014, que son los que hacen segura la
 * transición cuando dos mensajes llegan a la vez.
 */

const PHONE = '59162139119';

interface FakeConversation {
  id: string;
  customer_phone: string;
  state: AgentConversationState;
  paused_at: string | null;
  pause_expires_at: string | null;
  pause_reason: string | null;
  pause_source: string | null;
  resumed_at: string | null;
}

class FakeStore implements AgentStore {
  conversations: FakeConversation[] = [];
  controlEvents: InsertControlEventInput[] = [];
  writes = 0;

  seed(over: Partial<FakeConversation> = {}): FakeConversation {
    const row: FakeConversation = {
      id: 'conv-1',
      customer_phone: PHONE,
      state: 'active',
      paused_at: null,
      pause_expires_at: null,
      pause_reason: null,
      pause_source: null,
      resumed_at: null,
      ...over,
    };
    this.conversations.push(row);
    return row;
  }

  /** Pausa de takeover, con el plazo que se le diga. */
  seedTakeover(pausedAt: string, expiresAt: string | null): FakeConversation {
    return this.seed({
      state: 'paused',
      paused_at: pausedAt,
      pause_expires_at: expiresAt,
      pause_reason: PAUSE_REASON_HUMAN_BUSINESS_APP,
      pause_source: 'business_app',
    });
  }

  async upsertConversation(): Promise<AgentConversationRef> {
    throw new Error('la expiración no crea conversaciones');
  }
  async insertMessage(): Promise<InsertMessageResult> {
    throw new Error('la expiración no escribe mensajes');
  }
  async touchCustomerMessageAt(): Promise<void> {
    throw new Error('la expiración no toca marcas de mensajes');
  }
  async touchHumanMessageAt(): Promise<void> {
    throw new Error('la expiración no toca marcas de mensajes');
  }
  async pauseConversation(): Promise<PauseConversationResult> {
    throw new Error('la expiración jamás pausa');
  }
  async renewPause(): Promise<RenewPauseResult> {
    throw new Error('la expiración jamás renueva una pausa');
  }

  async resumeConversation(input: ResumeConversationInput): Promise<ResumeConversationResult> {
    this.writes += 1;
    const row = this.conversations.find((c) => c.id === input.agentConversationId)!;
    // UPDATE ... where state='paused': solo una ejecución concurrente lo gana.
    if (row.state !== 'paused') return 'already_active';
    row.state = 'active';
    row.paused_at = null;
    row.pause_expires_at = null;
    row.pause_reason = null;
    row.pause_source = null;
    row.resumed_at = input.resumedAt;
    return 'resumed';
  }

  async insertControlEvent(input: InsertControlEventInput): Promise<InsertControlEventResult> {
    this.controlEvents.push(input);
    return 'inserted';
  }

  async hasPauseEventForMessage(): Promise<boolean> {
    throw new Error('la expiración no consulta eventos de pausa por wamid');
  }

  async hasResumeEvent(id: string, resumedAt: string): Promise<boolean> {
    return this.controlEvents.some(
      (e) =>
        e.agentConversationId === id &&
        e.action === 'resume' &&
        (e.metadata as { resumed_at?: string } | null)?.resumed_at === resumedAt,
    );
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

const AHORA = '2026-08-13T11:00:00.000Z';
const now = () => AHORA;

let store: FakeStore;
beforeEach(() => {
  store = new FakeStore();
});

describe('resolveExpiredPause — devuelve el control al vencer el plazo', () => {
  it('5 · una pausa vencida se reanuda: el agente vuelve sin resume manual', async () => {
    store.seedTakeover('2026-08-13T10:00:00.000Z', '2026-08-13T10:30:00.000Z');

    const outcome = await resolveExpiredPause(PHONE, store, now);

    expect(outcome).toBe('resumed');
    expect(store.conversations[0]).toMatchObject({
      state: 'active',
      paused_at: null,
      pause_expires_at: null,
      pause_reason: null,
      pause_source: null,
      resumed_at: AHORA,
    });
  });

  it('el resume queda ATRIBUIDO al sistema, no a una persona', async () => {
    // En el historial tiene que poder leerse si el control volvió porque alguien
    // lo devolvió o porque se acabó el tiempo.
    store.seedTakeover('2026-08-13T10:00:00.000Z', '2026-08-13T10:30:00.000Z');

    await resolveExpiredPause(PHONE, store, now);

    expect(store.controlEvents).toHaveLength(1);
    expect(store.controlEvents[0]).toMatchObject({
      action: 'resume',
      source: 'system',
      reason: RESUME_REASON_TAKEOVER_EXPIRED,
      providerMessageId: null,
      metadata: { resumed_at: AHORA },
    });
    expect(EXPIRED_TAKEOVER_RESUME).toEqual({
      source: 'system',
      reason: 'human_takeover_expired',
    });
  });

  it('el motivo cabe en el CHECK de 0014', () => {
    expect(RESUME_REASON_TAKEOVER_EXPIRED).toMatch(/^[A-Za-z0-9._:-]{1,64}$/);
  });

  it('una pausa VIGENTE no se toca: ni una escritura', async () => {
    store.seedTakeover('2026-08-13T10:50:00.000Z', '2026-08-13T11:20:00.000Z');

    const outcome = await resolveExpiredPause(PHONE, store, now);

    expect(outcome).toBe('not_expired');
    expect(store.writes).toBe(0);
    expect(store.controlEvents).toEqual([]);
    expect(store.conversations[0].state).toBe('paused');
  });

  it('7 · una pausa INDEFINIDA no expira nunca', async () => {
    // Un "IA OFF" explícito exige un resume explícito. Que pase el tiempo no es
    // una decisión de nadie.
    store.seedTakeover('2020-01-01T00:00:00.000Z', null);

    const outcome = await resolveExpiredPause(PHONE, store, now);

    expect(outcome).toBe('not_expired');
    expect(store.writes).toBe(0);
    expect(store.conversations[0].state).toBe('paused');
  });

  it('una conversación activa no tiene nada que normalizar', async () => {
    store.seed();

    expect(await resolveExpiredPause(PHONE, store, now)).toBe('not_expired');
    expect(store.writes).toBe(0);
  });

  it('sin conversación no se inventa ninguna', async () => {
    expect(await resolveExpiredPause(PHONE, store, now)).toBe('no_conversation');
    expect(store.conversations).toEqual([]);
  });

  it('sin teléfono no se consulta nada', async () => {
    expect(await resolveExpiredPause('', store, now)).toBe('no_conversation');
  });

  it('llamarla dos veces no duplica el evento de auditoría', async () => {
    // Cada mensaje del cliente pasa por aquí: tiene que ser barata e idempotente.
    store.seedTakeover('2026-08-13T10:00:00.000Z', '2026-08-13T10:30:00.000Z');

    const primera = await resolveExpiredPause(PHONE, store, now);
    const segunda = await resolveExpiredPause(PHONE, store, now);

    expect(primera).toBe('resumed');
    // La segunda ni siquiera entra: la fila ya está activa.
    expect(segunda).toBe('not_expired');
    expect(store.controlEvents).toHaveLength(1);
  });

  it('si otra ejecución gana la transición, esta no reescribe resumed_at', async () => {
    // La carrera real: dos mensajes del cliente a la vez sobre una pausa
    // vencida. El guard `state='paused'` deja pasar a una sola.
    store.seedTakeover('2026-08-13T10:00:00.000Z', '2026-08-13T10:30:00.000Z');

    const [a, b] = await Promise.all([
      resolveExpiredPause(PHONE, store, now),
      resolveExpiredPause(PHONE, store, now),
    ]);

    // Una reanuda; la otra encuentra la fila ya activa por cualquiera de los dos
    // caminos (no llegó a intentarlo, o lo intentó y perdió el guard).
    expect([a, b].filter((r) => r === 'resumed').length).toBeLessThanOrEqual(1);
    expect(store.conversations[0].state).toBe('active');
    expect(store.conversations[0].resumed_at).toBe(AHORA);
  });
});
