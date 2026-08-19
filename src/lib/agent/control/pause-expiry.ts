import { RESUME_REASON_TAKEOVER_EXPIRED, type AgentStore } from '@/lib/agent/core/types';
import { isPauseExpired } from './pause-gate';
import { resumeAgentConversation, type ResumeAttribution } from './resume';

/**
 * Normalización PEREZOSA de una pausa vencida — módulo PURO (Fase 6D.2F.5C.1).
 *
 * ── Por qué no hay cron ─────────────────────────────────────────────────────
 *
 * Una pausa vencida no le hace nada a nadie mientras nadie escriba. El único
 * momento en que importa es cuando llega un mensaje del cliente, y en ese
 * momento ya estamos ejecutando código: barrer la base cada minuto buscando
 * pausas caducadas sería un servicio entero para adelantar un trabajo que
 * igualmente hay que hacer al recibir el mensaje.
 *
 * Así que se resuelve al vuelo, y el coste es una lectura que ya se hacía.
 *
 * ── Por qué se escribe, y no solo se ignora la pausa ────────────────────────
 *
 * Bastaría con que las barreras trataran la pausa vencida como inactiva —lo
 * hacen, vía `isPauseActive`— y la fila podría quedarse diciendo `paused` para
 * siempre. Pero entonces la base mentiría: el panel mostraría una conversación
 * pausada que en realidad está siendo atendida por el agente, y no quedaría
 * constancia de cuándo volvió el control.
 *
 * Reanudar de verdad arregla las dos cosas y no cuesta nada nuevo: es el MISMO
 * `resumeAgentConversation` del endpoint interno, con otra atribución. Un solo
 * mecanismo para devolver el control, con dos motivos distintos.
 *
 * ── Concurrencia ────────────────────────────────────────────────────────────
 *
 * La transición está guardada por `state='paused'`, así que si dos mensajes
 * llegan a la vez solo una ejecución la gana; la otra recibe `already_active` y
 * no reescribe `resumed_at`. El evento de control se protege aparte, por su
 * clave `metadata.resumed_at`.
 *
 * ── Qué NO expira ───────────────────────────────────────────────────────────
 *
 * Una pausa sin `pause_expires_at` es indefinida y aquí no se toca nunca. Esa es
 * toda la separación que hace falta entre el takeover temporal y un futuro "IA
 * OFF" explícito del panel: la diferencia está en el dato, no en una rama de
 * código que haya que acordarse de mantener.
 */

/** Resume automático por vencimiento del plazo. Lo hace el sistema, no una persona. */
export const EXPIRED_TAKEOVER_RESUME: ResumeAttribution = {
  source: 'system',
  reason: RESUME_REASON_TAKEOVER_EXPIRED,
};

export type PauseExpiryOutcome =
  /** No estaba pausada, o su pausa sigue vigente. No se escribió nada. */
  | 'not_expired'
  /** Estaba vencida y esta ejecución devolvió el control. */
  | 'resumed'
  /** Estaba vencida y otra ejecución se adelantó. También queda activa. */
  | 'already_active'
  /** No existe conversación para ese teléfono. */
  | 'no_conversation';

/**
 * Si la pausa de este teléfono venció, devuelve el control al agente.
 *
 * Es idempotente y seguro de llamar en cada mensaje: cuando no hay nada que
 * expirar cuesta una lectura y no escribe.
 */
export async function resolveExpiredPause(
  customerPhone: string,
  store: AgentStore,
  now: () => string = () => new Date().toISOString(),
): Promise<PauseExpiryOutcome> {
  if (customerPhone === '') return 'no_conversation';

  const state = await store.findPauseStateByPhone(customerPhone);
  if (state === null) return 'no_conversation';
  if (!isPauseExpired(state, now())) return 'not_expired';

  const result = await resumeAgentConversation(
    customerPhone,
    store,
    now,
    EXPIRED_TAKEOVER_RESUME,
  );

  if (result.result !== 'ok') return 'no_conversation';
  return result.transition === 'resumed' ? 'resumed' : 'already_active';
}
