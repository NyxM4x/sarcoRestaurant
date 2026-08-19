import type { AgentToolCall, AgentToolDefinition } from '@/lib/agent/core/model';

/**
 * Registro y ejecución de herramientas — módulo PURO (Fase 6D.2F.5B).
 *
 * El modelo entiende la intención; las herramientas consultan y solicitan; el
 * BACKEND conserva la autoridad. Esa última parte es lo que este archivo
 * protege: el modelo elige QUÉ herramienta llamar, y nada más. No decide
 * parámetros que no existan, no alcanza Supabase, no construye URLs y no puede
 * pedir que se salte una política.
 *
 * Todo fallo es FAIL-SAFE: una tool desconocida o unos argumentos inválidos no
 * tumban el turno, devuelven un resultado de error que el modelo puede leer y
 * con el que puede disculparse. Lanzar aquí convertiría una alucinación del
 * modelo en un 500 del webhook.
 */

/** Contexto del turno. Lo pone el core, NUNCA el modelo. */
export interface AgentToolContext {
  /** Dígitos normalizados del cliente. */
  customerPhone: string;
  /** WAMID del entrante que abrió el turno: la idempotencia cuelga de aquí. */
  sourceMessageId: string;
  phoneNumberId: string | null;
  /**
   * Texto REAL del entrante que abrió el turno.
   *
   * Viene del payload del proveedor, no de la salida del modelo: es lo que hace
   * que una clasificación hecha en backend siga siendo del backend. El modelo
   * puede escribir lo que quiera en su respuesta; esto no lo puede tocar.
   */
  inboundText: string;
}

/**
 * Lo que una herramienta le devuelve al core.
 *
 * Son DOS cosas distintas a propósito: lo que el modelo lee y lo que el core
 * necesita saber. Mezclarlas obligaría al core a interpretar el JSON de cada
 * herramienta, y entonces dejaría de ser genérico.
 */
export interface AgentToolOutcome {
  /** Lo que ve el modelo. Serializable a JSON. Nunca secretos. */
  result: unknown;
  /**
   * ¿Esta ejecución produjo un efecto que el CLIENTE ve, y el backend lo tiene
   * CONFIRMADO?
   *
   * Lo decide la herramienta a partir del resultado real de su dependencia —
   * nunca el modelo, ni sus argumentos, ni su prosa. Consultar una tabla no
   * cuenta: el cliente no ve una consulta. Un envío que salió, sí.
   *
   * Sirve para una sola pregunta del core: si el modelo se queda callado
   * después de esto, ¿el turno ya le dio algo al cliente? Ausente = no.
   */
  userVisibleEffectConfirmed?: boolean;
}

export interface AgentTool {
  definition: AgentToolDefinition;
  /**
   * ¿Esta herramienta PUEDE producir un efecto que el cliente ve?
   *
   * Es una declaración ESTÁTICA, y por eso es distinta de
   * `userVisibleEffectConfirmed`: aquella dice qué pasó y solo se sabe después;
   * esta dice qué puede pasar y se sabe antes. El core la necesita antes para
   * decidir si comprobar la pausa, porque comprobarla después de mandar el
   * mensaje no sirve de nada.
   *
   * Ausente = no. Una herramienta que solo lee no necesita declarar nada.
   */
  producesUserVisibleEffect?: boolean;
  /**
   * ¿El efecto confirmado de esta herramienta ES la respuesta al cliente?
   *
   * `true` significa: si el efecto sale y el backend lo confirma, el turno está
   * COMPLETO. No se le pide texto al modelo, porque no queda nada que decir —
   * el cliente ya recibió el mensaje de verdad.
   *
   * Es la declaración que impide, por construcción, que exista una frase de IA
   * afirmando un efecto: si el efecto ocurrió, no hay frase; si no ocurrió, la
   * confirmación es `false` y el turno pasa a redactar con el fallo delante.
   *
   * Va junto a `userVisibleEffectConfirmed`, no en su lugar: esta dice qué
   * significa el efecto, aquella dice si ocurrió. Ausente = no.
   */
  effectCompletesTurn?: boolean;
  /**
   * Qué hace la herramienta. OPCIONAL a propósito.
   *
   * Una acción SIN `execute` es una decisión que no ejecuta nada: seleccionarla
   * declara que este turno no necesita ninguna acción de negocio antes de
   * responder. No hay efecto, no hay datos y no hay resultado que llevar a la
   * redacción — solo la constancia, observable, de que la decisión se tomó.
   */
  execute?(context: AgentToolContext): Promise<AgentToolOutcome>;
}

export type AgentToolRegistry = readonly AgentTool[];

/**
 * Resuelve el NOMBRE que eligió el modelo a la herramienta declarada.
 *
 * El core pregunta por nombre y a partir de ahí lee DECLARACIONES —¿produce
 * efecto visible?, ¿ese efecto es la respuesta?, ¿hay algo que ejecutar?—, nunca
 * compara con una lista de nombres propia. Un `if (name === 'send_menu')` ahí
 * dentro ataría el núcleo a este negocio, y la siguiente acción con efecto se
 * olvidaría de la barrera sin que nada avisara.
 *
 * Un nombre desconocido devuelve `null`: el modelo se inventó una acción, y
 * quien pregunta decide qué hacer con eso.
 */
export function findAgentTool(
  name: string,
  registry: AgentToolRegistry,
): AgentTool | null {
  return registry.find((t) => t.definition.name === name) ?? null;
}

/** Resultado saneado que se devuelve al modelo como `function_call_output`. */
export interface ExecutedTool {
  callId: string;
  name: string;
  /** JSON serializado. Es lo único que el modelo llega a ver. */
  output: string;
  /** `false` cuando la llamada ni siquiera pudo ejecutarse (fail-safe). */
  ok: boolean;
  /**
   * Señal para el core, NO para el modelo: no viaja en `output`. Siempre un
   * booleano de verdad, aunque la herramienta devuelva otra cosa.
   */
  userVisibleEffectConfirmed: boolean;
}

/** Esquema de una tool SIN argumentos, en la forma que exige `strict: true`. */
export const NO_ARGUMENTS = {
  type: 'object',
  properties: {},
  required: [],
  additionalProperties: false,
} as const;

/**
 * ¿Los argumentos son aceptables?
 *
 * Las tools de esta fase no reciben ninguno, así que se admite lo vacío en sus
 * formas razonables y se rechaza cualquier otra cosa. Que el modelo mande
 * campos inventados es señal de que entendió mal, y seguir adelante con ellos
 * sería darle una autoridad que no tiene.
 */
export function hasNoArguments(rawArguments: string): boolean {
  const trimmed = rawArguments.trim();
  if (trimmed === '' || trimmed === '{}') return true;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return false;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  return Object.keys(parsed as Record<string, unknown>).length === 0;
}

export async function executeToolCall(
  call: AgentToolCall,
  registry: AgentToolRegistry,
  context: AgentToolContext,
): Promise<ExecutedTool> {
  const tool = registry.find((t) => t.definition.name === call.name);

  // Tool inexistente: el modelo se inventó un nombre. Se le dice, y sigue.
  // Ninguna rama de fallo confirma efecto: no se ejecutó nada.
  if (!tool) {
    return {
      callId: call.callId,
      name: call.name,
      ok: false,
      output: JSON.stringify({ error: 'unknown_tool' }),
      userVisibleEffectConfirmed: false,
    };
  }

  if (!hasNoArguments(call.arguments)) {
    return {
      callId: call.callId,
      name: call.name,
      ok: false,
      output: JSON.stringify({ error: 'invalid_arguments' }),
      userVisibleEffectConfirmed: false,
    };
  }

  // Acción declarativa: no hay nada que ejecutar. El core no llega aquí con
  // una de estas —las resuelve antes—, pero si algún día lo hiciera, que sea un
  // resultado legible y no un `tool.execute is not a function`.
  if (typeof tool.execute !== 'function') {
    return {
      callId: call.callId,
      name: call.name,
      ok: false,
      output: JSON.stringify({ error: 'not_executable' }),
      userVisibleEffectConfirmed: false,
    };
  }

  try {
    const outcome = await tool.execute(context);
    return {
      callId: call.callId,
      name: call.name,
      ok: true,
      output: JSON.stringify(outcome.result),
      // `=== true` y no un truthy: la señal entra al core como booleano o no
      // entra. Un `undefined` de una tool futura vale exactamente "no".
      userVisibleEffectConfirmed: outcome.userVisibleEffectConfirmed === true,
    };
  } catch {
    // El detalle del fallo se queda aquí: puede llevar el mensaje de Supabase,
    // y eso no viaja a OpenAI. Y una tool que lanzó no confirma nada.
    return {
      callId: call.callId,
      name: call.name,
      ok: false,
      output: JSON.stringify({ error: 'tool_failed' }),
      userVisibleEffectConfirmed: false,
    };
  }
}
