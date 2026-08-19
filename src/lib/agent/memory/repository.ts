import 'server-only';
import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js';
import { toAutomationAction, type ContextMessage } from '@/lib/agent/core/context';
import type {
  AgentConversationRef,
  AgentPauseState,
  AgentRunStore,
  AgentStore,
  ClaimAgentRunInput,
  ClaimAgentRunResult,
  FinishAgentRunInput,
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
import type { AgentConversationState, AgentRunStatus } from '@/types';

/**
 * Repositorio de las tablas `agent_*` sobre Supabase (server-only, Fase 6D.2F.2B).
 *
 * Se apoya en las garantías de la migración 0014:
 *  - `agent_conversations.customer_phone` UNIQUE  → upsert por identidad durable;
 *  - `agent_messages.provider_message_id` UNIQUE parcial → dedupe de wamid;
 *  - `agent_control_events` UNIQUE parcial (conversación, action, wamid).
 *
 * Los grants de 0014 son deliberadamente estrechos: `agent_control_events` solo
 * admite SELECT e INSERT, así que aquí NUNCA se hace upsert sobre esa tabla; un
 * conflicto de unicidad se interpreta como duplicado y se ignora.
 *
 * `last_message_at` no se escribe jamás desde aquí: lo deriva el trigger
 * `trg_agent_conversations_last_message_at`.
 */

/** Código Postgres de violación de unicidad. */
const UNIQUE_VIOLATION = '23505';

function isUniqueViolation(error: PostgrestError | null): boolean {
  return (error as (PostgrestError & { code?: string }) | null)?.code === UNIQUE_VIOLATION;
}

export function createAgentStore(supabase: SupabaseClient): AgentStore & AgentRunStore {
  /**
   * Semántica `greatest`/`least` sin escribir SQL: en vez de leer y recalcular
   * (que abriría una carrera entre dos mensajes simultáneos), se emiten UPDATE
   * condicionales. Cada uno es atómico a nivel de fila y un no-op cuando el
   * valor guardado ya es mejor.
   */
  async function advanceTimestamp(
    id: string,
    column: 'last_customer_message_at' | 'last_human_message_at' | 'last_ai_message_at',
    timestamp: string,
  ): Promise<void> {
    // Primer mensaje de ese actor.
    const nullCase = await supabase
      .from('agent_conversations')
      .update({ [column]: timestamp })
      .eq('id', id)
      .is(column, null);
    if (nullCase.error) throw new Error(`agent.advance(${column}): ${nullCase.error.message}`);

    // greatest(actual, entrante): solo avanza, nunca retrocede.
    const advance = await supabase
      .from('agent_conversations')
      .update({ [column]: timestamp })
      .eq('id', id)
      .lt(column, timestamp);
    if (advance.error) throw new Error(`agent.advance(${column}): ${advance.error.message}`);
  }

  return {
    async upsertConversation(input: UpsertConversationInput): Promise<AgentConversationRef> {
      // Solo se envían las referencias del proveedor cuando llegan con valor: un
      // evento sin `conversation.id` no debe borrar el que ya teníamos.
      const payload: Record<string, unknown> = { customer_phone: input.customerPhone };
      if (input.providerConversationId !== null) {
        payload.last_provider_conversation_id = input.providerConversationId;
      }
      if (input.providerPhoneNumberId !== null) {
        payload.provider_phone_number_id = input.providerPhoneNumberId;
      }

      const { data, error } = await supabase
        .from('agent_conversations')
        .upsert(payload, { onConflict: 'customer_phone' })
        .select('id, state')
        .single();

      if (error) throw new Error(`agent.upsertConversation: ${error.message}`);
      return { id: data.id as string, state: data.state as AgentConversationState };
    },

    async insertMessage(input: InsertAgentMessageInput): Promise<InsertMessageResult> {
      const { error } = await supabase.from('agent_messages').insert({
        agent_conversation_id: input.agentConversationId,
        provider_message_id: input.providerMessageId,
        provider_conversation_id: input.providerConversationId,
        direction: input.direction,
        role: input.role,
        actor: input.actor,
        content: input.content,
        content_type: input.contentType,
        metadata: input.metadata as never,
        message_timestamp: input.messageTimestamp,
      });

      // Reentrega del mismo wamid: no es un error, es el dedupe funcionando.
      if (isUniqueViolation(error)) return 'duplicate';
      if (error) throw new Error(`agent.insertMessage: ${error.message}`);
      return 'inserted';
    },

    async touchCustomerMessageAt(id: string, timestamp: string): Promise<void> {
      // El CHECK `customer_first_last_paired` exige que first y last sean ambos
      // NULL o ambos no-NULL, así que la inicialización debe fijar LOS DOS en la
      // misma sentencia. Poblar uno solo dejaría la fila en un estado ilegal.
      const init = await supabase
        .from('agent_conversations')
        .update({ first_customer_message_at: timestamp, last_customer_message_at: timestamp })
        .eq('id', id)
        .is('first_customer_message_at', null);
      if (init.error) throw new Error(`agent.touchCustomer(init): ${init.error.message}`);

      await advanceTimestamp(id, 'last_customer_message_at', timestamp);

      // least(actual, entrante): una reentrega tardía sí puede retroceder `first`.
      const retreat = await supabase
        .from('agent_conversations')
        .update({ first_customer_message_at: timestamp })
        .eq('id', id)
        .gt('first_customer_message_at', timestamp);
      if (retreat.error) throw new Error(`agent.touchCustomer(first): ${retreat.error.message}`);
    },

    async touchHumanMessageAt(id: string, timestamp: string): Promise<void> {
      // Sin `first_human_message_at` en 0014: no hay pareja que mantener.
      await advanceTimestamp(id, 'last_human_message_at', timestamp);
    },

    async pauseConversation(input: PauseConversationInput): Promise<PauseConversationResult> {
      // Guardado por `state='active'`: una reentrega no reescribe `paused_at` y
      // por tanto no falsea el "tiempo hasta el takeover".
      const { data, error } = await supabase
        .from('agent_conversations')
        .update({
          state: 'paused',
          paused_at: input.pausedAt,
          // NULL = indefinida. Lo decide quien llama, no esta capa.
          pause_expires_at: input.pauseExpiresAt,
          pause_reason: input.reason,
          pause_source: input.source,
          resumed_at: null, // obligatorio: el CHECK de 0014 lo exige en 'paused'
        })
        .eq('id', input.agentConversationId)
        .eq('state', 'active')
        .select('id');

      if (error) throw new Error(`agent.pauseConversation: ${error.message}`);
      return (data?.length ?? 0) > 0 ? 'paused' : 'already_paused';
    },

    async renewPause(input: RenewPauseInput): Promise<RenewPauseResult> {
      // Solo `pause_expires_at`. `paused_at` se queda donde estaba: marca
      // cuándo empezó el takeover, y moverlo borraría ese dato.
      //
      // Los tres guards son el contrato entero: la conversación tiene que
      // seguir pausada, y su pausa tiene que ser del MISMO tipo que la que se
      // está renovando. Sin los dos últimos, un mensaje desde WhatsApp Business
      // App le pondría vencimiento a una pausa indefinida del panel.
      //
      // Una pausa de takeover ANTIGUA (creada cuando eran indefinidas, con
      // `pause_expires_at` NULL) sí entra: coincide en reason y source, así que
      // el siguiente mensaje humano la pasa al comportamiento nuevo. Es lo que
      // se quiere — nadie tiene que ir a arreglarlas a mano.
      //
      // Y un cuarto guard, el de MONOTONÍA: solo se escribe si el vencimiento
      // nuevo es POSTERIOR al guardado (o si no había ninguno). Va en el propio
      // UPDATE, como `advanceTimestamp`, y no en un leer-comparar-escribir, que
      // abriría una carrera entre dos mensajes humanos simultáneos.
      //
      // El valor va entre comillas dobles porque lleva `:` y `.`, que son los
      // separadores de PostgREST. URL medida (16-08-2026):
      //   ...&or=(pause_expires_at.is.null,pause_expires_at.lt."2025-10-09T09:33:20.000Z")
      // Los `eq` de arriba y el grupo `or` se combinan con AND, que es lo que
      // se quiere: renovable Y más largo.
      const renewed = await supabase
        .from('agent_conversations')
        .update({ pause_expires_at: input.pauseExpiresAt })
        .eq('id', input.agentConversationId)
        .eq('state', 'paused')
        .eq('pause_reason', input.reason)
        .eq('pause_source', input.source)
        .or(`pause_expires_at.is.null,pause_expires_at.lt."${input.pauseExpiresAt}"`)
        .select('id');

      if (renewed.error) throw new Error(`agent.renewPause: ${renewed.error.message}`);
      if ((renewed.data?.length ?? 0) > 0) return 'renewed';

      // Cero filas por dos motivos muy distintos: o la pausa no era renovable, o
      // sí lo era y ya duraba más. Distinguirlo cuesta una lectura que solo
      // ocurre en el camino raro, y evita que un no-op deliberado se lea en los
      // tests y en el futuro log como "no se pudo".
      const alive = await supabase
        .from('agent_conversations')
        .select('id')
        .eq('id', input.agentConversationId)
        .eq('state', 'paused')
        .eq('pause_reason', input.reason)
        .eq('pause_source', input.source)
        .limit(1);

      if (alive.error) throw new Error(`agent.renewPause(read): ${alive.error.message}`);
      return (alive.data?.length ?? 0) > 0 ? 'not_extended' : 'not_renewable';
    },

    async resumeConversation(input: ResumeConversationInput): Promise<ResumeConversationResult> {
      // Guardado por `state='paused'`: contraparte exacta del guard de la pausa.
      // Una reejecución no reescribe `resumed_at` ni falsea el momento en que se
      // devolvió el control al agente.
      //
      // Los cinco campos de pausa se limpian en la MISMA sentencia porque el
      // CHECK `agent_conversations_state_coherence` exige que un `active` los
      // tenga todos a NULL: dejarlos para una segunda escritura abortaría.
      const { data, error } = await supabase
        .from('agent_conversations')
        .update({
          state: 'active',
          paused_at: null,
          pause_expires_at: null,
          pause_reason: null,
          pause_source: null,
          resumed_at: input.resumedAt,
        })
        .eq('id', input.agentConversationId)
        .eq('state', 'paused')
        .select('id');

      if (error) throw new Error(`agent.resumeConversation: ${error.message}`);
      return (data?.length ?? 0) > 0 ? 'resumed' : 'already_active';
    },

    async hasResumeEvent(id: string, resumedAt: string): Promise<boolean> {
      // `metadata->>'resumed_at'` identifica la operación: un resume no tiene
      // WAMID sobre el que apoyar el UNIQUE parcial de 0014.
      const { data, error } = await supabase
        .from('agent_control_events')
        .select('id')
        .eq('agent_conversation_id', id)
        .eq('action', 'resume')
        .eq('metadata->>resumed_at', resumedAt)
        .limit(1);

      if (error) throw new Error(`agent.hasResumeEvent: ${error.message}`);
      return (data?.length ?? 0) > 0;
    },

    async hasPauseEventForMessage(id: string, providerMessageId: string): Promise<boolean> {
      // Exactamente la forma del UNIQUE parcial de 0014
      // (agent_conversation_id, action, provider_message_id) where wamid not null:
      // la lectura usa ese mismo índice y cuesta lo que cuesta un dedupe.
      const { data, error } = await supabase
        .from('agent_control_events')
        .select('id')
        .eq('agent_conversation_id', id)
        .eq('action', 'pause')
        .eq('provider_message_id', providerMessageId)
        .limit(1);

      if (error) throw new Error(`agent.hasPauseEventForMessage: ${error.message}`);
      return (data?.length ?? 0) > 0;
    },

    async insertControlEvent(input: InsertControlEventInput): Promise<InsertControlEventResult> {
      // INSERT plano, nunca upsert: 0014 no concede UPDATE sobre esta tabla.
      const { error } = await supabase.from('agent_control_events').insert({
        agent_conversation_id: input.agentConversationId,
        action: input.action,
        source: input.source,
        reason: input.reason,
        provider_message_id: input.providerMessageId,
        // Hasta cuándo iba a durar ESTA pausa. 0014 solo lo admite en 'pause'.
        expires_at: input.expiresAt ?? null,
        metadata: input.metadata as never,
      });

      if (isUniqueViolation(error)) return 'duplicate';
      if (error) throw new Error(`agent.insertControlEvent: ${error.message}`);
      return 'inserted';
    },

    // ── Ciclo de ejecución (AgentRunStore, Fase 6D.2F.3) ─────────────────────

    async claimRun(input: ClaimAgentRunInput): Promise<ClaimAgentRunResult> {
      // `ignoreDuplicates` = ON CONFLICT DO NOTHING sobre el UNIQUE de
      // source_message_id: es ATÓMICO. Comprobar-y-luego-insertar dejaría una
      // ventana por la que se colaría una segunda llamada a OpenAI.
      const inserted = await supabase
        .from('agent_runs')
        .upsert(
          {
            agent_conversation_id: input.agentConversationId,
            source_message_id: input.sourceMessageId,
            source_agent_message_id: input.sourceAgentMessageId,
            model: input.model,
            status: 'processing',
          },
          { onConflict: 'source_message_id', ignoreDuplicates: true },
        )
        .select('id');

      if (inserted.error) throw new Error(`agent.claimRun: ${inserted.error.message}`);
      if ((inserted.data?.length ?? 0) > 0) {
        return { result: 'claimed', runId: inserted.data![0].id as string };
      }

      // Cero filas = ya existía. Se devuelve su estado para que el core pare.
      const existing = await supabase
        .from('agent_runs')
        .select('id, status')
        .eq('source_message_id', input.sourceMessageId)
        .single();

      if (existing.error) throw new Error(`agent.claimRun(read): ${existing.error.message}`);
      return {
        result: 'exists',
        runId: existing.data.id as string,
        status: existing.data.status as AgentRunStatus,
      };
    },

    async markRunSending(runId: string): Promise<void> {
      // Guardado por `processing`: nadie puede empujar a `sending` un run que
      // otra ejecución ya cerró.
      const { error } = await supabase
        .from('agent_runs')
        .update({ status: 'sending' })
        .eq('id', runId)
        .eq('status', 'processing');
      if (error) throw new Error(`agent.markRunSending: ${error.message}`);
    },

    async finishRun(input: FinishAgentRunInput): Promise<void> {
      // Los CHECK de coherencia de 0014 exigen la combinación exacta por estado,
      // así que se escriben TODAS las columnas implicadas en una sentencia.
      const payload: Record<string, unknown> = {
        status: input.status,
        completed_at: input.completedAt,
        response_message_id: input.responseMessageId ?? null,
        error_code: input.errorCode ?? null,
        skipped_at_barrier: input.skippedAtBarrier ?? null,
      };
      if (input.model !== undefined && input.model !== null) payload.model = input.model;
      // Columna existente desde 0014: se rellena sin migración. Ausente = no se
      // toca, para no pisar con 0 un run que sí gastó herramientas.
      if (input.toolRounds !== undefined) payload.tool_rounds = input.toolRounds;

      const { error } = await supabase.from('agent_runs').update(payload).eq('id', input.runId);
      if (error) throw new Error(`agent.finishRun: ${error.message}`);
    },

    async loadRecentMessages(
      agentConversationId: string,
      sinceIso: string,
      limit: number,
    ): Promise<ContextMessage[]> {
      // SELECT deliberadamente estrecho: sin provider ids y sin payload. La
      // higiene del prompt se garantiza no leyendo, no filtrando.
      //
      // `metadata` se lee SOLO para saber qué acción ejecutó un automatismo, y
      // no sale de esta función: se reduce inmediatamente a la lista blanca de
      // `toAutomationAction`. Lo que viaja a `ContextMessage` es un valor de un
      // conjunto cerrado, nunca el objeto.
      //
      // El orden desc + limit usa `ix_agent_messages_recent`; se invierte en
      // memoria para entregar el contexto en orden cronológico.
      const { data, error } = await supabase
        .from('agent_messages')
        .select('actor, role, content, content_type, message_timestamp, metadata')
        .eq('agent_conversation_id', agentConversationId)
        .gte('message_timestamp', sinceIso)
        .order('message_timestamp', { ascending: false })
        .order('id', { ascending: false })
        .limit(limit);

      if (error) throw new Error(`agent.loadRecentMessages: ${error.message}`);

      // El orden desc + limit se queda con los MÁS RECIENTES; el reverse los
      // devuelve en orden cronológico, que es como debe leerlos el modelo.
      return (data ?? [])
        .map((row) => {
          const actor = row.actor as ContextMessage['actor'];
          const metadata = row.metadata as Record<string, unknown> | null;
          return {
            actor,
            role: row.role as ContextMessage['role'],
            content: (row.content as string | null) ?? null,
            // Se lee desde 5C.4: decide si un `content` del cliente puede
            // viajar como texto suyo. Sin él, la frase que Kapso redacta por
            // una reacción entraría al contexto como palabras del cliente.
            contentType: row.content_type as ContextMessage['contentType'],
            messageTimestamp: row.message_timestamp as string,
            // Solo los automatismos lo traen. Para el resto ni se mira: un
            // mensaje de una persona no tiene "acción" que proyectar.
            automationAction:
              actor === 'automation' ? toAutomationAction(metadata?.action) : null,
          };
        })
        .reverse();
    },

    async findMessageIdByProviderMessageId(providerMessageId: string): Promise<string | null> {
      const { data, error } = await supabase
        .from('agent_messages')
        .select('id')
        .eq('provider_message_id', providerMessageId)
        .maybeSingle();

      if (error) throw new Error(`agent.findMessageId: ${error.message}`);
      return (data?.id as string | undefined) ?? null;
    },

    async touchAiMessageAt(id: string, timestamp: string): Promise<void> {
      // Mismo cuidado que con el cliente: el CHECK `ai_first_last_paired` exige
      // que first y last sean ambos NULL o ambos no-NULL.
      const init = await supabase
        .from('agent_conversations')
        .update({ first_ai_message_at: timestamp, last_ai_message_at: timestamp })
        .eq('id', id)
        .is('first_ai_message_at', null);
      if (init.error) throw new Error(`agent.touchAi(init): ${init.error.message}`);

      await advanceTimestamp(id, 'last_ai_message_at', timestamp);

      const retreat = await supabase
        .from('agent_conversations')
        .update({ first_ai_message_at: timestamp })
        .eq('id', id)
        .gt('first_ai_message_at', timestamp);
      if (retreat.error) throw new Error(`agent.touchAi(first): ${retreat.error.message}`);
    },

    async findPauseStateByPhone(customerPhone: string): Promise<AgentPauseState | null> {
      const { data, error } = await supabase
        .from('agent_conversations')
        .select('id, state, paused_at, pause_expires_at, pause_reason, pause_source, resumed_at')
        .eq('customer_phone', customerPhone)
        .maybeSingle();

      if (error) throw new Error(`agent.findPauseStateByPhone: ${error.message}`);
      if (!data) return null;

      return {
        conversationId: data.id as string,
        state: data.state as AgentConversationState,
        pausedAt: (data.paused_at as string | null) ?? null,
        pauseExpiresAt: (data.pause_expires_at as string | null) ?? null,
        pauseReason: (data.pause_reason as string | null) ?? null,
        pauseSource: (data.pause_source as string | null) ?? null,
        resumedAt: (data.resumed_at as string | null) ?? null,
      };
    },
  };
}

export type AgentRepository = ReturnType<typeof createAgentStore>;
