import type { AgentPauseState, AgentStore } from '@/lib/agent/core/types';

/**
 * Barreras de pausa del Agent Core — primitivas PURAS (Fase 6D.2F.2B).
 *
 * En esta fase todavía NO existe OpenAI, así que aquí no se llama a ningún
 * modelo ni se envía nada. Lo que queda fijado es el CONTRATO que consumirán
 * las dos barreras de 6D.2F.3:
 *
 *   Barrera #1 — antes de arrancar una ejecución cara (OpenAI).
 *   Barrera #2 — inmediatamente antes de CUALQUIER efecto comunicacional de IA.
 *
 * Aviso para quien implemente la barrera #2: una lectura seguida de un envío
 * deja una ventana en la que un humano puede tomar el control. La barrera #2
 * deberá ser una escritura condicional sobre `agent_runs`
 * (`... where status='processing' and exists(conversación active)`), no una
 * simple lectura. Estas primitivas sirven para la barrera #1 y para diagnóstico.
 *
 * IMPORTANTE: la pausa es SOLO del Agent Core. Las comunicaciones
 * determinísticas del sistema (confirmación de pedido, solicitud de ubicación,
 * QR, CTA del menú) no pasan por aquí y deben seguir saliendo con normalidad
 * aunque un humano esté atendiendo la conversación.
 */

/** `true` si el agente puede actuar. Una conversación desconocida está activa. */
export function isAgentConversationActive(state: AgentPauseState | null): boolean {
  if (state === null) return true;
  return state.state === 'active';
}

/** `true` si un humano (o el panel/API) tiene el control. */
export function isAgentConversationPaused(state: AgentPauseState | null): boolean {
  return !isAgentConversationActive(state);
}

/**
 * ¿La pausa RETIENE al agente en este instante? (Fase 6D.2F.5C.1)
 *
 * Es la pregunta que hacen las dos barreras, y no es la misma que
 * `isAgentConversationPaused`: una fila puede decir `paused` y su vencimiento
 * haber pasado ya. `state` cuenta lo que se escribió; esto cuenta lo que rige.
 *
 * ── Lo que distingue una pausa de otra es el VENCIMIENTO, no su origen ──────
 *
 *   pause_expires_at poblado → temporal. Vence sola.
 *   pause_expires_at NULL    → INDEFINIDA. Solo un resume explícito la levanta.
 *
 * Por eso aquí no hay ninguna rama por `pause_source`. El takeover desde
 * WhatsApp Business App trae vencimiento; un "IA OFF" desde el panel no lo
 * traería, y por eso nunca expiraría — sin que este archivo tenga que saber que
 * el panel existe.
 *
 * ── Fail-closed ante una fecha ilegible ─────────────────────────────────────
 *
 * Si `pause_expires_at` no se puede interpretar, se considera que la pausa SIGUE
 * vigente. Ante la duda, el agente se calla: el coste de callarse de más es un
 * mensaje que no se manda; el de hablar de más es interrumpir a la persona que
 * está atendiendo al cliente.
 */
export function isPauseActive(state: AgentPauseState | null, nowIso: string): boolean {
  if (state === null || state.state !== 'paused') return false;
  if (state.pauseExpiresAt === null) return true;

  const expires = Date.parse(state.pauseExpiresAt);
  if (Number.isNaN(expires)) return true;

  const now = Date.parse(nowIso);
  if (Number.isNaN(now)) return true;

  return expires > now;
}

/**
 * ¿Es una pausa que YA venció y sigue escrita como `paused`?
 *
 * Solo en ese caso hay que normalizar la fila. Una pausa vigente no se toca, y
 * una conversación activa no tiene nada que normalizar.
 */
export function isPauseExpired(state: AgentPauseState | null, nowIso: string): boolean {
  return isAgentConversationPaused(state) && !isPauseActive(state, nowIso);
}

/**
 * Estado de control de la conversación de un teléfono, o `null` si todavía no
 * existe conversación. La ausencia NO es una pausa: un cliente nuevo puede ser
 * atendido por el agente.
 */
export async function getConversationPauseState(
  customerPhone: string,
  store: AgentStore,
): Promise<AgentPauseState | null> {
  if (customerPhone === '') return null;
  return store.findPauseStateByPhone(customerPhone);
}
