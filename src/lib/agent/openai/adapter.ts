import { z } from 'zod';
import type {
  AgentModel,
  AgentModelInput,
  AgentModelOptions,
  AgentModelResult,
  AgentToolCall,
} from '@/lib/agent/core/model';

/**
 * Adaptador de OpenAI (Responses API) — módulo puro (Fase 6D.2F.3.1).
 *
 * Mismo patrón que `@/lib/kapso/transport`: `fetch` inyectable, timeout
 * explícito con AbortController, respuesta validada con zod y errores tipados.
 * No se usa el SDK oficial: la superficie que necesitamos es UN POST, y el
 * transporte de Kapso ya demostró que así se prueba sin red y sin añadir una
 * dependencia con su propio ciclo de vida.
 *
 * ── Por qué el parseo es como es ────────────────────────────────────────────
 * `output_text` es una COMODIDAD DEL SDK, no un campo de primer nivel fiable en
 * el JSON crudo. Con fetch directo hay que recorrer la estructura real:
 *
 *   output[]                      ← puede traer `reasoning`, `web_search_call`…
 *     └─ item.type === 'message'
 *          └─ content[]           ← puede traer `refusal` junto a texto
 *               └─ item.type === 'output_text'
 *                    └─ .text
 *
 * Por eso NO se indexa `output[0]` ni `content[0]`: con modelos de razonamiento
 * el primer elemento suele NO ser el mensaje. Se recorren todos y se concatenan
 * los `output_text` en orden.
 *
 * Nunca se registra ni se devuelve la clave, el prompt ni el cuerpo de la
 * respuesta: el error sale como código corto porque acaba en
 * `agent_runs.error_code`, cuyo CHECK solo admite `[A-Za-z0-9._:-]{1,64}`.
 *
 * La URL base es una CONSTANTE deliberada: un `OPENAI_BASE_URL` configurable
 * permitiría que una variable mal puesta mandara el Bearer de la clave a un
 * host arbitrario. Para las pruebas basta con inyectar `fetchImpl`.
 */

export const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';
export const OPENAI_DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_TIMEOUT_MS = 20_000;

/** Techo por defecto de la respuesta. El negocio puede bajarlo, no subirlo a ciegas. */
export const OPENAI_DEFAULT_MAX_OUTPUT_TOKENS = 300;

/**
 * Ajustes de salida de la Responses API para WhatsApp.
 *
 * `effort: 'none'` evita gastar el presupuesto de `max_output_tokens` en tokens
 * de razonamiento —que se descuentan del mismo techo y dejarían la respuesta en
 * `incomplete`— y quita latencia que aquí no compra nada: contestar "sí, hasta
 * las 10" no requiere deliberación.
 *
 * `verbosity: 'low'` refuerza por API lo que el prompt ya pide en prosa.
 */
export const OPENAI_DEFAULT_REASONING_EFFORT = 'none';
export const OPENAI_DEFAULT_VERBOSITY = 'low';

/**
 * ¿Este modelo admite `reasoning.effort` y `text.verbosity`?
 *
 * Enviarlos a un modelo que no los conoce es un 400, así que la puerta se cierra
 * por defecto: solo la familia `gpt-5.x` los recibe. `gpt-5` a secas queda
 * fuera a propósito (no admite `effort: 'none'`), igual que `gpt-4o-mini` —el
 * valor por defecto— y cualquier nombre futuro que no reconozcamos.
 *
 * Cambiar `OPENAI_MODEL` NO puede romper el envío por estos campos: si el
 * modelo no está en la familia conocida, simplemente no se mandan.
 */
export function supportsResponseTuning(model: string): boolean {
  return /^gpt-5\.\d/.test(model);
}

/**
 * Forma RAW de la Responses API, solo en lo que consumimos. Todo lo demás se
 * ignora por diseño: campos nuevos del proveedor no deben romper el parseo.
 */
const responsesSchema = z.object({
  model: z.string().optional(),
  status: z.string().optional(),
  output: z
    .array(
      z.object({
        type: z.string(),
        // Presentes solo en los items `function_call`.
        call_id: z.string().optional(),
        name: z.string().optional(),
        arguments: z.string().optional(),
        content: z
          .array(
            z.object({
              type: z.string(),
              text: z.string().optional(),
              refusal: z.string().optional(),
            }),
          )
          .optional(),
      }),
    )
    .optional(),
});

type ParsedResponse = z.infer<typeof responsesSchema>;

/**
 * Recorre la estructura completa: nunca asume posiciones.
 *
 * `output[]` mezcla items de tipos distintos —`reasoning`, `message`,
 * `function_call`, y lo que el proveedor añada mañana— y el orden no está
 * garantizado. Se clasifica POR TIPO y se ignora en silencio lo desconocido.
 */
function extractOutput(parsed: ParsedResponse): {
  text: string;
  refused: boolean;
  toolCalls: AgentToolCall[];
} {
  const chunks: string[] = [];
  const toolCalls: AgentToolCall[] = [];
  let refused = false;

  for (const item of parsed.output ?? []) {
    if (item.type === 'function_call') {
      // Sin `call_id` no hay forma de devolver el resultado al modelo, así que
      // un item incompleto se descarta en vez de inventarle un id.
      if (typeof item.call_id === 'string' && typeof item.name === 'string') {
        toolCalls.push({
          callId: item.call_id,
          name: item.name,
          // Ausente = sin argumentos. El validador de cada tool decide.
          arguments: typeof item.arguments === 'string' ? item.arguments : '{}',
        });
      }
      continue;
    }

    // Solo los items de mensaje llevan texto para el cliente. `reasoning` y
    // cualquier otro tipo se ignoran a propósito.
    if (item.type !== 'message') continue;

    for (const part of item.content ?? []) {
      if (part.type === 'output_text' && typeof part.text === 'string') {
        chunks.push(part.text);
      } else if (part.type === 'refusal') {
        refused = true;
      }
    }
  }

  return { text: chunks.join('').trim(), refused, toolCalls };
}

export interface OpenAiAdapterConfig {
  apiKey: string;
  model?: string;
  timeoutMs?: number;
  /**
   * `reasoning.effort`. Sin valor usa el de por defecto; `null` lo desactiva.
   * Es `string` y no una unión cerrada para que un valor nuevo del proveedor no
   * exija tocar el código.
   */
  reasoningEffort?: string | null;
  /** `text.verbosity`. Mismas reglas. */
  verbosity?: string | null;
  /** Inyectable en pruebas; por defecto el fetch global. */
  fetchImpl?: typeof fetch;
}

export function createOpenAiModel(cfg: OpenAiAdapterConfig): AgentModel {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const model = cfg.model ?? OPENAI_DEFAULT_MODEL;
  const defaultTimeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Se resuelve UNA vez, al construir: el modelo no cambia entre turnos.
  const tunable = supportsResponseTuning(model);
  const reasoningEffort = cfg.reasoningEffort === undefined
    ? OPENAI_DEFAULT_REASONING_EFFORT
    : cfg.reasoningEffort;
  const verbosity = cfg.verbosity === undefined ? OPENAI_DEFAULT_VERBOSITY : cfg.verbosity;

  return {
    model,

    async complete(
      messages: readonly AgentModelInput[],
      options: AgentModelOptions = {},
    ): Promise<AgentModelResult> {
      if (!cfg.apiKey || messages.length === 0) {
        return { ok: false, error: 'not_configured' };
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? defaultTimeoutMs);

      const body: Record<string, unknown> = {
        model,
        input: messages,
        max_output_tokens: options.maxOutputTokens ?? OPENAI_DEFAULT_MAX_OUTPUT_TOKENS,
        stream: false,
        // No se guarda la conversación en OpenAI: la memoria es nuestra.
        store: false,
      };
      if (tunable && reasoningEffort) body.reasoning = { effort: reasoningEffort };
      if (tunable && verbosity) body.text = { verbosity };

      // Formato PLANO de la Responses API: `{type, name, description,
      // parameters}`, sin el envoltorio `function: {...}` de Chat Completions.
      // `strict` obliga al modelo a respetar el schema en vez de improvisar
      // argumentos que luego habría que rechazar.
      //
      // ── Por qué la política viaja SOLO si hay herramientas ──────────────────
      //
      // `tool_choice` y `parallel_tool_calls` describen QUÉ hacer con las
      // herramientas declaradas. Sin ninguna declarada no describen nada, así
      // que no se mandan: es la petición mínima que produce el comportamiento
      // pedido.
      //
      // NO es que el proveedor los rechace. Se comprobó contra la Responses API
      // real el 16-08-2026 (`evals/action-selection.eval.ts`, sonda): con
      // `tool_choice: 'none'`, con `parallel_tool_calls: false` y con los dos a
      // la vez, sin `tools`, devuelve 200 en los tres casos. Mandarlos sería
      // igual de correcto; simplemente no aporta nada.
      //
      // No se pierde intención: sin herramientas, `none` es lo único que puede
      // pasar. La ronda de redacción del core manda `tools: []` y `none`, y aquí
      // se traduce a "no mandar herramientas", que produce exactamente lo mismo.
      if (options.tools && options.tools.length > 0) {
        body.tools = options.tools.map((tool) => ({
          type: 'function',
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          strict: true,
        }));
        if (options.toolChoice !== undefined) body.tool_choice = options.toolChoice;
        if (options.parallelToolCalls !== undefined) {
          body.parallel_tool_calls = options.parallelToolCalls;
        }
      }

      try {
        const res = await fetchImpl(OPENAI_RESPONSES_URL, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${cfg.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        // El cuerpo del error puede traer eco del prompt: solo el status.
        if (!res.ok) return { ok: false, error: 'http_error', status: res.status };

        let json: unknown;
        try {
          json = await res.json();
        } catch {
          return { ok: false, error: 'invalid_response' };
        }

        const parsed = responsesSchema.safeParse(json);
        if (!parsed.success) return { ok: false, error: 'invalid_response' };

        if (parsed.data.status === 'failed') {
          return { ok: false, error: 'provider_failed' };
        }

        const { text, refused, toolCalls } = extractOutput(parsed.data);

        // Truncado: el texto existe pero está cortado a media frase. Se descarta
        // ANTES de mirar si hay contenido, porque un fragmento parece válido.
        if (parsed.data.status === 'incomplete') {
          return { ok: false, error: 'incomplete_response' };
        }

        // Pedir una herramienta ES una respuesta válida: aquí el texto vacío no
        // es un fallo, es un paso intermedio del turno.
        if (toolCalls.length > 0) {
          return { ok: true, text, model: parsed.data.model ?? model, toolCalls };
        }

        // Negativa sin texto alternativo: no hay nada que enviar.
        if (text === '' && refused) return { ok: false, error: 'refused' };
        // Sin texto utilizable NO se rellena con una frase inventada.
        if (text === '') return { ok: false, error: 'empty_response' };

        return { ok: true, text, model: parsed.data.model ?? model };
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          return { ok: false, error: 'timeout' };
        }
        return { ok: false, error: 'network_error' };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
