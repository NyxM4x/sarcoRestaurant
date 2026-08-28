/**
 * Pausar el agente porque lo decide el SISTEMA — módulo PURO.
 *
 * Hasta ahora la única forma de callar al agente era que una persona escribiera
 * desde WhatsApp Business App (`takeover.ts`). Eso cubre "ya estoy yo", pero no
 * cubre los dos casos en que hay que callarlo sin que nadie haya escrito nada:
 *
 *   · el cliente trae una queja y hay que pasárselo a alguien;
 *   · acabamos de decidirle el pago y ese aviso abre una conversación que el
 *     agente no debe pisar.
 *
 * Toda la maquinaria ya existía —`pauseConversation` acepta cualquier `source`
 * del dominio, y `pause-gate.ts` está escrito a propósito SIN ramificar por
 * `pause_source`— pero no tenía un solo llamador. Esto es ese llamador.
 *
 * ── Por qué con vencimiento y no indefinida ─────────────────────────────────
 *
 * `pauseConversation` admite `null` = para siempre, y es tentador: una queja
 * grave no debería reactivarse sola. Pero hoy **el panel no tiene ninguna
 * pantalla para reanudar** —solo un endpoint interno con Bearer—, así que una
 * pausa indefinida que nadie levante deja a ese cliente sin agente para
 * siempre, y sin que nadie se entere. El vencimiento se limpia solo con
 * `resolveExpiredPause`, que ya existe y es perezoso: sin cron, que este
 * proyecto no puede tener.
 *
 * Es la misma lección que ya pagó `takeover.ts` y que documenta en su cabecera.
 *
 * ── La idempotencia, cuando hay WAMID y cuando no ───────────────────────────
 *
 * Con `sourceMessageId`, la barrera es la misma que usa el takeover: si ya hay
 * un evento de pausa para ese mensaje, esta ejecución no existe para el estado.
 * Es fiable porque el evento de control es la ÚLTIMA escritura de la secuencia.
 *
 * Sin WAMID —el caso del pago, que no nace de un mensaje del cliente— no hay
 * clave que mirar, y se acepta el mismo límite que `resume.ts` documenta para
 * su caso: duplicar una fila de auditoría es menos grave que perderla. La
 * protección real la da el guard por `state='active'` de `pauseConversation`,
 * que impide falsear `paused_at` en una segunda ejecución.
 */
import type { AgentStore } from '../core/types';
import type { AgentControlSource } from '@/types';
import { pauseExpiryFrom } from './takeover';

/** Qué disparó la pausa. Solo información estructural, para el historial. */
export type HandoffTrigger = 'agent_action' | 'menu_loop' | 'payment_review';

export interface PauseForHandoffInput {
  customerPhone: string;
  /** Motivo canónico: `[A-Za-z0-9._:-]{1,64}`. Ver `core/types.ts`. */
  reason: string;
  source: AgentControlSource;
  /**
   * WAMID que origina la derivación, o `null` cuando no nace de un mensaje.
   * Es la clave de idempotencia cuando existe.
   */
  sourceMessageId: string | null;
  /** Cuánto dura la pausa. */
  minutes: number;
  trigger: HandoffTrigger;
}

export type PauseForHandoffResult =
  | {
      result: 'ok';
      conversationId: string;
      /** `already_applied` = este mismo mensaje ya la había puesto. */
      pause: 'paused' | 'already_paused' | 'already_applied';
      pauseExpiresAt: string;
    }
  | { result: 'rejected'; reason: 'missing_phone' };

/**
 * Pausa la conversación de un cliente por decisión del sistema.
 *
 * No manda ningún mensaje: quien llama decide si además hay que decirle algo al
 * cliente, y lo hace por su cuenta. Aquí solo se calla al agente.
 */
export async function pauseAgentForHandoff(
  input: PauseForHandoffInput,
  store: AgentStore,
  now: () => string = () => new Date().toISOString(),
): Promise<PauseForHandoffResult> {
  // Sin teléfono no hay identidad durable que pausar.
  if (input.customerPhone.trim() === '') {
    return { result: 'rejected', reason: 'missing_phone' };
  }

  // El upsert es obligatorio, no una comodidad: un cliente que solo pidió por
  // la web puede no tener conversación todavía, y sin fila la pausa no
  // ocurriría — en silencio, que es como no ocurren las cosas importantes.
  const conversation = await store.upsertConversation({
    customerPhone: input.customerPhone,
    providerConversationId: null,
    providerPhoneNumberId: null,
  });

  const pausedAt = now();
  const pauseExpiresAt = pauseExpiryFrom(pausedAt, input.minutes);

  if (input.sourceMessageId !== null) {
    const yaAplicado = await store.hasPauseEventForMessage(
      conversation.id,
      input.sourceMessageId,
    );
    if (yaAplicado) {
      return {
        result: 'ok',
        conversationId: conversation.id,
        pause: 'already_applied',
        pauseExpiresAt,
      };
    }
  }

  const pause = await store.pauseConversation({
    agentConversationId: conversation.id,
    pausedAt,
    pauseExpiresAt,
    reason: input.reason,
    source: input.source,
  });

  // NO se renueva una pausa ya existente. A diferencia del takeover —donde cada
  // mensaje humano nuevo es una intervención nueva que merece reiniciar el
  // reloj—, aquí alargar el silencio no ayuda a nadie: si ya está pausada, ya
  // hay alguien a cargo o el plazo anterior sigue siendo el bueno.

  const controlEvent = await store.insertControlEvent({
    agentConversationId: conversation.id,
    action: 'pause',
    source: input.source,
    reason: input.reason,
    providerMessageId: input.sourceMessageId,
    expiresAt: pauseExpiresAt,
    // Solo información estructural. Nunca el texto del cliente ni su teléfono.
    metadata: { trigger: input.trigger },
  });
  void controlEvent;

  return { result: 'ok', conversationId: conversation.id, pause, pauseExpiresAt };
}
