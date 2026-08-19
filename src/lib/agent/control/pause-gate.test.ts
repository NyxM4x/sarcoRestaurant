import { describe, it, expect } from 'vitest';
import {
  getConversationPauseState,
  isAgentConversationActive,
  isAgentConversationPaused,
  isPauseActive,
  isPauseExpired,
} from './pause-gate';
import { PAUSE_REASON_HUMAN_BUSINESS_APP } from '@/lib/agent/core/types';
import type { AgentPauseState, AgentStore } from '@/lib/agent/core/types';
import type { AgentConversationState } from '@/types';

/**
 * Barreras de pausa (Fase 6D.2F.2B) — primitivas puras.
 *
 * Lo que se congela aquí es la SEMÁNTICA que consumirá el Agent Core de 6D.2F.3.
 * En esta fase no hay OpenAI, así que la pausa todavía no impide nada: no debe
 * impedirlo nunca para los flujos determinísticos (TESTMENU9842, isMenuIntent,
 * ubicación, nfm_reply, delivery dinámico, QR/efectivo, notificaciones), que ni
 * siquiera pasan por este módulo.
 */

function state(over: Partial<AgentPauseState> = {}): AgentPauseState {
  return {
    conversationId: 'conv-1',
    state: 'active' as AgentConversationState,
    pausedAt: null,
    pauseExpiresAt: null,
    pauseReason: null,
    pauseSource: null,
    resumedAt: null,
    ...over,
  };
}

function paused(over: Partial<AgentPauseState> = {}): AgentPauseState {
  return state({
    state: 'paused',
    pausedAt: '2026-08-13T10:00:00.000Z',
    pauseReason: PAUSE_REASON_HUMAN_BUSINESS_APP,
    pauseSource: 'business_app',
    ...over,
  });
}

describe('pause-gate — lectura del estado', () => {
  it('active => el agente puede actuar', () => {
    expect(isAgentConversationActive(state())).toBe(true);
    expect(isAgentConversationPaused(state())).toBe(false);
  });

  it('paused indefinida (expires_at NULL) => el agente NO puede actuar', () => {
    expect(isAgentConversationActive(paused())).toBe(false);
    expect(isAgentConversationPaused(paused())).toBe(true);
  });

  it('paused temporal aún no vencida => el agente NO puede actuar', () => {
    const temporal = paused({
      pauseExpiresAt: '2999-01-01T00:00:00.000Z',
      pauseReason: 'manual_dashboard',
      pauseSource: 'dashboard',
    });

    expect(isAgentConversationActive(temporal)).toBe(false);
  });

  it('paused temporal ya vencida sigue pausada: no hay auto-resume aquí', () => {
    // Semántica congelada: quien reanuda es un acto explícito que escribe
    // state='active' + resumed_at y deja rastro en agent_control_events. Este
    // módulo NO inventa una reanudación implícita por leer un reloj, porque
    // entonces la reanudación no quedaría registrada en ningún sitio.
    const vencida = paused({
      pauseExpiresAt: '2000-01-01T00:00:00.000Z',
      pauseReason: 'manual_dashboard',
      pauseSource: 'dashboard',
    });

    expect(isAgentConversationActive(vencida)).toBe(false);
  });

  it('una conversación desconocida NO es una pausa: cliente nuevo, agente activo', () => {
    expect(isAgentConversationActive(null)).toBe(true);
    expect(isAgentConversationPaused(null)).toBe(false);
  });

  it('la pausa no depende del motivo ni de la fuente, solo del state', () => {
    for (const source of ['business_app', 'dashboard', 'api', 'system'] as const) {
      expect(isAgentConversationPaused(paused({ pauseSource: source }))).toBe(true);
    }
  });
});

describe('pause-gate — consulta por teléfono', () => {
  function storeWith(result: AgentPauseState | null, seen: string[] = []): AgentStore {
    return {
      findPauseStateByPhone: async (phone: string) => {
        seen.push(phone);
        return result;
      },
    } as unknown as AgentStore;
  }

  it('devuelve el estado guardado del teléfono', async () => {
    const found = await getConversationPauseState('59170000001', storeWith(paused()));

    expect(found).toMatchObject({ state: 'paused', pauseSource: 'business_app' });
    expect(isAgentConversationPaused(found)).toBe(true);
  });

  it('null cuando el cliente aún no tiene conversación', async () => {
    expect(await getConversationPauseState('59170000002', storeWith(null))).toBeNull();
  });

  it('sin teléfono no consulta la base: no hay identidad que buscar', async () => {
    const seen: string[] = [];
    expect(await getConversationPauseState('', storeWith(paused(), seen))).toBeNull();
    expect(seen).toEqual([]);
  });
});

// ── 6D.2F.5C.1: la pausa VENCE ──────────────────────────────────────────────

/**
 * `state` cuenta lo que se escribió; `isPauseActive` cuenta lo que RIGE.
 *
 * La diferencia importa porque desde 5C.1 el takeover trae vencimiento: una
 * fila puede decir `paused` y su plazo haber pasado hace media hora.
 */

const AHORA = '2026-08-13T10:20:00.000Z';

describe('pause-gate — vencimiento', () => {
  it('una pausa con plazo POR VENIR retiene al agente', () => {
    const s = paused({ pauseExpiresAt: '2026-08-13T10:30:00.000Z' });

    expect(isPauseActive(s, AHORA)).toBe(true);
    expect(isPauseExpired(s, AHORA)).toBe(false);
  });

  it('una pausa con plazo YA PASADO no retiene a nadie', () => {
    const s = paused({ pauseExpiresAt: '2026-08-13T10:10:00.000Z' });

    expect(isPauseActive(s, AHORA)).toBe(false);
    // Pero la fila SIGUE diciendo `paused`: por eso hace falta normalizarla.
    expect(isAgentConversationPaused(s)).toBe(true);
    expect(isPauseExpired(s, AHORA)).toBe(true);
  });

  it('el instante exacto del vencimiento ya NO retiene', () => {
    // `>` y no `>=`: a las 10:20:00 en punto, un plazo que vencía a las 10:20:00
    // se acabó. Da igual para el negocio, pero el criterio tiene que ser uno.
    const s = paused({ pauseExpiresAt: AHORA });

    expect(isPauseActive(s, AHORA)).toBe(false);
  });

  it('una pausa SIN plazo es indefinida y no vence nunca', () => {
    // Es toda la separación entre el takeover temporal y un "IA OFF" explícito:
    // está en el DATO, no en una rama de código que haya que mantener.
    const s = paused({ pauseExpiresAt: null });

    expect(isPauseActive(s, AHORA)).toBe(true);
    expect(isPauseActive(s, '2099-01-01T00:00:00.000Z')).toBe(true);
    expect(isPauseExpired(s, '2099-01-01T00:00:00.000Z')).toBe(false);
  });

  it('una conversación activa nunca está retenida, tenga lo que tenga', () => {
    expect(isPauseActive(state(), AHORA)).toBe(false);
    expect(isPauseActive(null, AHORA)).toBe(false);
    expect(isPauseExpired(null, AHORA)).toBe(false);
  });

  it('ante una fecha ILEGIBLE, la pausa se considera vigente', () => {
    // Fail-closed. Callarse de más cuesta un mensaje que no se manda; hablar de
    // más interrumpe a la persona que está atendiendo al cliente.
    expect(isPauseActive(paused({ pauseExpiresAt: 'mañana' }), AHORA)).toBe(true);
    expect(isPauseActive(paused({ pauseExpiresAt: '' }), AHORA)).toBe(true);
    expect(isPauseActive(paused({ pauseExpiresAt: '2026-08-13T10:30:00.000Z' }), 'ayer')).toBe(true);
  });

  it('los dos predicados son complementarios sobre una pausa escrita', () => {
    for (const expires of [
      '2026-08-13T10:30:00.000Z',
      '2026-08-13T10:10:00.000Z',
      null,
    ]) {
      const s = paused({ pauseExpiresAt: expires });
      expect(isPauseActive(s, AHORA)).toBe(!isPauseExpired(s, AHORA));
    }
  });
});
