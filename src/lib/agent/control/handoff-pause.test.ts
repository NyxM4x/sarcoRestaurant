import { describe, it, expect, beforeEach } from 'vitest';
import { pauseAgentForHandoff } from './handoff-pause';
import { isPauseActive } from './pause-gate';
import {
  PAUSE_REASON_HANDOFF_REQUESTED,
  PAUSE_REASON_PAYMENT_REVIEWED,
} from '@/lib/agent/core/types';
import type {
  AgentConversationRef,
  AgentStore,
  InsertControlEventInput,
  PauseConversationInput,
  PauseConversationResult,
  UpsertConversationInput,
} from '@/lib/agent/core/types';

/**
 * Doble mínimo de `AgentStore`, con las garantías que hacen segura la pausa:
 *
 *   · `agent_conversations.customer_phone`   UNIQUE (upsert, no insert)
 *   · la pausa está GUARDADA por `state='active'` — una segunda llamada no
 *     puede falsear `paused_at`
 *   · el evento de control es la marca durable por WAMID
 *
 * Un fake permisivo daría tests verdes sobre un sistema roto: es la pausa la
 * que impide que el agente hable encima de una persona.
 */
class FakeStore {
  conversations: Array<{ id: string; phone: string; state: 'active' | 'paused' }> = [];
  pauseEvents: InsertControlEventInput[] = [];
  pauses: PauseConversationInput[] = [];
  calls: string[] = [];
  private seq = 0;

  async upsertConversation(input: UpsertConversationInput): Promise<AgentConversationRef> {
    this.calls.push('upsertConversation');
    let row = this.conversations.find((c) => c.phone === input.customerPhone);
    if (!row) {
      row = { id: `conv-${++this.seq}`, phone: input.customerPhone, state: 'active' };
      this.conversations.push(row);
    }
    return { id: row.id, state: row.state } as AgentConversationRef;
  }

  async hasPauseEventForMessage(convId: string, wamid: string): Promise<boolean> {
    this.calls.push('hasPauseEventForMessage');
    return this.pauseEvents.some(
      (e) => e.agentConversationId === convId && e.providerMessageId === wamid,
    );
  }

  async pauseConversation(input: PauseConversationInput): Promise<PauseConversationResult> {
    this.calls.push('pauseConversation');
    const row = this.conversations.find((c) => c.id === input.agentConversationId)!;
    // Guard real de 0014: solo pausa lo que está activo.
    if (row.state !== 'active') return 'already_paused';
    row.state = 'paused';
    this.pauses.push(input);
    return 'paused';
  }

  async insertControlEvent(input: InsertControlEventInput) {
    this.calls.push('insertControlEvent');
    this.pauseEvents.push(input);
    return 'inserted' as const;
  }
}

const store = () => new FakeStore() as unknown as FakeStore & AgentStore;
const NOW = '2026-08-28T22:00:00.000Z';
const reloj = () => NOW;

let s: FakeStore & AgentStore;
beforeEach(() => {
  s = store();
});

const derivacion = (over: Record<string, unknown> = {}) => ({
  customerPhone: '59171234567',
  reason: PAUSE_REASON_HANDOFF_REQUESTED,
  source: 'system' as const,
  sourceMessageId: 'wamid.ABC',
  minutes: 120,
  trigger: 'agent_action' as const,
  ...over,
});

describe('pausa del sistema — el caso normal', () => {
  it('pausa la conversación y deja el evento de control', async () => {
    const res = await pauseAgentForHandoff(derivacion(), s, reloj);
    expect(res).toMatchObject({ result: 'ok', pause: 'paused' });
    expect(s.pauses).toHaveLength(1);
    expect(s.pauseEvents).toHaveLength(1);
  });

  it('el evento de control es la ÚLTIMA escritura', async () => {
    // De eso depende la idempotencia: si el evento existe, todo lo anterior
    // ocurrió. Invertir el orden convertiría la barrera en una mentira.
    await pauseAgentForHandoff(derivacion(), s, reloj);
    expect(s.calls[s.calls.length - 1]).toBe('insertControlEvent');
  });

  it('la pausa resultante SÍ retiene al agente', async () => {
    // Se comprueba contra la misma función que usan las barreras del turno, no
    // contra el estado interno del doble.
    const res = await pauseAgentForHandoff(derivacion(), s, reloj);
    if (res.result !== 'ok') throw new Error('debía pausar');
    const estado = {
      conversationId: res.conversationId,
      state: 'paused' as const,
      pausedAt: NOW,
      pauseExpiresAt: res.pauseExpiresAt,
      pauseReason: PAUSE_REASON_HANDOFF_REQUESTED,
      pauseSource: 'system' as const,
      resumedAt: null,
    };
    expect(isPauseActive(estado, NOW)).toBe(true);
  });

  it('crea la conversación si el cliente no tenía ninguna', async () => {
    // Un cliente que solo pidió por la web puede no tener fila. Sin upsert, la
    // pausa no ocurriría — y en silencio.
    await pauseAgentForHandoff(derivacion(), s, reloj);
    expect(s.conversations).toHaveLength(1);
  });

  it('el motivo y el disparador quedan en el historial, sin datos del cliente', async () => {
    await pauseAgentForHandoff(derivacion(), s, reloj);
    const evento = s.pauseEvents[0];
    expect(evento.reason).toBe(PAUSE_REASON_HANDOFF_REQUESTED);
    expect(evento.metadata).toEqual({ trigger: 'agent_action' });
    // Nunca el teléfono ni el texto: el historial de control es estructural.
    expect(JSON.stringify(evento)).not.toContain('59171234567');
  });
});

describe('pausa del sistema — idempotencia', () => {
  it('el mismo mensaje no vuelve a pausar, y NO escribe nada', async () => {
    await pauseAgentForHandoff(derivacion(), s, reloj);
    const escriturasAntes = s.pauses.length + s.pauseEvents.length;

    const segunda = await pauseAgentForHandoff(derivacion(), s, reloj);
    expect(segunda).toMatchObject({ result: 'ok', pause: 'already_applied' });
    expect(s.pauses.length + s.pauseEvents.length).toBe(escriturasAntes);
  });

  it('sin WAMID no hay barrera, pero el guard impide falsear la pausa', async () => {
    // Es el caso del pago: no nace de un mensaje del cliente. Se acepta duplicar
    // una fila de auditoría —menos grave que perderla— pero `paused_at` no se
    // toca dos veces.
    const pago = derivacion({
      sourceMessageId: null,
      reason: PAUSE_REASON_PAYMENT_REVIEWED,
      source: 'dashboard',
      trigger: 'payment_review',
      minutes: 180,
    });
    expect(await pauseAgentForHandoff(pago, s, reloj)).toMatchObject({ pause: 'paused' });
    expect(await pauseAgentForHandoff(pago, s, reloj)).toMatchObject({ pause: 'already_paused' });
    expect(s.pauses).toHaveLength(1);
  });

  it('una conversación ya pausada por otro motivo no se pisa', async () => {
    // El takeover humano manda: si alguien ya está atendiendo, el sistema no le
    // reescribe el motivo ni le mueve el reloj.
    await pauseAgentForHandoff(derivacion(), s, reloj);
    const otra = await pauseAgentForHandoff(
      derivacion({ sourceMessageId: 'wamid.OTRO', reason: PAUSE_REASON_PAYMENT_REVIEWED }),
      s,
      reloj,
    );
    expect(otra).toMatchObject({ pause: 'already_paused' });
    expect(s.pauses).toHaveLength(1);
    expect(s.pauses[0].reason).toBe(PAUSE_REASON_HANDOFF_REQUESTED);
  });
});

describe('pausa del sistema — lo que rechaza', () => {
  it('sin teléfono no hay nada que pausar', async () => {
    for (const phone of ['', '   ']) {
      const res = await pauseAgentForHandoff(derivacion({ customerPhone: phone }), s, reloj);
      expect(res, JSON.stringify(phone)).toEqual({ result: 'rejected', reason: 'missing_phone' });
    }
    expect(s.calls).toEqual([]);
  });
});

describe('pausa del sistema — el vencimiento', () => {
  it('el plazo sale de los minutos que se le pasen', async () => {
    const res = await pauseAgentForHandoff(derivacion({ minutes: 120 }), s, reloj);
    if (res.result !== 'ok') throw new Error('debía pausar');
    expect(res.pauseExpiresAt).toBe('2026-08-29T00:00:00.000Z');
  });

  it('vencida, deja de retener sola', async () => {
    // Es la razón de no usar pausa indefinida: hoy el panel no tiene ninguna
    // pantalla para reanudar, así que una pausa que nadie levante dejaría a ese
    // cliente sin agente para siempre.
    const res = await pauseAgentForHandoff(derivacion({ minutes: 120 }), s, reloj);
    if (res.result !== 'ok') throw new Error('debía pausar');
    const estado = {
      conversationId: res.conversationId,
      state: 'paused' as const,
      pausedAt: NOW,
      pauseExpiresAt: res.pauseExpiresAt,
      pauseReason: PAUSE_REASON_HANDOFF_REQUESTED,
      pauseSource: 'system' as const,
      resumedAt: null,
    };
    expect(isPauseActive(estado, '2026-08-29T00:00:01.000Z')).toBe(false);
  });
});
