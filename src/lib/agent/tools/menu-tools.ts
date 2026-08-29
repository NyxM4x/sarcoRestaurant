import {
  NO_ARGUMENTS,
  type AgentTool,
  type AgentToolContext,
  type AgentToolOutcome,
} from './registry';
import { isExplicitMenuRequest } from '@/lib/agent/business/menu-request';
import type { DispatchMenuResult, MenuSendReason } from '@/lib/menu/dispatch';
import { classifyMenuCtaContext, type MenuCtaContext } from '@/lib/menu/cta-context';

/**
 * Las dos primeras herramientas de negocio — módulo PURO (Fase 6D.2F.5B).
 *
 * Ninguna recibe argumentos. No es una simplificación temporal: es la forma de
 * que el modelo no pueda pedir lo que no le corresponde. Sin parámetros no hay
 * `force`, no hay `reason`, no hay filtros inventados y no hay nada
 * que validar más allá de "vino vacío".
 */

// ── get_menu_items ──────────────────────────────────────────────────────────

/**
 * Lo que el modelo llega a ver de un producto.
 *
 * Deliberadamente MÁS POBRE que la fila de `menu_items`: sin `id`, sin `code`,
 * sin `is_active` (si llega aquí, está activo), sin `sort_order`, sin
 * timestamps. Nada de eso ayuda a contestarle a un cliente, y todo lo que se
 * entrega es superficie que el modelo puede repetir por WhatsApp.
 */
export interface MenuItemForModel {
  name: string;
  price: number;
  category: string;
  /** Copy de vitrina, la MISMA que el cliente ve en /menu. Puede faltar. */
  description?: string;
}

export interface MenuCatalogPort {
  /** Productos ACTIVOS, en el orden en que se muestran. */
  listForModel(): Promise<MenuItemForModel[]>;
}

export const GET_MENU_ITEMS = 'get_menu_items';

/**
 * `currency` viaja explícito para que el modelo no tenga que deducirlo del
 * contexto ni inventarse un símbolo.
 *
 * El campo `note` es la parte importante: `menu_items` NO tiene ingredientes ni
 * atributos dietéticos, así que sin decirlo el modelo intentaría deducirlos del
 * nombre —"Veggie" ⇒ sin carne— que es justo lo que el prompt prohíbe. Que la
 * ausencia de dato sea EXPLÍCITA es más seguro que dejarla implícita.
 */
export function createGetMenuItemsTool(catalog: MenuCatalogPort): AgentTool {
  return {
    definition: {
      name: GET_MENU_ITEMS,
      description:
        'Consulta el menú real de Don Zarco: nombre, precio y categoría de cada ' +
        'producto disponible. Úsala SOLO para una pregunta PUNTUAL sobre uno o ' +
        'dos productos concretos QUE EL CLIENTE HAYA NOMBRADO: cuánto cuesta ' +
        'algo, si existe tal producto. Los productos los acota el cliente, no ' +
        'tú: no conviertas una pregunta amplia en puntual eligiendo un par por ' +
        'tu cuenta. ' +
        'NO la uses para responder qué hay, qué opciones existen ni qué ' +
        'contiene una categoría entera (hamburguesas, bebidas, extras): eso se ' +
        'responde con send_menu. Nunca respondas de memoria.',
      parameters: NO_ARGUMENTS,
    },
    async execute() {
      const items = await catalog.listForModel();
      // Sin `userVisibleEffectConfirmed`: leer una tabla no le enseña nada al
      // cliente. Si el modelo consulta el menú y luego se queda callado, el
      // cliente se queda sin respuesta — y eso sigue siendo un fallo.
      return {
        result: {
          currency: 'Bs',
          items,
          note:
            'No hay datos de ingredientes, alérgenos ni atributos dietéticos. ' +
            'No deduzcas de qué está hecho un producto por su nombre ni por su ' +
            'descripción. La descripción es copy de vitrina, el mismo texto que ' +
            'el cliente ya ve en la web: puedes repetirlo tal cual, pero de él ' +
            'no se concluye que algo sea vegetariano, vegano, sin carne, sin ' +
            'gluten, libre de alérgenos ni seguro para una alergia.',
        },
      };
    },
  };
}

// ── send_menu ───────────────────────────────────────────────────────────────

export const SEND_MENU = 'send_menu';

export interface MenuDispatchPort {
  dispatch(input: {
    customerPhone: string;
    sourceMessageId: string;
    phoneNumberId: string | null;
    reason: MenuSendReason;
    /** De qué venía hablando el cliente; solo elige el copy del botón. */
    ctaContext?: MenuCtaContext | null;
  }): Promise<DispatchMenuResult>;
}

/** Lo que el modelo recibe tras pedir el envío. Sin URL, sin token, sin WAMID. */
export interface SendMenuToolResult {
  sent: boolean;
  status: DispatchMenuResult['result'];
}

/**
 * Envía el menú delegando en el Shared Menu Dispatch de 5A.
 *
 * No duplica NADA: ni sesión, ni token, ni CTA, ni idempotencia, ni ledger,
 * ni memoria del automatismo. Esta función solo traduce una intención del
 * modelo a una llamada del backend.
 *
 * ── Quién decide el motivo ──────────────────────────────────────────────────
 *
 * El modelo NO. La tool no tiene argumentos, así que no hay `force`, ni
 * `reason`: aunque los mandara, la llamada se rechaza antes de ejecutarse. Lo
 * único que el modelo hace es pedir el envío.
 *
 * El motivo lo pone aquí el backend leyendo el entrante REAL del turno:
 *
 *   el cliente nombró el menú  →  `explicit_request`
 *   no lo nombró               →  `agent_suggestion`
 *
 * Desde que se quitó el cooldown, esa etiqueta ya no abre ni cierra ninguna
 * puerta: es OBSERVABILIDAD y los dos envían igual. Y significa solo lo que
 * dice — `agent_suggestion` es "el entrante no nombró el menú", no "al agente
 * se le ocurrió a él": "¿qué hamburguesas tienen?" cae ahí y es una petición
 * de ver productos como una casa.
 *
 * La única protección contra duplicados es la idempotencia técnica: el mismo
 * WAMID nunca produce dos CTAs. La garantiza el UNIQUE de 0015, no esta
 * función.
 */
export function createSendMenuTool(dispatcher: MenuDispatchPort): AgentTool {
  return {
    definition: {
      name: SEND_MENU,
      description:
        'Envía al cliente el menú interactivo de Don Zarco por WhatsApp. Úsala ' +
        'SIEMPRE que la respuesta tendría que enumerar VARIOS productos, una ' +
        'CATEGORÍA entera o lo que hay disponible: "qué tienen?", "qué ' +
        'hamburguesas hay?", "qué bebidas tienen?", "qué extras hay?", "qué ' +
        'opciones hay?". También cuando el cliente quiera elegir para pedir. ' +
        'Mandar el menú es mejor que reescribir el catálogo en el chat.',
      parameters: NO_ARGUMENTS,
    },
    // Manda un mensaje al WhatsApp del cliente: el core tiene que comprobar la
    // pausa ANTES de ejecutarla. Es lo único que separa "el agente sugiere el
    // menú" de "el agente interrumpe a la persona que está atendiendo".
    producesUserVisibleEffect: true,
    // El CTA que sale ya lleva imagen, copy y botón "Ver menú": es la respuesta
    // entera. Pedirle además una frase al modelo es lo que produjo el fallo del
    // 16-08-2026 — una frase que anunciaba un menú que nunca se mandó. Si el
    // envío se confirma, el turno cierra aquí y no hay frase que pueda mentir;
    // si no se confirma, esto no se activa y el modelo redacta con el fallo
    // delante, que es justo cuando SÍ hace falta que hable.
    effectCompletesTurn: true,
    async execute(context: AgentToolContext): Promise<AgentToolOutcome> {
      const reason: MenuSendReason = isExplicitMenuRequest(context.inboundText)
        ? 'explicit_request'
        : 'agent_suggestion';

      const result = await dispatcher.dispatch({
        customerPhone: context.customerPhone,
        sourceMessageId: context.sourceMessageId,
        phoneNumberId: context.phoneNumberId,
        reason,
        // El botón es el ÚNICO mensaje que sale cuando el menú se manda —el
        // turno cierra en silencio—, así que su texto es la única oportunidad
        // de contestar lo que el cliente acababa de preguntar.
        ctaContext: classifyMenuCtaContext(context.inboundText),
      });

      // `duplicate` significa que ESTE mismo mensaje del cliente ya provocó un
      // envío: para el cliente el menú está, así que cuenta como enviado.
      //
      // `failed` y `send_unknown` NO cuentan. El segundo es el que más importa:
      // ahí el proveedor no nos dio certeza, y cerrar el turno como éxito
      // silencioso dejaría al cliente sin nada y sin rastro de que faltó algo.
      // La incertidumbre la sigue custodiando el ledger del menú.
      const sent = result.result === 'sent' || result.result === 'duplicate';

      const toolResult: SendMenuToolResult = { sent, status: result.result };

      // La MISMA verdad para el modelo y para el core, calculada una sola vez a
      // partir del resultado real del despacho. Nada de esto pasa por OpenAI.
      return { result: toolResult, userVisibleEffectConfirmed: sent };
    },
  };
}
