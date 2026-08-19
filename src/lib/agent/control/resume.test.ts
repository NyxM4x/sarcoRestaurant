import { describe, it, expect, beforeEach } from 'vitest';
import { resumeAgentConversation } from './resume';
import { handleHumanTakeover } from './takeover';
import { PAUSE_REASON_HUMAN_BUSINESS_APP, RESUME_REASON_MANUAL_API } from '@/lib/agent/core/types';
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
import type { ProvenanceMessage } from '@/lib/kapso/channel/provenance';
import type { AgentConversationState } from '@/types';

/**
 * Resume del agente — contraparte legítima del takeover humano.
 *
 * El doble reproduce las garantías reales de 0014, en particular el CHECK
 * `agent_conversations_state_coherence`: una conversación `active` no puede
 * conservar NINGÚN campo de pausa, y una `paused` no puede tener `resumed_at`.
 * Sin eso, un resume que se dejara `pause_reason` a medias pasaría el test y
 * reventaría en producción.
 */

interface FakeConversation {
  id: string;
  customer_phone: string;
  state: AgentConversationState;
  paused_at: string | null;
  pause_expires_at: string | null;
  pause_reason: string | null;
  pause_source: string | null;
  resumed_at: string | null;
  last_customer_message_at: string | null;
  first_customer_message_at: string | null;
  last_human_message_at: string | null;
}

/**
 * Serialización de un `timestamptz` tal como vuelve de Postgres vía PostgREST.
 *
 * ESTO ES EL CORAZÓN DE LA REGRESIÓN. El doble anterior devolvía exactamente la
 * misma cadena que había recibido, así que era fiel a mi suposición y no a la
 * base: por eso los tests pasaban mientras producción duplicaba el evento de
 * auditoría en cada reintento. JavaScript escribe `…Z` y Postgres devuelve
 * `…+00:00` — mismo instante, texto distinto.
 */
function asPostgrestTimestamp(iso: string | null): string | null {
  return iso === null ? null : iso.replace(/Z$/, '+00:00');
}

/** CHECK `agent_conversations_state_coherence` de 0014. */
function assertStateInvariant(row: FakeConversation): void {
  if (row.state === 'paused') {
    if (row.paused_at === null || row.pause_reason === null || row.pause_source === null) {
      throw new Error('check violation: paused exige paused_at, pause_reason y pause_source');
    }
    if (row.resumed_at !== null) {
      throw new Error('check violation: paused no admite resumed_at');
    }
  } else {
    const dirty =
      row.paused_at !== null ||
      row.pause_expires_at !== null ||
      row.pause_reason !== null ||
      row.pause_source !== null;
    if (dirty) throw new Error('check violation: active exige los campos de pausa a NULL');
  }
}

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
    const row = this.byId(id);
    if (row.first_customer_message_at === null) row.first_customer_message_at = timestamp;
    row.last_customer_message_at = timestamp;
  }

  async touchHumanMessageAt(id: string, timestamp: string): Promise<void> {
    this.byId(id).last_human_message_at = timestamp;
  }

  async pauseConversation(input: PauseConversationInput): Promise<PauseConversationResult> {
    this.calls.push('pauseConversation');
    const row = this.byId(input.agentConversationId);
    if (row.state !== 'active') return 'already_paused';
    row.state = 'paused';
    row.paused_at = input.pausedAt;
    row.pause_expires_at = input.pauseExpiresAt;
    row.pause_reason = input.reason;
    row.pause_source = input.source;
    row.resumed_at = null; // 0014: `paused` no admite resumed_at
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
    row.pause_expires_at = input.pauseExpiresAt;
    assertStateInvariant(row);
    return 'renewed';
  }

  async resumeConversation(input: ResumeConversationInput): Promise<ResumeConversationResult> {
    this.calls.push('resumeConversation');
    const row = this.byId(input.agentConversationId);
    // UPDATE ... where state='paused': solo una ejecución gana la transición.
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

  async insertControlEvent(input: InsertControlEventInput): Promise<InsertControlEventResult> {
    this.calls.push('insertControlEvent');
    this.byId(input.agentConversationId);
    // UNIQUE parcial de 0014: solo aplica cuando hay WAMID.
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

  async findPauseStateByPhone(customerPhone: string): Promise<AgentPauseState | null> {
    this.calls.push('findPauseStateByPhone');
    const row = this.conversations.find((c) => c.customer_phone === customerPhone);
    if (!row) return null;
    // Las tres columnas timestamptz vuelven con la serialización de Postgres,
    // no con la que escribió JavaScript.
    return {
      conversationId: row.id,
      state: row.state,
      pausedAt: asPostgrestTimestamp(row.paused_at),
      pauseExpiresAt: asPostgrestTimestamp(row.pause_expires_at),
      pauseReason: row.pause_reason,
      pauseSource: row.pause_source,
      resumedAt: asPostgrestTimestamp(row.resumed_at),
    };
  }
}

const PHONE = '59162139119';
const WAMID = 'wamid.HUMAN_TAKEOVER_1';

/** Saliente humano real, tal como lo entrega el parser de procedencia. */
function humanMessage(over: Partial<ProvenanceMessage> = {}): ProvenanceMessage {
  return {
    providerMessageId: WAMID,
    providerConversationId: 'kapso-conv-1',
    customerPhone: PHONE,
    providerPhoneNumberId: 'pnid-1',
    messageTimestamp: '2026-08-14T10:00:00.000Z',
    direction: 'outbound',
    origin: 'business_app',
    status: 'sent',
    content: 'Prueba de atención manual.',
    contentType: 'text',
    metadata: null,
    ...over,
  };
}

/** Reloj determinista: cada llamada avanza un minuto. */
function clock(start = '2026-08-14T11:00:00.000Z') {
  let t = new Date(start).getTime();
  return () => {
    const iso = new Date(t).toISOString();
    t += 60_000;
    return iso;
  };
}

let store: FakeAgentStore;
beforeEach(() => {
  store = new FakeAgentStore();
});

/** Deja la conversación pausada por un takeover humano REAL. */
async function seedPaused(): Promise<void> {
  await handleHumanTakeover(humanMessage(), store);
}

describe('resume — transición paused → active', () => {
  it('reanuda: estado activo, campos de pausa limpios y resumed_at sellado', async () => {
    await seedPaused();
    expect(store.conversations[0].state).toBe('paused');

    const result = await resumeAgentConversation(PHONE, store, clock());

    expect(result).toEqual({
      result: 'ok',
      conversationId: 'conv-1',
      transition: 'resumed',
      controlEvent: 'inserted',
    });
    expect(store.conversations[0]).toMatchObject({
      state: 'active',
      paused_at: null,
      pause_expires_at: null,
      pause_reason: null,
      pause_source: null,
      resumed_at: '2026-08-14T11:00:00.000Z',
    });
  });

  it('registra el evento de control con acción, fuente y motivo canónicos', async () => {
    await seedPaused();

    await resumeAgentConversation(PHONE, store, clock());

    const resumeEvent = store.controlEvents.find((e) => e.action === 'resume')!;
    expect(resumeEvent).toEqual({
      agentConversationId: 'conv-1',
      action: 'resume',
      source: 'api', // ya existe en el enum de 0014: no hace falta migración
      reason: RESUME_REASON_MANUAL_API,
      providerMessageId: null, // un resume no responde a ningún mensaje
      metadata: { resumed_at: '2026-08-14T11:00:00.000Z' },
    });
    expect(RESUME_REASON_MANUAL_API).toMatch(/^[A-Za-z0-9._:-]{1,64}$/);
  });

  it('no toca los mensajes históricos', async () => {
    await seedPaused();
    const before = [...store.messages];

    await resumeAgentConversation(PHONE, store, clock());

    expect(store.messages).toEqual(before);
    expect(store.messages).toHaveLength(1);
    expect(store.messages[0]).toMatchObject({ actor: 'human', direction: 'outbound' });
  });

  it('no toca los eventos de pausa anteriores: el historial es append-only', async () => {
    await seedPaused();
    const pauseEvent = store.controlEvents.find((e) => e.action === 'pause');

    await resumeAgentConversation(PHONE, store, clock());

    expect(store.controlEvents).toHaveLength(2);
    expect(store.controlEvents[0]).toEqual(pauseEvent);
    expect(store.controlEvents[0]).toMatchObject({
      action: 'pause',
      source: 'business_app',
      reason: PAUSE_REASON_HUMAN_BUSINESS_APP,
    });
    expect(store.controlEvents[1].action).toBe('resume');
  });
});

describe('resume — idempotencia', () => {
  it('el reintento no reescribe resumed_at ni duplica el evento', async () => {
    await seedPaused();
    const now = clock();

    const first = await resumeAgentConversation(PHONE, store, now);
    const resumedAt = store.conversations[0].resumed_at;

    const second = await resumeAgentConversation(PHONE, store, now);

    expect(first).toMatchObject({ transition: 'resumed', controlEvent: 'inserted' });
    expect(second).toMatchObject({ transition: 'already_active', controlEvent: 'duplicate' });
    expect(store.conversations[0].resumed_at).toBe(resumedAt);
    expect(store.controlEvents.filter((e) => e.action === 'resume')).toHaveLength(1);
  });

  it('sobre una conversación ya activa no escribe nada', async () => {
    await seedPaused();
    const now = clock();
    await resumeAgentConversation(PHONE, store, now);
    const snapshot = { ...store.conversations[0] };
    const events = store.controlEvents.length;

    const again = await resumeAgentConversation(PHONE, store, now);

    expect(again).toMatchObject({ transition: 'already_active' });
    expect(store.conversations[0]).toEqual(snapshot);
    expect(store.controlEvents).toHaveLength(events);
  });

  it('una conversación que NUNCA se pausó no genera evento de resume', async () => {
    // Conversación creada por un mensaje del cliente, sin pausa jamás.
    await store.upsertConversation({
      customerPhone: PHONE,
      providerConversationId: null,
      providerPhoneNumberId: null,
    });

    const result = await resumeAgentConversation(PHONE, store, clock());

    expect(result).toMatchObject({ transition: 'already_active', controlEvent: 'duplicate' });
    expect(store.controlEvents).toHaveLength(0);
    expect(store.conversations[0].resumed_at).toBeNull();
  });

  it('si el evento de control se perdió, el reintento lo REPARA', async () => {
    // Estado tras un crash: la transición se hizo, el evento no llegó a escribirse.
    await seedPaused();
    const now = clock();
    await store.resumeConversation({
      agentConversationId: 'conv-1',
      resumedAt: '2026-08-14T09:30:00.000Z',
    });
    expect(store.controlEvents.filter((e) => e.action === 'resume')).toHaveLength(0);

    const result = await resumeAgentConversation(PHONE, store, now);

    // La idempotencia es por PASO: encontrar la transición ya hecha no aborta
    // la secuencia, se completa la escritura que faltaba.
    expect(result).toMatchObject({ transition: 'already_active', controlEvent: 'inserted' });
    const resumeEvents = store.controlEvents.filter((e) => e.action === 'resume');
    expect(resumeEvents).toHaveLength(1);
    // Y se registra con el resumed_at REAL guardado, no con el instante del reintento.
    expect(resumeEvents[0].metadata).toEqual({ resumed_at: '2026-08-14T09:30:00.000Z' });
    expect(store.conversations[0].resumed_at).toBe('2026-08-14T09:30:00.000Z');
  });
});

// ── Regresión del bug de serialización (microfase 6D.2F.2D.1) ───────────────

describe('resume — round-trip de timestamptz (bug real de producción)', () => {
  it('el doble reproduce el round-trip: mismo instante, texto distinto', async () => {
    // Sin esta premisa el resto del bloque no probaría nada. El fake ANTERIOR
    // devolvía la cadena idéntica y por eso el bug llegó a producción.
    await seedPaused();
    await resumeAgentConversation(PHONE, store, clock());

    const escrito = store.conversations[0].resumed_at!;
    const leido = (await store.findPauseStateByPhone(PHONE))!.resumedAt!;

    expect(leido).not.toBe(escrito); // texto distinto
    expect(new Date(leido).getTime()).toBe(new Date(escrito).getTime()); // mismo instante
    expect(escrito.endsWith('Z')).toBe(true);
    expect(leido.endsWith('+00:00')).toBe(true);
  });

  it('A · el segundo request detecta el duplicado pese a la serialización distinta', async () => {
    await seedPaused();
    const now = clock();

    const first = await resumeAgentConversation(PHONE, store, now);
    const second = await resumeAgentConversation(PHONE, store, now);

    expect(first).toMatchObject({ transition: 'resumed', controlEvent: 'inserted' });
    // Esto era `inserted` antes del fix: el bug exacto que vimos en producción.
    expect(second).toMatchObject({ transition: 'already_active', controlEvent: 'duplicate' });
    expect(store.controlEvents.filter((e) => e.action === 'resume')).toHaveLength(1);
  });

  it('B · la clave guardada en metadata es siempre la forma canónica', async () => {
    await seedPaused();
    const now = clock();
    await resumeAgentConversation(PHONE, store, now);
    // Un reintento que pasa por la rama de relectura no debe escribir otra forma.
    await resumeAgentConversation(PHONE, store, now);

    const keys = store.controlEvents
      .filter((e) => e.action === 'resume')
      .map((e) => (e.metadata as { resumed_at: string }).resumed_at);

    expect(keys).toHaveLength(1);
    expect(keys[0]).toBe(new Date(keys[0]).toISOString()); // canónica
    expect(keys[0]).toMatch(/Z$/);
  });

  it('C · el reintento no mueve resumed_at', async () => {
    await seedPaused();
    const now = clock();
    await resumeAgentConversation(PHONE, store, now);
    const resumedAt = store.conversations[0].resumed_at;

    await resumeAgentConversation(PHONE, store, now);
    await resumeAgentConversation(PHONE, store, now);

    expect(store.conversations[0].resumed_at).toBe(resumedAt);
  });

  it('E · tras reparar un evento perdido, el siguiente reintento ya es duplicate', async () => {
    await seedPaused();
    const now = clock();
    // Crash: transición hecha, evento nunca escrito.
    await store.resumeConversation({
      agentConversationId: 'conv-1',
      resumedAt: '2026-08-14T09:30:00.000Z',
    });

    const repair = await resumeAgentConversation(PHONE, store, now);
    const afterRepair = await resumeAgentConversation(PHONE, store, now);

    expect(repair).toMatchObject({ controlEvent: 'inserted' });
    expect(afterRepair).toMatchObject({ controlEvent: 'duplicate' });
    expect(store.controlEvents.filter((e) => e.action === 'resume')).toHaveLength(1);
  });

  it('H · un ciclo NUEVO no se deduplica contra el anterior', async () => {
    const now = clock();
    await seedPaused();
    await resumeAgentConversation(PHONE, store, now);
    const primerResume = store.conversations[0].resumed_at;

    // Segundo takeover real y segundo resume: es otra operación, no un reintento.
    await handleHumanTakeover(humanMessage({ providerMessageId: 'wamid.HUMAN_2' }), store);
    await resumeAgentConversation(PHONE, store, now);

    const resumeEvents = store.controlEvents.filter((e) => e.action === 'resume');
    expect(resumeEvents).toHaveLength(2);
    expect(store.conversations[0].resumed_at).not.toBe(primerResume);
    expect(store.controlEvents.map((e) => e.action)).toEqual([
      'pause',
      'resume',
      'pause',
      'resume',
    ]);
  });

  it('F/G · ni los mensajes ni el evento de pausa se ven afectados por los reintentos', async () => {
    await seedPaused();
    const now = clock();
    const mensajes = [...store.messages];
    const pausa = store.controlEvents.find((e) => e.action === 'pause');

    await resumeAgentConversation(PHONE, store, now);
    await resumeAgentConversation(PHONE, store, now);
    await resumeAgentConversation(PHONE, store, now);

    expect(store.messages).toEqual(mensajes);
    expect(store.controlEvents.find((e) => e.action === 'pause')).toEqual(pausa);
    expect(store.controlEvents.filter((e) => e.action === 'pause')).toHaveLength(1);
  });
});

describe('resume — aislamiento del resto del sistema', () => {
  it('el takeover humano jamás reanuda nada', async () => {
    await seedPaused();

    expect(store.calls).not.toContain('resumeConversation');
    expect(store.calls).not.toContain('hasResumeEvent');
  });

  it('el resume solo toca el control: ni mensajes, ni teléfono, ni conversación nueva', async () => {
    await seedPaused();
    const conversations = store.conversations.length;
    const messages = store.messages.length;

    await resumeAgentConversation(PHONE, store, clock());

    expect(store.conversations).toHaveLength(conversations);
    expect(store.messages).toHaveLength(messages);
    expect(store.conversations[0].customer_phone).toBe(PHONE);
    // Las marcas del historial no se tocan: reanudar no reescribe la memoria.
    expect(store.conversations[0].last_human_message_at).toBe('2026-08-14T10:00:00.000Z');
  });
});

describe('resume — rechazos deterministas', () => {
  it('sin conversación devuelve not_found y no crea ninguna', async () => {
    const result = await resumeAgentConversation('59100000000', store, clock());

    expect(result).toEqual({ result: 'not_found' });
    expect(store.conversations).toHaveLength(0);
    expect(store.controlEvents).toHaveLength(0);
  });

  it('sin teléfono no consulta siquiera la base', async () => {
    const result = await resumeAgentConversation('', store, clock());

    expect(result).toEqual({ result: 'rejected', reason: 'missing_phone' });
    expect(store.calls).toEqual([]);
  });
});

describe('resume — ciclo completo pausa → resume → pausa', () => {
  it('tras reanudar, un nuevo mensaje humano vuelve a pausar y deja su propio evento', async () => {
    await seedPaused();
    await resumeAgentConversation(PHONE, store, clock());
    expect(store.conversations[0].state).toBe('active');

    // Segundo takeover, con otro WAMID.
    await handleHumanTakeover(humanMessage({ providerMessageId: 'wamid.HUMAN_2' }), store);

    expect(store.conversations[0].state).toBe('paused');
    // 0014 no admite resumed_at en `paused`: la pausa lo limpia.
    expect(store.conversations[0].resumed_at).toBeNull();
    expect(store.conversations[0].pause_reason).toBe(PAUSE_REASON_HUMAN_BUSINESS_APP);
    // Historial completo: pause, resume, pause. Nada se sobrescribió.
    expect(store.controlEvents.map((e) => e.action)).toEqual(['pause', 'resume', 'pause']);
    expect(store.messages).toHaveLength(2);
  });

  it('se puede reanudar otra vez y el segundo resume es un evento distinto', async () => {
    const now = clock();
    await seedPaused();
    await resumeAgentConversation(PHONE, store, now);
    await handleHumanTakeover(humanMessage({ providerMessageId: 'wamid.HUMAN_2' }), store);

    await resumeAgentConversation(PHONE, store, now);

    const resumeEvents = store.controlEvents.filter((e) => e.action === 'resume');
    expect(resumeEvents).toHaveLength(2);
    // Cada uno lleva su propio resumed_at: son operaciones distintas.
    expect(resumeEvents[0].metadata).not.toEqual(resumeEvents[1].metadata);
  });
});
