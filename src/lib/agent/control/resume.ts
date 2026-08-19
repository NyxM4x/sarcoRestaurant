import type { AgentControlSource } from '@/types';
import {
  RESUME_REASON_MANUAL_API,
  type AgentStore,
  type InsertControlEventResult,
  type ResumeAgentResult,
} from '@/lib/agent/core/types';

/**
 * A quién se atribuye el resume en el historial de control (Fase 6D.2F.5C.1).
 *
 * El MECANISMO de devolver el control es siempre el mismo —y por eso hay una
 * sola función—, pero el motivo no: alguien lo pidió por la API, o venció el
 * plazo de un takeover. En `agent_control_events` tienen que poder distinguirse.
 */
export interface ResumeAttribution {
  source: AgentControlSource;
  /** Formato `[A-Za-z0-9._:-]{1,64}`, que es lo que admite 0014. */
  reason: string;
}

/** Resume pedido a mano por la API interna. */
export const MANUAL_API_RESUME: ResumeAttribution = {
  source: 'api',
  reason: RESUME_REASON_MANUAL_API,
};

/**
 * Resume de una conversación pausada — lógica PURA sobre un `AgentStore`
 * inyectado (microfase de control, posterior a 6D.2F.2C).
 *
 * Es la contraparte legítima y auditable del takeover humano: devuelve el
 * control al agente dejando rastro, en vez de un UPDATE a mano en la base.
 *
 * Secuencia:
 *   1. localizar la conversación por teléfono (identidad durable)
 *   2. transición condicional `paused → active`, que limpia TODOS los campos de
 *      pausa y sella `resumed_at`
 *   3. registrar el evento de control `resume`
 *
 * NO borra mensajes ni eventos de control anteriores: la historia de pausas es
 * append-only y vive entera en `agent_control_events`.
 *
 * ── Idempotencia ───────────────────────────────────────────────────────────
 * Un resume no tiene WAMID, así que no puede apoyarse en el UNIQUE parcial que
 * hace idempotente la pausa. La identidad de la operación es `resumed_at`: 0014
 * solo permite ese campo poblado mientras la conversación está `active`, de modo
 * que su valor identifica de forma única el último resume. El evento de control
 * lo guarda en `metadata.resumed_at` y aquí se comprueba antes de insertar.
 *
 * Eso da las dos mitades que hacen falta:
 *   · un reintento NO duplica el evento (ya existe uno con ese `resumed_at`);
 *   · un reintento SÍ repara el evento que faltase, porque la comprobación se
 *     hace también cuando la conversación ya estaba activa. La idempotencia es
 *     por paso, igual que en el takeover: nunca se abandona la secuencia por
 *     haber encontrado un paso ya hecho.
 *
 * Toda comparación de esa clave se hace en forma CANÓNICA (`toISOString()`).
 * Ver el comentario de `effectiveResumedAt`: no hacerlo fue un bug real de
 * producción, porque `metadata` guarda texto y la columna vuelve de Postgres
 * con otra serialización del mismo instante.
 *
 * Límite conocido y aceptado, DISTINTO de aquel bug: dos ejecuciones
 * EXACTAMENTE simultáneas podrían comprobar a la vez y escribir dos eventos
 * idénticos. Aquello fallaba siempre en cualquier reintento secuencial; esto
 * requiere una carrera real. No hay índice al que agarrarse sin una migración
 * nueva, y el intercambio es deliberado: duplicar una fila de auditoría es
 * mucho menos grave que perderla. El estado de la conversación nunca es
 * ambiguo, porque esa transición sí es atómica.
 */
export async function resumeAgentConversation(
  customerPhone: string,
  store: AgentStore,
  now: () => string = () => new Date().toISOString(),
  attribution: ResumeAttribution = MANUAL_API_RESUME,
): Promise<ResumeAgentResult> {
  if (customerPhone === '') {
    return { result: 'rejected', reason: 'missing_phone' };
  }

  const before = await store.findPauseStateByPhone(customerPhone);
  // Sin conversación no hay nada que reanudar. NO se crea una: el resume opera
  // sobre historia existente, nunca la inventa.
  if (before === null) {
    return { result: 'not_found' };
  }

  const resumedAt = now();
  const transition = await store.resumeConversation({
    agentConversationId: before.conversationId,
    resumedAt,
  });

  // Si esta ejecución no ganó la transición, el `resumed_at` bueno es el que ya
  // está guardado. Se relee porque el estado leído al principio puede haber
  // quedado obsoleto (otra ejecución pudo reanudarla entremedio).
  //
  // CANONICALIZACIÓN OBLIGATORIA: el valor releído viene de una columna
  // `timestamptz`, y Postgres lo serializa distinto a como lo escribió
  // JavaScript — `…+00:00` frente a `…Z`. Como la clave del evento vive en
  // `metadata` (jsonb), la comparación posterior es TEXTO contra TEXTO, sin
  // ninguna coerción que iguale las dos formas. Sin este `toISOString()` el
  // mismo instante parece dos claves distintas y cada reintento insertaba otro
  // evento de auditoría. Se detectó en producción, no en los tests.
  let effectiveResumedAt: string | null;
  if (transition === 'resumed') {
    // Generado aquí mismo: ya está en forma canónica.
    effectiveResumedAt = resumedAt;
  } else {
    const after = await store.findPauseStateByPhone(customerPhone);
    effectiveResumedAt = after?.resumedAt ? new Date(after.resumedAt).toISOString() : null;
  }

  // Una conversación activa que nunca se pausó no tiene `resumed_at` y tampoco
  // tiene nada que registrar: no ha ocurrido ningún cambio de control.
  let controlEvent: InsertControlEventResult = 'duplicate';
  if (effectiveResumedAt !== null) {
    const alreadyRegistered = await store.hasResumeEvent(
      before.conversationId,
      effectiveResumedAt,
    );
    if (!alreadyRegistered) {
      controlEvent = await store.insertControlEvent({
        agentConversationId: before.conversationId,
        action: 'resume',
        source: attribution.source,
        reason: attribution.reason,
        // Un resume no responde a ningún mensaje del proveedor.
        providerMessageId: null,
        metadata: { resumed_at: effectiveResumedAt },
      });
    }
  }

  return {
    result: 'ok',
    conversationId: before.conversationId,
    transition,
    controlEvent,
  };
}
