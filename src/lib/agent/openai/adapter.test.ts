import { describe, it, expect } from 'vitest';
import {
  createOpenAiModel,
  supportsResponseTuning,
  OPENAI_DEFAULT_MAX_OUTPUT_TOKENS,
  OPENAI_DEFAULT_MODEL,
  OPENAI_RESPONSES_URL,
  type OpenAiAdapterConfig,
} from './adapter';
import type { AgentModelMessage } from '@/lib/agent/core/model';

/** Modelo de producción de la Fase 6D.2F.4. */
const PROD_MODEL = 'gpt-5.6-terra';

/**
 * Adaptador de OpenAI — Responses API (Fase 6D.2F.3.1).
 *
 * `fetch` inyectado: aquí no se hace ni una llamada real. Lo que se verifica es
 * la forma de la petición, el parseo de la estructura RAW —no la comodidad
 * `output_text` del SDK, que en el JSON crudo no es fiable— y que ningún error
 * arrastre la clave ni el prompt.
 */

const API_KEY = 'sk-clave-de-prueba-no-real';

const MESSAGES: AgentModelMessage[] = [
  { role: 'system', content: 'eres el asistente' },
  { role: 'user', content: 'hola' },
];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Respuesta RAW realista de `POST /v1/responses`.
 *
 * Incluye a propósito un item `reasoning` ANTES del `message` y una anotación
 * dentro del contenido: es la forma que devuelven los modelos de razonamiento y
 * la razón por la que el parser no puede indexar `output[0]` ni `content[0]`.
 */
function rawResponse(over: Record<string, unknown> = {}) {
  return {
    id: 'resp_abc123',
    object: 'response',
    created_at: 1786666333,
    status: 'completed',
    model: 'gpt-4o-mini-2024-07-18',
    output: [
      {
        id: 'rs_001',
        type: 'reasoning',
        summary: [],
      },
      {
        id: 'msg_001',
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [
          {
            type: 'output_text',
            text: 'si, estamos abiertos hasta las 10',
            annotations: [],
          },
        ],
      },
    ],
    usage: { input_tokens: 40, output_tokens: 12, total_tokens: 52 },
    ...over,
  };
}

function fakeFetch(response: Response | (() => Promise<Response>)) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return typeof response === 'function' ? response() : response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function model(response: Response | (() => Promise<Response>), apiKey = API_KEY) {
  const { impl, calls } = fakeFetch(response);
  return { model: createOpenAiModel({ apiKey, fetchImpl: impl }), calls };
}

/** Igual, pero con configuración a medida (modelo, effort, verbosity…). */
function modelWith(cfg: Partial<OpenAiAdapterConfig>) {
  const { impl, calls } = fakeFetch(json(rawResponse()));
  const m = createOpenAiModel({ apiKey: API_KEY, fetchImpl: impl, ...cfg });
  return {
    async body() {
      await m.complete(MESSAGES);
      return JSON.parse(calls[0].init.body as string) as Record<string, unknown>;
    },
  };
}

describe('openai adapter — petición', () => {
  it('llama a /v1/responses con input, tope de salida y sin streaming', async () => {
    const { model: m, calls } = model(json(rawResponse()));

    await m.complete(MESSAGES, { maxOutputTokens: 120 });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(OPENAI_RESPONSES_URL);
    expect(calls[0].url).toBe('https://api.openai.com/v1/responses');
    const body = JSON.parse(calls[0].init.body as string);
    expect(body).toMatchObject({
      model: OPENAI_DEFAULT_MODEL,
      input: MESSAGES,
      max_output_tokens: 120,
      stream: false, // WhatsApp recibe un mensaje terminado, no trozos
      store: false, // la memoria de la conversación es NUESTRA
    });
  });

  it('el host es constante: no hay forma de redirigir el Bearer a otro sitio', async () => {
    // `OPENAI_BASE_URL` se eliminó a propósito. Para probar se inyecta fetch,
    // no se reapunta la URL.
    const { model: m, calls } = model(json(rawResponse()));
    await m.complete(MESSAGES);

    expect(calls[0].url.startsWith('https://api.openai.com/')).toBe(true);
    expect(Object.keys(createOpenAiModel({ apiKey: API_KEY }))).not.toContain('baseUrl');
  });

  it('sin clave no toca la red', async () => {
    const { model: m, calls } = model(json(rawResponse()), '');

    expect(await m.complete(MESSAGES)).toEqual({ ok: false, error: 'not_configured' });
    expect(calls).toEqual([]);
  });

  it('sin mensajes no toca la red', async () => {
    const { model: m, calls } = model(json(rawResponse()));

    expect(await m.complete([])).toEqual({ ok: false, error: 'not_configured' });
    expect(calls).toEqual([]);
  });
});

describe('openai adapter — control del tamaño de la salida', () => {
  it('el techo por defecto son 300 tokens, no el del proveedor', async () => {
    const body = await modelWith({}).body();

    expect(body.max_output_tokens).toBe(OPENAI_DEFAULT_MAX_OUTPUT_TOKENS);
    expect(OPENAI_DEFAULT_MAX_OUTPUT_TOKENS).toBe(300);
  });

  it('gpt-5.x recibe effort none y verbosity low', async () => {
    const body = await modelWith({ model: PROD_MODEL }).body();

    expect(body).toMatchObject({
      model: PROD_MODEL,
      reasoning: { effort: 'none' },
      text: { verbosity: 'low' },
      max_output_tokens: 300,
    });
  });

  it('un modelo que no los admite NO los recibe: cambiar OPENAI_MODEL no rompe el envío', async () => {
    for (const m of [OPENAI_DEFAULT_MODEL, 'gpt-4o', 'gpt-5', 'gpt-6-mini', 'o4-mini']) {
      const body = await modelWith({ model: m }).body();

      expect(Object.keys(body), m).not.toContain('reasoning');
      expect(Object.keys(body), m).not.toContain('text');
      // Y el resto de la petición sigue completa.
      expect(body, m).toMatchObject({ model: m, input: MESSAGES, stream: false });
    }
  });

  it('la familia soportada está acotada a gpt-5.x', () => {
    expect(supportsResponseTuning('gpt-5.6-terra')).toBe(true);
    expect(supportsResponseTuning('gpt-5.1')).toBe(true);
    // `gpt-5` a secas no admite effort:'none'; los demás ni conocen los campos.
    expect(supportsResponseTuning('gpt-5')).toBe(false);
    expect(supportsResponseTuning('gpt-5-mini')).toBe(false);
    expect(supportsResponseTuning('gpt-4o-mini')).toBe(false);
    expect(supportsResponseTuning('')).toBe(false);
  });

  it('se pueden ajustar sin tocar el código', async () => {
    const body = await modelWith({
      model: PROD_MODEL,
      reasoningEffort: 'low',
      verbosity: 'medium',
    }).body();

    expect(body).toMatchObject({ reasoning: { effort: 'low' }, text: { verbosity: 'medium' } });
  });

  it('null los desactiva aunque el modelo los admita', async () => {
    const body = await modelWith({
      model: PROD_MODEL,
      reasoningEffort: null,
      verbosity: null,
    }).body();

    expect(Object.keys(body)).not.toContain('reasoning');
    expect(Object.keys(body)).not.toContain('text');
  });

  it('el negocio manda sobre el techo de tokens', async () => {
    const { model: m, calls } = model(json(rawResponse()));

    await m.complete(MESSAGES, { maxOutputTokens: 400 });

    expect(JSON.parse(calls[0].init.body as string).max_output_tokens).toBe(400);
  });
});

describe('openai adapter — parseo RAW de la Responses API', () => {
  it('200 + completed + texto válido => ok', async () => {
    const { model: m } = model(json(rawResponse()));

    expect(await m.complete(MESSAGES)).toEqual({
      ok: true,
      text: 'si, estamos abiertos hasta las 10',
      model: 'gpt-4o-mini-2024-07-18',
    });
  });

  it('NO asume output[0]: salta reasoning y encuentra el message', async () => {
    // El fixture pone `reasoning` primero justamente para esto.
    const { model: m } = model(json(rawResponse()));
    const result = await m.complete(MESSAGES);

    expect(result).toMatchObject({ ok: true });
  });

  it('NO asume content[0]: recoge el output_text aunque vaya después de un refusal', async () => {
    const { model: m } = model(
      json(
        rawResponse({
          output: [
            {
              type: 'message',
              content: [
                { type: 'refusal', refusal: 'no puedo con eso' },
                { type: 'output_text', text: 'pero sí puedo ayudarte con el pedido' },
              ],
            },
          ],
        }),
      ),
    );

    expect(await m.complete(MESSAGES)).toMatchObject({
      ok: true,
      text: 'pero sí puedo ayudarte con el pedido',
    });
  });

  it('concatena varios output_text y varios items message, en orden', async () => {
    const { model: m } = model(
      json(
        rawResponse({
          output: [
            { type: 'message', content: [{ type: 'output_text', text: 'primero. ' }] },
            { type: 'web_search_call', status: 'completed' },
            { type: 'message', content: [{ type: 'output_text', text: 'segundo.' }] },
          ],
        }),
      ),
    );

    expect(await m.complete(MESSAGES)).toMatchObject({ ok: true, text: 'primero. segundo.' });
  });

  it('ignora items que no son message aunque traigan texto', async () => {
    const { model: m } = model(
      json(
        rawResponse({
          output: [
            { type: 'reasoning', content: [{ type: 'output_text', text: 'pensamiento privado' }] },
            { type: 'message', content: [{ type: 'output_text', text: 'respuesta' }] },
          ],
        }),
      ),
    );

    const result = await m.complete(MESSAGES);
    expect(result).toMatchObject({ ok: true, text: 'respuesta' });
    expect(JSON.stringify(result)).not.toContain('pensamiento privado');
  });
});

describe('openai adapter — herramientas (Fase 6D.2F.5B)', () => {
  const TOOLS = [
    { name: 'get_menu_items', description: 'trae el menú', parameters: { type: 'object', properties: {} } },
  ];

  it('las manda en el formato PLANO de la Responses API, con strict', async () => {
    // Chat Completions anida bajo `function: {...}`; Responses no. Mandarlo con
    // la forma equivocada es un 400 que solo se ve en producción.
    const { model: m, calls } = model(json(rawResponse()));

    await m.complete(MESSAGES, { tools: TOOLS });

    const body = JSON.parse(calls[0].init.body as string);
    expect(body.tools).toEqual([
      {
        type: 'function',
        name: 'get_menu_items',
        description: 'trae el menú',
        parameters: { type: 'object', properties: {} },
        strict: true,
      },
    ]);
    expect(body.tools[0]).not.toHaveProperty('function');
  });

  it('sin herramientas no se manda la clave: el turno es idéntico al de antes', async () => {
    const { model: m, calls } = model(json(rawResponse()));

    await m.complete(MESSAGES);

    expect(Object.keys(JSON.parse(calls[0].init.body as string))).not.toContain('tools');
  });

  // ── Política de selección (Fase 6D.2F.5B.1) ───────────────────────────────

  it('A · traduce toolChoice a `tool_choice`', async () => {
    // La ronda de decisión no puede permitirse un "el modelo prefirió no
    // llamar a ninguna": eso era, literalmente, el camino del fallo.
    const { model: m, calls } = model(json(rawResponse()));

    await m.complete(MESSAGES, { tools: TOOLS, toolChoice: 'required' });

    expect(JSON.parse(calls[0].init.body as string).tool_choice).toBe('required');
  });

  it('B · traduce parallelToolCalls a `parallel_tool_calls`', async () => {
    const { model: m, calls } = model(json(rawResponse()));

    await m.complete(MESSAGES, { tools: TOOLS, parallelToolCalls: false });

    expect(JSON.parse(calls[0].init.body as string).parallel_tool_calls).toBe(false);
  });

  it('los tres valores del puerto viajan tal cual', async () => {
    for (const choice of ['auto', 'required', 'none'] as const) {
      const { model: m, calls } = model(json(rawResponse()));
      await m.complete(MESSAGES, { tools: TOOLS, toolChoice: choice });
      expect(JSON.parse(calls[0].init.body as string).tool_choice, choice).toBe(choice);
    }
  });

  it('sin política declarada no se manda ninguna de las dos claves', async () => {
    const { model: m, calls } = model(json(rawResponse()));

    await m.complete(MESSAGES, { tools: TOOLS });

    const keys = Object.keys(JSON.parse(calls[0].init.body as string));
    expect(keys).not.toContain('tool_choice');
    expect(keys).not.toContain('parallel_tool_calls');
  });

  it('sin herramientas la política NO viaja: describiría un conjunto vacío', async () => {
    // `tool_choice` y `parallel_tool_calls` dicen qué hacer con las herramientas
    // declaradas. Sin ninguna no dicen nada, así que la petición no los lleva.
    //
    // No es que el proveedor los rechace: la sonda del eval los mandó sin
    // `tools` contra la Responses API real (16-08-2026) y devolvió 200 en las
    // tres combinaciones. Esto fija la petición MÍNIMA, no una restricción
    // ajena. Y no se pierde intención: sin herramientas, `none` es lo único que
    // puede pasar.
    const { model: m, calls } = model(json(rawResponse()));

    await m.complete(MESSAGES, { toolChoice: 'none', parallelToolCalls: false });

    const keys = Object.keys(JSON.parse(calls[0].init.body as string));
    expect(keys).not.toContain('tool_choice');
    expect(keys).not.toContain('parallel_tool_calls');
    expect(keys).not.toContain('tools');
  });

  it('H · reasoning + function_call: se clasifica por TIPO, no por posición', async () => {
    const { model: m } = model(
      json(
        rawResponse({
          output: [
            { id: 'rs_1', type: 'reasoning', summary: [] },
            {
              id: 'fc_1',
              type: 'function_call',
              call_id: 'call_abc',
              name: 'get_menu_items',
              arguments: '{}',
            },
          ],
        }),
      ),
    );

    expect(await m.complete(MESSAGES, { tools: TOOLS })).toEqual({
      ok: true,
      text: '',
      model: 'gpt-4o-mini-2024-07-18',
      toolCalls: [{ callId: 'call_abc', name: 'get_menu_items', arguments: '{}' }],
    });
  });

  it('pedir una herramienta con texto vacío NO es empty_response', async () => {
    // Es el fallo que rompería el loop entero: pedir una tool ES la respuesta
    // de ese paso.
    const { model: m } = model(
      json(
        rawResponse({
          output: [
            { type: 'function_call', call_id: 'c1', name: 'send_menu', arguments: '{}' },
          ],
        }),
      ),
    );

    expect(await m.complete(MESSAGES, { tools: TOOLS })).toMatchObject({ ok: true });
  });

  it('varias llamadas en un mismo output se recogen todas, en orden', async () => {
    const { model: m } = model(
      json(
        rawResponse({
          output: [
            { type: 'function_call', call_id: 'c1', name: 'get_menu_items', arguments: '{}' },
            { type: 'message', content: [{ type: 'output_text', text: 'un momento' }] },
            { type: 'function_call', call_id: 'c2', name: 'send_menu', arguments: '{}' },
          ],
        }),
      ),
    );

    const result = await m.complete(MESSAGES, { tools: TOOLS });

    expect(result).toMatchObject({
      ok: true,
      text: 'un momento',
      toolCalls: [
        { callId: 'c1', name: 'get_menu_items' },
        { callId: 'c2', name: 'send_menu' },
      ],
    });
  });

  it('una llamada sin call_id se descarta en vez de inventarle uno', async () => {
    // Sin call_id el resultado no podría casar con su llamada, y la API
    // rechazaría el siguiente paso.
    const { model: m } = model(
      json(
        rawResponse({
          output: [
            { type: 'function_call', name: 'get_menu_items', arguments: '{}' },
            { type: 'message', content: [{ type: 'output_text', text: 'igual te ayudo' }] },
          ],
        }),
      ),
    );

    expect(await m.complete(MESSAGES, { tools: TOOLS })).toEqual({
      ok: true,
      text: 'igual te ayudo',
      model: 'gpt-4o-mini-2024-07-18',
    });
  });

  it('un turno normal NO trae la clave toolCalls', async () => {
    // Así el resto del sistema no tiene que distinguir "sin tools" de "tools
    // vacías": la forma es la misma que antes de esta fase.
    const result = await model(json(rawResponse())).model.complete(MESSAGES);

    expect(result).toEqual({
      ok: true,
      text: 'si, estamos abiertos hasta las 10',
      model: 'gpt-4o-mini-2024-07-18',
    });
    expect(Object.keys(result)).not.toContain('toolCalls');
  });

  it('los items de conversación y los de herramienta viajan tal cual en input', async () => {
    const { model: m, calls } = model(json(rawResponse()));

    await m.complete([
      { role: 'system', content: 'reglas' },
      { type: 'function_call', call_id: 'c1', name: 'send_menu', arguments: '{}' },
      { type: 'function_call_output', call_id: 'c1', output: '{"sent":true}' },
    ]);

    expect(JSON.parse(calls[0].init.body as string).input).toEqual([
      { role: 'system', content: 'reglas' },
      { type: 'function_call', call_id: 'c1', name: 'send_menu', arguments: '{}' },
      { type: 'function_call_output', call_id: 'c1', output: '{"sent":true}' },
    ]);
  });
});

describe('openai adapter — respuestas no utilizables', () => {
  it('output vacío => empty_response', async () => {
    const { model: m } = model(json(rawResponse({ output: [] })));
    expect(await m.complete(MESSAGES)).toEqual({ ok: false, error: 'empty_response' });
  });

  it('sin output en absoluto => empty_response', async () => {
    const { model: m } = model(json({ status: 'completed', model: 'gpt-4o-mini' }));
    expect(await m.complete(MESSAGES)).toEqual({ ok: false, error: 'empty_response' });
  });

  it('message sin ningún output_text => empty_response', async () => {
    const { model: m } = model(
      json(
        rawResponse({
          output: [{ type: 'message', content: [{ type: 'algo_nuevo', text: 'x' }] }],
        }),
      ),
    );
    expect(await m.complete(MESSAGES)).toEqual({ ok: false, error: 'empty_response' });
  });

  it('solo refusal => refused, nunca se envía la negativa como si fuera respuesta', async () => {
    const { model: m } = model(
      json(
        rawResponse({
          output: [
            { type: 'message', content: [{ type: 'refusal', refusal: 'no puedo ayudar con eso' }] },
          ],
        }),
      ),
    );

    const result = await m.complete(MESSAGES);
    expect(result).toEqual({ ok: false, error: 'refused' });
    expect(JSON.stringify(result)).not.toContain('no puedo ayudar');
  });

  it('status incomplete => incomplete_response, aunque haya texto parcial', async () => {
    // Texto cortado por el tope de tokens: media frase al cliente es peor que
    // el silencio, así que se descarta entero.
    const { model: m } = model(
      json(
        rawResponse({
          status: 'incomplete',
          incomplete_details: { reason: 'max_output_tokens' },
          output: [
            { type: 'message', content: [{ type: 'output_text', text: 'tu pedido de dos hamb' }] },
          ],
        }),
      ),
    );

    expect(await m.complete(MESSAGES)).toEqual({ ok: false, error: 'incomplete_response' });
  });

  it('status failed => provider_failed', async () => {
    const { model: m } = model(json(rawResponse({ status: 'failed', output: [] })));
    expect(await m.complete(MESSAGES)).toEqual({ ok: false, error: 'provider_failed' });
  });

  it('texto en blanco => empty_response', async () => {
    const { model: m } = model(
      json(rawResponse({ output: [{ type: 'message', content: [{ type: 'output_text', text: '   ' }] }] })),
    );
    expect(await m.complete(MESSAGES)).toEqual({ ok: false, error: 'empty_response' });
  });
});

describe('openai adapter — errores de transporte', () => {
  it('JSON malformado => invalid_response', async () => {
    const { model: m } = model(new Response('no soy json', { status: 200 }));
    expect(await m.complete(MESSAGES)).toEqual({ ok: false, error: 'invalid_response' });
  });

  it('forma inesperada => invalid_response', async () => {
    const { model: m } = model(json({ output: 'esto deberia ser un array' }));
    expect(await m.complete(MESSAGES)).toEqual({ ok: false, error: 'invalid_response' });
  });

  it('4xx, 429 y 5xx => http_error con su status, sin el cuerpo', async () => {
    for (const status of [400, 401, 429, 500, 503]) {
      const { model: m } = model(
        json({ error: { message: 'eco del prompt: eres el asistente' } }, status),
      );
      const result = await m.complete(MESSAGES);

      expect(result, `status ${status}`).toEqual({ ok: false, error: 'http_error', status });
      expect(JSON.stringify(result)).not.toContain('eco del prompt');
    }
  });

  it('timeout => timeout', async () => {
    const impl = (async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    }) as unknown as typeof fetch;

    expect(await createOpenAiModel({ apiKey: API_KEY, fetchImpl: impl }).complete(MESSAGES))
      .toEqual({ ok: false, error: 'timeout' });
  });

  it('fallo de red => network_error', async () => {
    const impl = (async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;

    expect(await createOpenAiModel({ apiKey: API_KEY, fetchImpl: impl }).complete(MESSAGES))
      .toEqual({ ok: false, error: 'network_error' });
  });
});

describe('openai adapter — secretos y códigos', () => {
  it('la clave viaja en el header y no aparece en ningún resultado', async () => {
    const { model: m, calls } = model(new Response('roto', { status: 500 }));

    const result = await m.complete(MESSAGES);

    expect((calls[0].init.headers as Record<string, string>).authorization).toBe(
      `Bearer ${API_KEY}`,
    );
    expect(JSON.stringify(result)).not.toContain(API_KEY);
  });

  it('ningún resultado arrastra el prompt', async () => {
    for (const respuesta of [
      json(rawResponse({ status: 'incomplete' })),
      json(rawResponse({ output: [] })),
      json({ error: { message: 'x' } }, 429),
    ]) {
      const { model: m } = model(respuesta);
      const dump = JSON.stringify(await m.complete(MESSAGES));
      expect(dump).not.toContain('eres el asistente');
    }
  });

  it('todos los códigos caben en agent_runs.error_code', async () => {
    for (const error of [
      'not_configured',
      'timeout',
      'network_error',
      'http_error',
      'invalid_response',
      'empty_response',
      'incomplete_response',
      'refused',
      'provider_failed',
    ]) {
      expect(`model.${error}`).toMatch(/^[A-Za-z0-9._:-]{1,64}$/);
    }
    // Con status incrustado (el core lo añade en http_error).
    expect('model.http_error.429').toMatch(/^[A-Za-z0-9._:-]{1,64}$/);
  });
});
