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
 * "No hace falta ninguna acción" no es un concepto de La Fija: cualquier
 * catálogo de acciones necesita poder decirlo. Lo específico del negocio son
 * `send_menu` y `get_menu_items`, y esos sí viven en `menu-tools.ts`.
 */

export const ANSWER_DIRECTLY = 'answer_directly';

/**
 * La descripción es lo ÚNICO que el modelo lee para saber cuándo usarla, así
 * que dice para qué sirve y, sobre todo, para qué no: es la salida de las
 * conversaciones normales, nunca el atajo para no mandar el menú.
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
        'decirlo. NO la uses para escaparte de mandar el menú: si el cliente ' +
        'quiere ver qué hay, qué opciones existen o qué contiene una categoría, ' +
        'eso es send_menu, y contestarlo hablando sería enumerarle el catálogo ' +
        'en el chat. Tampoco la uses para responder de memoria un precio o si ' +
        'existe un producto: eso es get_menu_items.',
      parameters: NO_ARGUMENTS,
    },
    // Sin `execute` a propósito: no hay nada que ejecutar. Ver el encabezado.
  };
}
