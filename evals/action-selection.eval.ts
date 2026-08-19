import { describe, it, expect } from 'vitest';
import { buildSelectionContext, type ContextMessage } from '@/lib/agent/core/context';
import type { AgentModelInput, AgentToolDefinition } from '@/lib/agent/core/model';
import { createOpenAiModel, OPENAI_RESPONSES_URL } from '@/lib/agent/openai/adapter';
import { LA_FIJA_MAX_OUTPUT_TOKENS, LA_FIJA_SYSTEM_PROMPT } from '@/lib/agent/business/prompt';
import { createAnswerDirectlyAction } from '@/lib/agent/tools/answer-directly';
import { createGetMenuItemsTool, createSendMenuTool } from '@/lib/agent/tools/menu-tools';

/**
 * EVAL DE SELECCIÓN DE ACCIÓN contra el modelo REAL (Fase 6D.2F.5B.1).
 *
 * ── Por qué existe ──────────────────────────────────────────────────────────
 *
 * La arquitectura de 5B.1 garantiza cosas de código: que no hay fallthrough
 * implícito, que siempre hay una acción estructurada, que un `send_menu`
 * confirmado no produce ninguna frase. Lo que NO garantiza es que el modelo
 * elija BIEN — puede contestar `answer_directly` a algo que pedía `send_menu`.
 *
 * Eso no se demuestra con un doble: un fake que devuelve la acción esperada
 * prueba el cableado, no la comprensión. Se mide llamando al modelo de verdad.
 *
 * ── Qué hace y qué NO hace ──────────────────────────────────────────────────
 *
 * Ejecuta SOLO la ronda de selección, con el prompt real, las definiciones
 * reales de las acciones y el contexto real de decisión.
 *
 *   NO ejecuta ninguna acción.      NO llama a dispatchMenu.
 *   NO toca Kapso ni WhatsApp.      NO escribe en Supabase.
 *   NO manda mensajes a nadie.
 *
 * Los puertos de las acciones son trampas que lanzan: si algo se ejecutara, se
 * vería. Lo único que sale de aquí es el NOMBRE de la acción elegida.
 *
 * Ni la clave ni el prompt completo se imprimen nunca.
 */

const apiKey = process.env.OPENAI_API_KEY ?? '';
// El modelo de Production. Se puede sobrescribir por entorno para comparar.
const model = process.env.OPENAI_MODEL ?? 'gpt-4.1-mini';
/** Tiradas por caso: la selección es probabilística, una sola no dice nada. */
const REPETICIONES = Number(process.env.EVAL_REPETICIONES ?? '3');
/** Peticiones en vuelo. Ni una a una (lento) ni todas (429). */
const CONCURRENCIA = 4;

type Accion = 'send_menu' | 'get_menu_items' | 'answer_directly';
type Categoria = 'broad' | 'factual' | 'general' | 'referencia' | 'contaminado';

interface Caso {
  id: string;
  categoria: Categoria;
  /** Historial previo, tal como lo devolvería el repositorio. */
  historial?: ContextMessage[];
  inbound: string;
  esperado: Accion;
}

// ── Helpers de historial ────────────────────────────────────────────────────

let reloj = 0;
function ts(): string {
  reloj += 1;
  return `2026-08-16T${String(10 + Math.floor(reloj / 60)).padStart(2, '0')}:${String(reloj % 60).padStart(2, '0')}:00.000Z`;
}

const cliente = (content: string): ContextMessage => ({
  actor: 'customer',
  role: 'user',
  content,
  // Desde 5C.4 el tipo decide si esto puede viajar como palabras del cliente.
  // El eval mide decisiones sobre texto real, así que aquí siempre es texto.
  contentType: 'text',
  messageTimestamp: ts(),
});

const asistente = (content: string): ContextMessage => ({
  actor: 'ai',
  role: 'assistant',
  content,
  contentType: 'text',
  messageTimestamp: ts(),
});

const menuEnviado = (): ContextMessage => ({
  actor: 'automation',
  role: 'assistant',
  content: '🍔 Mira nuestro menú, elige tus productos y arma tu pedido.',
  contentType: 'interactive',
  messageTimestamp: ts(),
  automationAction: 'send_menu',
});

/** La frase real de los cuatro salientes de IA del 16-08-2026. */
const CTA_FALSO =
  'Te paso el menú para que veas todas las opciones y precios, tocá Ver menú para elegir.';

// ── La matriz ───────────────────────────────────────────────────────────────

const CASOS: readonly Caso[] = [
  // BROAD BROWSE → send_menu. El grupo crítico.
  { id: 'broad-01', categoria: 'broad', inbound: 'Que opciones tienen?', esperado: 'send_menu' },
  { id: 'broad-02', categoria: 'broad', inbound: 'Que opciones tiene ?', esperado: 'send_menu' },
  { id: 'broad-03', categoria: 'broad', inbound: 'Qué tienen para comer?', esperado: 'send_menu' },
  { id: 'broad-04', categoria: 'broad', inbound: 'Quiero ver qué tienen', esperado: 'send_menu' },
  { id: 'broad-05', categoria: 'broad', inbound: 'Pasame lo que tienen', esperado: 'send_menu' },
  { id: 'broad-06', categoria: 'broad', inbound: 'Quiero mirar el menú', esperado: 'send_menu' },
  { id: 'broad-07', categoria: 'broad', inbound: 'Qué hamburguesas manejan?', esperado: 'send_menu' },
  { id: 'broad-08', categoria: 'broad', inbound: 'Que hay?', esperado: 'send_menu' },
  {
    id: 'broad-09',
    categoria: 'broad',
    // "y qué más" pide un antecedente: sin él la frase no significa nada.
    historial: [cliente('qué hamburguesas hay?'), menuEnviado()],
    inbound: 'y que más tienen?',
    esperado: 'send_menu',
  },
  { id: 'broad-10', categoria: 'broad', inbound: 'quiero ver opciones', esperado: 'send_menu' },

  // FACTUAL CONCRETO, acotado por el cliente → get_menu_items.
  {
    id: 'factual-01',
    categoria: 'factual',
    inbound: 'Cuánto cuesta la Doble o Nada?',
    esperado: 'get_menu_items',
  },
  { id: 'factual-02', categoria: 'factual', inbound: 'Tienen la Hat Trick?', esperado: 'get_menu_items' },
  { id: 'factual-03', categoria: 'factual', inbound: 'Cuánto sale la La Fija?', esperado: 'get_menu_items' },
  {
    id: 'factual-04',
    categoria: 'factual',
    inbound: 'Existe la Lomito Jackpot?',
    esperado: 'get_menu_items',
  },
  {
    id: 'factual-05',
    categoria: 'factual',
    // La elipsis que sostiene la regla del antecedente.
    historial: [cliente('qué hamburguesas hay?'), asistente('Tenemos la Doble o Nada.')],
    inbound: 'Y esa cuánto cuesta?',
    esperado: 'get_menu_items',
  },

  // GENERAL → answer_directly.
  { id: 'general-01', categoria: 'general', inbound: 'Hasta qué hora atienden?', esperado: 'answer_directly' },
  { id: 'general-02', categoria: 'general', inbound: 'Dónde están?', esperado: 'answer_directly' },
  { id: 'general-03', categoria: 'general', inbound: 'Quién eres?', esperado: 'answer_directly' },
  { id: 'general-04', categoria: 'general', inbound: 'Hacen delivery?', esperado: 'answer_directly' },
  { id: 'general-05', categoria: 'general', inbound: 'Cómo puedo pedir?', esperado: 'answer_directly' },

  // REFERENCIAS. Los dos primeros "Sí" son idénticos: solo el antecedente los
  // distingue, y es exactamente lo que la ventana de decisión conserva.
  {
    id: 'ref-si-menu',
    categoria: 'referencia',
    historial: [cliente('hola'), asistente('¿Querés que te pase el menú?')],
    inbound: 'Sí',
    esperado: 'send_menu',
  },
  {
    id: 'ref-dale-menu',
    categoria: 'referencia',
    historial: [cliente('hola'), asistente('¿Querés que te pase el menú?')],
    inbound: 'Dale',
    esperado: 'send_menu',
  },
  {
    id: 'ref-si-pago',
    categoria: 'referencia',
    historial: [cliente('hola'), asistente('¿Te explico cómo pagar?')],
    inbound: 'Sí',
    esperado: 'answer_directly',
  },

  // HISTORIAL CONTAMINADO: el estado REAL de producción hoy.
  {
    id: 'contaminado',
    categoria: 'contaminado',
    historial: [
      cliente('q tienen?'),
      menuEnviado(),
      asistente(CTA_FALSO),
      cliente('y de tomar?'),
      menuEnviado(),
      asistente(CTA_FALSO),
      cliente('gracias'),
      menuEnviado(),
      asistente(CTA_FALSO),
      cliente('ok'),
      menuEnviado(),
      asistente(CTA_FALSO),
    ],
    inbound: 'Que opciones tiene ?',
    esperado: 'send_menu',
  },
];

/**
 * Acciones que traen HECHOS del backend. `send_menu` pone el catálogo real en el
 * teléfono del cliente; `get_menu_items` lee `menu_items`. Las dos terminan en
 * un dato que existe.
 *
 * `answer_directly` no: es el modelo hablando.
 */
const ACCIONES_CON_RESPALDO: readonly Accion[] = ['send_menu', 'get_menu_items'];

/**
 * ¿Un fallo en este caso bloquea el deploy?
 *
 * El criterio NO es una lista de categorías, es el principio congelado del
 * proyecto: COMPRENDER es flexible, AFIRMAR exige respaldo. Si la acción
 * correcta era traer un hecho del backend y el modelo eligió `answer_directly`,
 * lo que queda es el modelo contestando de memoria un precio, una existencia o
 * un catálogo entero. Eso es exactamente lo que 5B.1 vino a impedir, y da igual
 * si la pregunta era amplia, puntual o venía por referencia.
 *
 * Al revés no es simétrico: donde lo correcto es `answer_directly`, una
 * desviación hacia `get_menu_items` cuesta una consulta de más y una respuesta
 * rara — molesto, no peligroso. Esos casos se REPORTAN. Convertirlos en barrera
 * dura empujaría a afinarlos con palabras, que es lo que esta arquitectura evita.
 */
function esHardGate(caso: Caso): boolean {
  return ACCIONES_CON_RESPALDO.includes(caso.esperado);
}

// ── Las acciones REALES, con los puertos cegados ────────────────────────────

function definicionesReales(): AgentToolDefinition[] {
  const trampa = (nombre: string) => (): never => {
    throw new Error(`el eval NO debe ejecutar acciones: se invocó ${nombre}`);
  };

  return [
    createSendMenuTool({ dispatch: trampa('dispatchMenu') }),
    createGetMenuItemsTool({ listForModel: trampa('listForModel') }),
    createAnswerDirectlyAction(),
  ].map((a) => a.definition);
}

// ── Contadores de uso, sin tocar el adaptador ───────────────────────────────

const uso = { entrada: 0, salida: 0, llamadas: 0 };

/**
 * `fetch` que lee el `usage` de la respuesta y la devuelve intacta.
 *
 * Se hace aquí y no en el adaptador a propósito: el eval tiene que ejercitar el
 * MISMO adaptador que corre en producción, sin una rama de instrumentación que
 * solo exista para medir.
 */
const contandoTokens: typeof fetch = async (input, init) => {
  const res = await fetch(input, init);
  uso.llamadas += 1;
  try {
    const cuerpo = (await res.clone().json()) as {
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    uso.entrada += cuerpo.usage?.input_tokens ?? 0;
    uso.salida += cuerpo.usage?.output_tokens ?? 0;
  } catch {
    // Cuerpo ilegible: el adaptador ya lo trata. Aquí solo se pierde la cuenta.
  }
  return res;
};

// ── Ejecución ───────────────────────────────────────────────────────────────

interface Resultado {
  caso: Caso;
  elegida: string | null;
  /** Código saneado cuando no hubo selección utilizable. */
  error: string | null;
}

async function seleccionar(caso: Caso): Promise<Resultado> {
  const openai = createOpenAiModel({ apiKey, model, fetchImpl: contandoTokens });

  const messages: AgentModelInput[] = [
    { role: 'system', content: LA_FIJA_SYSTEM_PROMPT },
    ...buildSelectionContext(caso.historial ?? [], { inboundText: caso.inbound }),
  ];

  const respuesta = await openai.complete(messages, {
    maxOutputTokens: LA_FIJA_MAX_OUTPUT_TOKENS,
    tools: definicionesReales(),
    toolChoice: 'required',
    parallelToolCalls: false,
  });

  if (!respuesta.ok) {
    return { caso, elegida: null, error: `model.${respuesta.error}` };
  }
  const llamadas = respuesta.toolCalls ?? [];
  if (llamadas.length !== 1) {
    return {
      caso,
      elegida: null,
      error: llamadas.length === 0 ? 'selection.no_action' : 'selection.multiple_actions',
    };
  }
  return { caso, elegida: llamadas[0].name, error: null };
}

/** Pool sencillo: `CONCURRENCIA` peticiones en vuelo, sin dependencias. */
async function enPool<T, R>(items: readonly T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let siguiente = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCIA, items.length) }, async () => {
      for (;;) {
        const i = siguiente++;
        if (i >= items.length) return;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

describe('eval — selección de acción con el modelo real', () => {
  it.skipIf(apiKey === '')(
    'la matriz completa, repetida',
    async () => {
      const tiradas = CASOS.flatMap((caso) =>
        Array.from({ length: REPETICIONES }, () => caso),
      );

      const resultados = await enPool(tiradas, seleccionar);

      // ── Informe ───────────────────────────────────────────────────────────
      const porCaso = new Map<string, Resultado[]>();
      for (const r of resultados) {
        const previos = porCaso.get(r.caso.id) ?? [];
        previos.push(r);
        porCaso.set(r.caso.id, previos);
      }

      const lineas: string[] = [];
      const porCategoria = new Map<Categoria, { ok: number; total: number }>();
      const fallos: Resultado[] = [];

      for (const caso of CASOS) {
        const rs = porCaso.get(caso.id) ?? [];
        const aciertos = rs.filter((r) => r.elegida === caso.esperado).length;
        const acc = porCategoria.get(caso.categoria) ?? { ok: 0, total: 0 };
        acc.ok += aciertos;
        acc.total += rs.length;
        porCategoria.set(caso.categoria, acc);

        for (const r of rs) if (r.elegida !== caso.esperado) fallos.push(r);

        const marca = aciertos === rs.length ? 'OK  ' : 'FALLA';
        const puerta = esHardGate(caso) ? 'HARD  ' : 'report';
        const elegidas = rs.map((r) => r.error ?? r.elegida).join(', ');
        lineas.push(
          `${marca} ${puerta} ${caso.id.padEnd(14)} ${caso.categoria.padEnd(12)} ` +
            `${aciertos}/${rs.length}  esperado=${caso.esperado}  obtenido=[${elegidas}]`,
        );
      }

      const totalOk = resultados.filter((r) => r.elegida === r.caso.esperado).length;

      console.log('\n══ EVAL DE SELECCIÓN DE ACCIÓN ══');
      console.log(`modelo=${model}  casos=${CASOS.length}  repeticiones=${REPETICIONES}  ejecuciones=${resultados.length}`);
      console.log('');
      for (const l of lineas) console.log(l);
      console.log('');
      for (const [categoria, acc] of porCategoria) {
        const pct = ((acc.ok / acc.total) * 100).toFixed(1);
        console.log(`${categoria.padEnd(12)} ${acc.ok}/${acc.total}  (${pct}%)`);
      }
      console.log(`\nTOTAL ${totalOk}/${resultados.length}`);
      console.log(
        `tokens  entrada=${uso.entrada}  salida=${uso.salida}  llamadas=${uso.llamadas}`,
      );

      const duros = resultados.filter((r) => esHardGate(r.caso));
      const durosOk = duros.filter((r) => r.elegida === r.caso.esperado);
      const blandos = resultados.filter((r) => !esHardGate(r.caso));
      const blandosOk = blandos.filter((r) => r.elegida === r.caso.esperado);
      console.log(
        `\nHARD GATE (acción con respaldo) ${durosOk.length}/${duros.length}` +
          `   ·   report-only ${blandosOk.length}/${blandos.length}`,
      );

      if (fallos.length > 0) {
        console.log('\n── Fallos, con la acción que eligió ──');
        for (const f of fallos) {
          console.log(
            `  ${esHardGate(f.caso) ? 'HARD  ' : 'report'} ${f.caso.id.padEnd(14)} ` +
              `esperado=${f.caso.esperado.padEnd(15)} eligió=${f.error ?? f.elegida}`,
          );
        }
      }
      console.log('');

      // ── Criterio ──────────────────────────────────────────────────────────
      // Bloquea todo caso cuya acción correcta traía un hecho del backend: broad
      // browse, historial contaminado, factual concreto y la referencia factual.
      // Ver `esHardGate` para el porqué. Lo demás se reporta.
      expect(
        durosOk.length,
        `HARD GATE ${durosOk.length}/${duros.length}. Un fallo aquí significa que ` +
          'el modelo contestó de memoria algo que exigía respaldo. NO se arregla ' +
          'con keywords: revisar descripciones de las acciones, contexto ' +
          'disponible y taxonomía.',
      ).toBe(duros.length);
    },
  );

  /**
   * SONDA DEL PROVEEDOR, no prueba del adaptador (6D.2F.5B.1 §9).
   *
   * El adaptador omite `tool_choice` y `parallel_tool_calls` cuando no hay
   * herramientas declaradas. La decisión se tomó por precaución, y una
   * precaución sin comprobar es una conjetura.
   *
   * ── Ya está comprobado (16-08-2026, gpt-4.1-mini) ───────────────────────────
   *
   *   tool_choice:'none' sin tools           → HTTP 200
   *   parallel_tool_calls:false sin tools    → HTTP 200
   *   ambos                                  → HTTP 200
   *
   * O sea: la Responses API los acepta. La omisión del adaptador NO evita un
   * error del proveedor — fija la petición mínima, que es una razón distinta y
   * más pequeña. El comportamiento se mantiene tal cual: sin herramientas
   * declaradas ninguna puede ejecutarse de todos modos, así que mandarlos no
   * cambiaría nada.
   *
   * La sonda se queda para volver a preguntarlo el día que el proveedor cambie.
   * No manda nada a nadie: `max_output_tokens` mínimo y `store: false`.
   */
  it.skipIf(apiKey === '')('sonda: tool_choice sin herramientas', async () => {
    const sonda = async (body: Record<string, unknown>) => {
      const res = await fetch(OPENAI_RESPONSES_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          input: [{ role: 'user', content: 'hola' }],
          max_output_tokens: 16,
          store: false,
          ...body,
        }),
      });
      return res.status;
    };

    const soloChoice = await sonda({ tool_choice: 'none' });
    const soloParalelo = await sonda({ parallel_tool_calls: false });
    const ambos = await sonda({ tool_choice: 'none', parallel_tool_calls: false });

    console.log('\n══ SONDA: política sin herramientas ══');
    console.log(`tool_choice:'none'                      → HTTP ${soloChoice}`);
    console.log(`parallel_tool_calls:false               → HTTP ${soloParalelo}`);
    console.log(`ambos                                   → HTTP ${ambos}`);
    console.log(
      soloChoice === 200 && soloParalelo === 200 && ambos === 200
        ? 'El proveedor los acepta sin herramientas: la omisión del adaptador es' +
            ' innecesaria (no incorrecta).'
        : 'El proveedor RECHAZA alguna: la omisión del adaptador es necesaria.',
    );
    console.log('');

    // Sin aserción de resultado: esto MIDE, no exige. Lo único que se comprueba
    // es que la sonda llegó a hablar con el proveedor.
    expect([soloChoice, soloParalelo, ambos].every((s) => s > 0)).toBe(true);
  });
});
