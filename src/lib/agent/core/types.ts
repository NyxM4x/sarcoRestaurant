import type { ProvenanceContentType, ProvenanceMessage } from '@/lib/kapso/channel/provenance';
import type { ContextMessage } from './context';
import type { AgentEligibility } from './eligibility';
import type {
  AgentControlAction,
  AgentControlSource,
  AgentConversationState,
  AgentMessageActor,
  AgentMessageDirection,
  AgentMessageRole,
  AgentRunBarrier,
  AgentRunStatus,
} from '@/types';

/**
 * Contratos del Agent Core (Fase 6D.2F.2B) — módulo de tipos PURO.
 *
 * El core no conoce Supabase ni Kapso: recibe un `AgentStore` inyectado. Eso
 * permite probar takeover, persistencia y pausa sin base de datos, igual que
 * hace el resto del repositorio con `WebhookEventStore` u `OutboundReconciliationStore`.
 */

/** Motivo canónico de la pausa por respuesta humana desde WhatsApp Business App. */
export const PAUSE_REASON_HUMAN_BUSINESS_APP = 'human_whatsapp_business_app';

/**
 * Motivo canónico del resume manual por la API interna. Respeta el formato que
 * exige `agent_control_events_reason_format` en 0014: `[A-Za-z0-9._:-]{1,64}`.
 */
export const RESUME_REASON_MANUAL_API = 'manual_api_resume';

/**
 * Motivo del resume AUTOMÁTICO cuando vence una pausa temporal (6D.2F.5C.1).
 *
 * Se distingue del manual a propósito: en el historial de control tiene que
 * poder leerse si el control volvió porque alguien lo devolvió o porque se
 * acabó el tiempo. Mismo formato `[A-Za-z0-9._:-]{1,64}` que exige 0014.
 */
export const RESUME_REASON_TAKEOVER_EXPIRED = 'human_takeover_expired';

export interface AgentConversationRef {
  id: string;
  state: AgentConversationState;
}

/** Estado de control actual. `agent_control_events` guarda el historial. */
export interface AgentPauseState {
  conversationId: string;
  state: AgentConversationState;
  pausedAt: string | null;
  pauseExpiresAt: string | null;
  pauseReason: string | null;
  pauseSource: string | null;
  /**
   * Instante del último resume, o `null` si nunca se reanudó. 0014 solo lo
   * permite poblado mientras la conversación está `active`, así que identifica
   * de forma única la ÚLTIMA operación de resume: es la clave de idempotencia
   * del historial de control, que para un resume no tiene WAMID.
   */
  resumedAt: string | null;
}

export interface UpsertConversationInput {
  /** Identidad durable: dígitos, ya normalizados. */
  customerPhone: string;
  /** Referencia técnica volátil del proveedor. `null` = no sobrescribir. */
  providerConversationId: string | null;
  /** Número del negocio por el que responder. `null` = no sobrescribir. */
  providerPhoneNumberId: string | null;
}

export interface InsertAgentMessageInput {
  agentConversationId: string;
  providerMessageId: string | null;
  providerConversationId: string | null;
  direction: AgentMessageDirection;
  role: AgentMessageRole;
  actor: AgentMessageActor;
  content: string | null;
  contentType: ProvenanceContentType;
  metadata: Record<string, unknown> | null;
  /** ISO 8601. El fallback a "ahora" se decide en el core, nunca en la base. */
  messageTimestamp: string;
}

/** Una reentrega del mismo wamid es `duplicate`, jamás un error. */
export type InsertMessageResult = 'inserted' | 'duplicate';

export interface PauseConversationInput {
  agentConversationId: string;
  pausedAt: string;
  /**
   * Instante en que la pausa deja de retener al agente. `null` = INDEFINIDA,
   * y entonces solo un resume explícito devuelve el control.
   *
   * Es lo que separa las dos clases de pausa sin que nadie tenga que mirar el
   * origen: un takeover desde WhatsApp Business App trae vencimiento; un "IA
   * OFF" desde el panel no lo traería.
   */
  pauseExpiresAt: string | null;
  reason: string;
  source: AgentControlSource;
}

/** `already_paused` = la conversación ya estaba pausada; no se toca `paused_at`. */
export type PauseConversationResult = 'paused' | 'already_paused';

/**
 * Renovación del vencimiento de una pausa YA vigente (Fase 6D.2F.5C.1).
 *
 * Es una operación distinta de `pauseConversation` porque toca un campo
 * distinto y tiene otro guard: aquella entra solo desde `active` —para no
 * falsear `paused_at`, que marca el inicio del takeover— y esta solo desde
 * `paused`. Mezclarlas obligaría a una a mentir sobre cuándo empezó todo.
 */
export interface RenewPauseInput {
  agentConversationId: string;
  /** Nuevo vencimiento. El `paused_at` original NO se toca. */
  pauseExpiresAt: string;
  /**
   * Solo se renueva si la pausa vigente es de ESTE tipo. Sin este guard, un
   * mensaje desde WhatsApp Business App podría convertir un "IA OFF" indefinido
   * del panel en una pausa de treinta minutos, debilitando en silencio una
   * decisión explícita de alguien.
   */
  reason: string;
  source: AgentControlSource;
}

/**
 * `renewed`       el vencimiento se movió hacia adelante.
 * `not_extended`  la pausa es renovable, pero ya vencía DESPUÉS: no se acorta.
 * `not_renewable` no estaba pausada, o la pausa vigente es de otro tipo.
 *
 * La renovación es MONÓTONA (6D.2F.5C.1 hardening): una intervención humana
 * puede alargar el takeover o dejarlo como está, nunca recortarlo. Sin eso, un
 * mensaje humano entregado fuera de orden —nuevo para nosotros, pero anterior
 * en el reloj del proveedor— devolvería el control al agente antes de tiempo,
 * que es justo lo contrario de lo que significa que alguien acabe de escribir.
 */
export type RenewPauseResult = 'renewed' | 'not_extended' | 'not_renewable';

export interface ResumeConversationInput {
  agentConversationId: string;
  /** ISO 8601. Se escribe en `resumed_at` solo si esta ejecución gana la transición. */
  resumedAt: string;
}

/** `already_active` = la conversación ya estaba activa; no se toca `resumed_at`. */
export type ResumeConversationResult = 'resumed' | 'already_active';

export interface InsertControlEventInput {
  agentConversationId: string;
  action: AgentControlAction;
  source: AgentControlSource;
  reason: string | null;
  providerMessageId: string | null;
  /**
   * Vencimiento de ESTA pausa, para que el historial diga hasta cuándo iba a
   * durar y no solo que ocurrió. 0014 solo lo admite en `action='pause'`.
   */
  expiresAt?: string | null;
  metadata: Record<string, unknown> | null;
}

export type InsertControlEventResult = 'inserted' | 'duplicate';

/**
 * Acceso a datos de las tablas `agent_*`. La implementación real usa Supabase
 * con `service_role`; en pruebas se inyecta un doble.
 *
 * Ninguna operación envía mensajes ni llama a OpenAI.
 */
export interface AgentStore {
  upsertConversation(input: UpsertConversationInput): Promise<AgentConversationRef>;
  insertMessage(input: InsertAgentMessageInput): Promise<InsertMessageResult>;
  /**
   * Avanza `last_customer_message_at` con semántica `greatest` y retrocede
   * `first_customer_message_at` con `least`, SIN romper nunca la pareja
   * first/last que exige el CHECK de 0014.
   */
  touchCustomerMessageAt(agentConversationId: string, timestamp: string): Promise<void>;
  /** Avanza `last_human_message_at` con semántica `greatest`. */
  touchHumanMessageAt(agentConversationId: string, timestamp: string): Promise<void>;
  pauseConversation(input: PauseConversationInput): Promise<PauseConversationResult>;
  /**
   * Mueve el vencimiento de una pausa vigente. NO crea la pausa ni toca
   * `paused_at`: si la conversación está activa, o su pausa es de otro tipo,
   * devuelve `not_renewable` sin escribir nada.
   */
  renewPause(input: RenewPauseInput): Promise<RenewPauseResult>;
  /**
   * Transición `paused → active`: limpia TODOS los campos de pausa y sella
   * `resumed_at`. Guardada por `state='paused'`, así que solo una ejecución
   * concurrente puede ganarla. No borra mensajes ni eventos de control: la
   * historia de pausas vive en `agent_control_events`.
   */
  resumeConversation(input: ResumeConversationInput): Promise<ResumeConversationResult>;
  insertControlEvent(input: InsertControlEventInput): Promise<InsertControlEventResult>;
  /**
   * ¿Ya existe el evento de control de ESE resume concreto? Se identifica por
   * `metadata->>'resumed_at'`, porque un resume no tiene WAMID con el que
   * apoyarse en el UNIQUE parcial de 0014.
   */
  hasResumeEvent(agentConversationId: string, resumedAt: string): Promise<boolean>;
  /**
   * ¿Este WAMID humano ya completó su takeover? (6D.2F.5C.1 hardening)
   *
   * El evento de control es la ÚLTIMA escritura de la secuencia, así que su
   * presencia prueba que las anteriores —mensaje y pausa— también ocurrieron.
   * Es la marca durable que separa una reentrega YA COMPLETADA de una ejecución
   * a medias, sin heurísticas de tiempo y sin columnas nuevas.
   */
  hasPauseEventForMessage(
    agentConversationId: string,
    providerMessageId: string,
  ): Promise<boolean>;
  findPauseStateByPhone(customerPhone: string): Promise<AgentPauseState | null>;
}

// ── Ciclo de vida de `agent_runs` (Fase 6D.2F.3) ─────────────────────────────

export interface ClaimAgentRunInput {
  agentConversationId: string;
  /** WAMID del entrante que dispara el turno. Es el UNIQUE de idempotencia. */
  sourceMessageId: string;
  sourceAgentMessageId: string | null;
  model: string | null;
}

/**
 * `exists` = otra ejecución ya reclamó este WAMID. Se devuelve su estado para
 * que el core decida SIN llamar al modelo: reclamar es la barrera que impide
 * pagar dos veces por el mismo mensaje.
 */
export type ClaimAgentRunResult =
  | { result: 'claimed'; runId: string }
  | { result: 'exists'; runId: string; status: AgentRunStatus };

export interface FinishAgentRunInput {
  runId: string;
  status: Exclude<AgentRunStatus, 'processing' | 'sending'>;
  completedAt: string;
  /** Solo en `completed`: apunta al `agent_messages` de la respuesta. */
  responseMessageId?: string | null;
  /** Obligatorio en `failed` y `send_unknown`. Formato `[A-Za-z0-9._:-]{1,64}`. */
  errorCode?: string | null;
  /** Obligatorio en `skipped_paused`. */
  skippedAtBarrier?: AgentRunBarrier | null;
  model?: string | null;
  /**
   * Rondas de herramientas gastadas (Fase 6D.2F.5B). La columna existe desde
   * 0014, así que esto NO necesita migración. Es un CONTADOR: qué herramientas
   * fueron no cabe en `agent_runs` y va al log estructurado, saneado.
   */
  toolRounds?: number;
}

/**
 * Acceso a datos del CICLO DE EJECUCIÓN. Separado de `AgentStore` a propósito:
 * persistir historial y controlar pausas son cosas que ocurren siempre,
 * mientras que ejecutar un turno del agente solo ocurre para los mensajes
 * elegibles. Mantenerlos aparte deja que el resto del sistema siga sin conocer
 * nada de runs.
 */
export interface AgentRunStore {
  /**
   * Reclama el turno con `INSERT ... ON CONFLICT DO NOTHING` sobre el UNIQUE de
   * `source_message_id`. Es atómico: sin ventana de carrera entre comprobar y
   * escribir, que es donde se colaría una segunda llamada a OpenAI.
   */
  claimRun(input: ClaimAgentRunInput): Promise<ClaimAgentRunResult>;
  /** `processing → sending`, justo antes del envío. */
  markRunSending(runId: string): Promise<void>;
  finishRun(input: FinishAgentRunInput): Promise<void>;
  /**
   * Ventana de historial para el modelo. Devuelve un subconjunto ESTRECHO de
   * columnas: sin metadata, sin identificadores del proveedor, sin payload.
   * Lo que no se lee no puede filtrarse al prompt.
   */
  loadRecentMessages(
    agentConversationId: string,
    sinceIso: string,
    limit: number,
  ): Promise<ContextMessage[]>;
  /** `agent_messages.id` a partir del WAMID; sirve para enlazar el run. */
  findMessageIdByProviderMessageId(providerMessageId: string): Promise<string | null>;
  /** Avanza `first/last_ai_message_at` respetando la pareja que exige 0014. */
  touchAiMessageAt(agentConversationId: string, timestamp: string): Promise<void>;
}

// ── Envío (puerto estrecho para no meter Kapso dentro del core) ──────────────

export type AgentSendResult =
  | { ok: true; wamid: string }
  | { ok: false; error: string; status?: number };

export interface AgentSendPort {
  sendText(
    customerPhone: string,
    text: string,
    phoneNumberId: string | null,
  ): Promise<AgentSendResult>;
}

// ── Resultados saneados (nunca llevan teléfono ni contenido) ─────────────────

export type TakeoverRejection = 'missing_phone' | 'missing_message_id';

/**
 * `already_applied` = este WAMID ya completó su takeover en otra entrega, y esta
 * no escribió NADA: ni mensaje, ni pausa, ni evento. Es distinto de
 * `already_paused`, que sí intentó pausar y encontró la conversación pausada.
 */
export type TakeoverPauseOutcome = PauseConversationResult | 'already_applied';

export type HumanTakeoverResult =
  | {
      result: 'ok';
      conversationId: string;
      message: InsertMessageResult;
      pause: TakeoverPauseOutcome;
      controlEvent: InsertControlEventResult;
    }
  | { result: 'rejected'; reason: TakeoverRejection };

export type PersistInboundResult =
  | { result: 'persisted' | 'duplicate'; conversationId: string }
  | { result: 'rejected'; reason: 'missing_phone' };

export type ResumeAgentResult =
  | {
      result: 'ok';
      conversationId: string;
      /** `resumed` = esta ejecución hizo la transición; `already_active` = ya lo estaba. */
      transition: ResumeConversationResult;
      /** `inserted` = se registró el evento; `duplicate` = ya estaba registrado. */
      controlEvent: InsertControlEventResult;
    }
  | { result: 'not_found' }
  | { result: 'rejected'; reason: 'missing_phone' };

/**
 * Puerto que el webhook recibe inyectado. Opcional: sin él, el webhook conserva
 * EXACTAMENTE el comportamiento previo a 6D.2F.2B.
 */
export interface AgentChannelPort {
  /** Persiste el saliente humano y pausa la conversación con vencimiento renovable. */
  handleHumanTakeover(message: ProvenanceMessage): Promise<HumanTakeoverResult>;
  /** Persiste un mensaje real entrante del cliente. Se ejecuta AUNQUE esté pausada. */
  persistCustomerInbound(message: ProvenanceMessage): Promise<PersistInboundResult>;
  /**
   * Turno del agente (Fase 6D.2F.3). OPCIONAL: sin él el webhook se comporta
   * igual que en 6D.2F.2B — persiste historial y pausa, pero nadie responde.
   * Es el segundo interruptor, independiente de `AI_ENABLED`.
   *
   * Solo se invoca cuando los flujos determinísticos YA declinaron el mensaje.
   */
  /**
   * `burst` son los entrantes de ESTA entrega en su orden original (5C.5).
   * Opcional: sin él, el turno solo conoce su ancla — que es exactamente el
   * comportamiento anterior. Se necesita porque los píxeles de una foto no
   * están en el historial, solo su caption.
   */
  runAgentTurn?(
    message: ProvenanceMessage,
    burst?: readonly ProvenanceMessage[],
  ): Promise<AgentTurnResult>;
}

/** Desenlace saneado de un turno: sin teléfono, sin texto, sin prompt. */
export type AgentTurnSkipReason =
  | AgentEligibility
  | 'paused'
  | 'missing_phone'
  | 'missing_message_id'
  /** Esta fase es SOLO texto: audio, imagen, documento… no llegan al modelo. */
  | 'unsupported_content'
  | 'no_conversation';

export type AgentTurnResult =
  /** No se llamó al modelo. Salvo `paused`, tampoco se creó ningún run. */
  | { result: 'skipped'; reason: AgentTurnSkipReason; runId?: string }
  /** Ya había un run para este WAMID: no se vuelve a llamar al modelo. */
  | { result: 'duplicate'; runId: string; status: AgentRunStatus }
  | { result: 'replied'; runId: string }
  /**
   * El modelo no escribió nada, pero el turno YA le dio algo al cliente: una
   * herramienta produjo un efecto visible confirmado (hoy, el CTA del menú).
   * No hay saliente de IA porque no había texto, y no se inventa uno.
   */
  | { result: 'completed_silent'; runId: string }
  | { result: 'failed'; runId: string; error: string }
  /** El envío pudo haber salido. NUNCA se reintenta a ciegas. */
  | { result: 'send_unknown'; runId: string; error: string };
