/**
 * Puerto del MODELO — módulo puro (Fase 6D.2F.3).
 *
 * Agent Core no conoce OpenAI: habla con esta interfaz. El adaptador real vive
 * en `@/lib/agent/openai/adapter`, y en pruebas se inyecta un doble. Así la
 * lógica del turno (barreras, run, contexto, envío) se prueba entera sin red y
 * sin gastar tokens.
 *
 * Sin streaming: WhatsApp recibe un único mensaje ya terminado, así que emitir
 * en trozos no aporta nada y complicaría el envío y la persistencia.
 */

/** Rol tal como lo entiende el modelo. Coincide con `agent_messages.role`. */
export type AgentModelRole = 'system' | 'user' | 'assistant';

/**
 * Partes de un mensaje MULTIMODAL (Fase 6D.2F.5C.5).
 *
 * Los nombres son los de la Responses API —`input_text`, `input_image`,
 * `image_url`— por la misma razón que `function_call` lo es más abajo: el
 * adaptador envía los items TAL CUAL, sin traducir. Inventar aquí un vocabulario
 * propio obligaría a mantener un mapeo que solo tiene un destino posible.
 *
 * `image_url` admite un data URL. En la práctica siempre lo es: el resolver
 * descarga la imagen para no entregarle a OpenAI una credencial de acceso al
 * contenido del cliente. Ver `core/media.ts`.
 */
export type AgentModelContentPart =
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; image_url: string; detail?: 'auto' | 'low' | 'high' };

export interface AgentModelMessage {
  role: AgentModelRole;
  /**
   * Texto plano, o partes. Un mensaje con imagen y caption es UN mensaje con
   * dos partes — nunca dos mensajes: el cliente mandó una sola cosa.
   */
  content: string | readonly AgentModelContentPart[];
}

/**
 * Herramienta ofrecida al modelo (Fase 6D.2F.5B).
 *
 * `parameters` es JSON Schema. Las de esta fase no reciben argumentos: cuanto
 * menos pueda escribir el modelo, menos hay que validar.
 */
export interface AgentToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** Petición del modelo de ejecutar una herramienta. `arguments` es JSON crudo. */
export interface AgentToolCall {
  callId: string;
  name: string;
  arguments: string;
}

/**
 * Un turno puede llevar más que mensajes: también la llamada a herramienta que
 * hizo el modelo y el resultado que le devolvimos. Los tres son items de la
 * Responses API, y se envían tal cual — sin traducir a otro formato.
 */
export type AgentModelInput =
  | AgentModelMessage
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string };

/**
 * Errores del modelo, ya saneados. NUNCA llevan el cuerpo de la respuesta, ni
 * la clave, ni el prompt: van a `agent_runs.error_code`, cuyo CHECK solo admite
 * `[A-Za-z0-9._:-]{1,64}`.
 */
export type AgentModelError =
  /** Falta configuración (clave o modelo): jamás se llamó a la red. */
  | 'not_configured'
  | 'timeout'
  | 'network_error'
  | 'http_error'
  | 'invalid_response'
  /** Respondió, pero sin texto utilizable. No se inventa una respuesta. */
  | 'empty_response'
  /**
   * `status='incomplete'`: el texto está CORTADO (tope de tokens, filtro de
   * contenido). Se descarta: media frase a un cliente es peor que el silencio.
   */
  | 'incomplete_response'
  /** El modelo se negó a responder. No hay texto que enviar. */
  | 'refused'
  /** `status='failed'` reportado por el propio proveedor. */
  | 'provider_failed';

/**
 * `toolCalls` solo aparece cuando el modelo pidió herramientas; se omite en
 * caso contrario para que un turno normal siga teniendo exactamente la misma
 * forma que antes de esta fase.
 *
 * Con `toolCalls`, `text` puede venir vacío: pedir una herramienta ES la
 * respuesta de ese paso.
 */
export type AgentModelResult =
  | { ok: true; text: string; model: string; toolCalls?: readonly AgentToolCall[] }
  | { ok: false; error: AgentModelError; status?: number };

/**
 * Política de selección de herramienta para UN paso (Fase 6D.2F.5B.1).
 *
 *   'auto'      el modelo decide si llama a alguna. Es el comportamiento por defecto.
 *   'required'  DEBE llamar a una. Sin esto, "no llamar a ninguna" es un camino
 *               silencioso: el modelo contesta en prosa y nadie se entera de que
 *               nunca hubo una decisión.
 *   'none'      no puede llamar a ninguna, aunque se le hayan declarado.
 *
 * Es vocabulario del PUERTO, no de OpenAI: el core expresa la intención y el
 * adaptador la traduce al campo que entienda el proveedor de turno.
 */
export type AgentToolChoice = 'auto' | 'required' | 'none';

export interface AgentModelOptions {
  /** Techo de tokens de la respuesta. WhatsApp premia lo breve. */
  maxOutputTokens?: number;
  timeoutMs?: number;
  /** Herramientas disponibles en este paso. Sin ellas, el modelo solo escribe. */
  tools?: readonly AgentToolDefinition[];
  /** Obligatoriedad de la llamada en este paso. Ausente = criterio del proveedor. */
  toolChoice?: AgentToolChoice;
  /**
   * ¿Puede pedir VARIAS herramientas de una vez? Ausente = criterio del proveedor.
   *
   * `false` no es una optimización: una ronda cuyo contrato es "exactamente una
   * decisión" no debería tener que rechazar a posteriori un lote de tres.
   */
  parallelToolCalls?: boolean;
}

export interface AgentModel {
  /** Nombre del modelo configurado; se persiste en `agent_runs.model`. */
  readonly model: string;
  complete(
    messages: readonly AgentModelInput[],
    options?: AgentModelOptions,
  ): Promise<AgentModelResult>;
}
