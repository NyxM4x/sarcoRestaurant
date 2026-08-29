import { NO_ARGUMENTS, type AgentTool } from './registry';

/**
 * La acción de NO actuar — módulo PURO (Fase 6D.2F.5B.1).
 *
 * ── Qué problema resuelve ───────────────────────────────────────────────────
 *
 * Antes, "el modelo no llamó a ninguna herramienta" era el camino POR DEFECTO:
 * no había que elegirlo, se llegaba a él por omisión. Y una omisión no deja
 * rastro. El 16-08-2026, ante "Que opciones tiene ?", el turno acabó con
 * `tool_rounds = 0` y una frase que afirmaba haber mandado el menú: en la base
 * no había nada que distinguir "decidió contestar hablando" de "se olvidó de
 * decidir". Las dos se ven igual: silencio.
 *
 * Con esta acción, contestar hablando deja de ser el hueco por el que se cae el
 * turno y pasa a ser una elección con nombre, registrada y contable.
 *
 * ── Qué NO hace ─────────────────────────────────────────────────────────────
 *
 * Nada. No tiene `execute`: no consulta, no envía, no toca la base y no produce
 * ningún efecto que el cliente vea. Seleccionarla significa exactamente una
 * cosa, ni más ni menos:
 *
 *   "este turno no necesita ninguna acción de negocio antes de responder".
 *
 * Después de elegirla, el core pide el texto en una segunda llamada normal, sin
 * herramientas. Por eso tampoco viaja ningún `function_call_output` suyo a esa
 * ronda: no hay resultado que llevar, y meter el rastro de una acción vacía solo
 * le daría al modelo algo de lo que hablar.
 *
 * ── Por qué vive aquí y no en el Business Adapter ───────────────────────────
 *
 * "No hace falta ninguna acción" no es un concepto de Don Zarco: cualquier
 * catálogo de acciones necesita poder decirlo. Lo específico del negocio son
 * `send_menu` y `get_menu_items`, y esos sí viven en `menu-tools.ts`.
 */

export const ANSWER_DIRECTLY = 'answer_directly';

/**
 * La descripción es lo ÚNICO que el modelo lee para saber cuándo usarla, así
 * que dice para qué sirve y, sobre todo, para qué no: es la salida de las
 * conversaciones normales, nunca el atajo para no mandar el menú.
 *
 * ── Por qué la exclusión de precios dice "PRODUCTO del menú" ────────────────
 *
 * Porque decía solo "un precio", y el 29-08-2026 eso derivó una conversación en
 * su primer mensaje. Ante "hola como esta zarco cuanto me saldria delivery
 * aqui", el modelo se quedó sin puerta: no pedía el menú, el envío no es un
 * producto que `get_menu_items` pueda buscar, y esta acción se autoexcluía por
 * la palabra "precio". La única casilla libre era `request_human` — y el
 * cliente se llevó dos horas de silencio por preguntar cuánto cuesta que se lo
 * lleven.
 *
 * La lección no es "afinar palabras": es que con `toolChoice: 'required'` el
 * modelo SIEMPRE elige algo, así que cada exclusión que se escribe aquí empuja
 * casos hacia otra acción. Hay que saber hacia cuál. Una exclusión sin salida
 * declarada acaba en la acción más cara que haya en el catálogo.
 */
export function createAnswerDirectlyAction(): AgentTool {
  return {
    definition: {
      name: ANSWER_DIRECTLY,
      description:
        'Responde con tus propias palabras, sin consultar ni enviar nada. ' +
        'Úsala cuando la respuesta no necesita datos del menú ni mandarlo: ' +
        'saludos, agradecimientos, horarios, dónde están, quién eres, ' +
        'conversación normal, o cuando no tienes la información y hay que ' +
        'decirlo. También cuando preguntan cuánto sale el envío o el delivery: ' +
        'no das el monto, le pides que comparta su ubicación y el sistema se lo ' +
        'cotiza. NO la uses para escaparte de mandar el menú: si el cliente ' +
        'quiere ver qué hay, qué opciones existen o qué contiene una categoría, ' +
        'eso es send_menu, y contestarlo hablando sería enumerarle el catálogo ' +
        'en el chat. Tampoco la uses para responder de memoria el precio de un ' +
        'PRODUCTO del menú ni si existe: eso es get_menu_items.',
      parameters: NO_ARGUMENTS,
    },
    // Sin `execute` a propósito: no hay nada que ejecutar. Ver el encabezado.
  };
}
