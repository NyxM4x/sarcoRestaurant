/**
 * `request_human` — el agente reconoce que aquí ya no ayuda.
 *
 * Un cliente con una queja, con un reclamo, o que lleva tres mensajes sin
 * conseguir pedir, no necesita otra respuesta del bot: necesita a alguien. Esta
 * acción calla al agente y avisa al equipo.
 *
 * ── Por qué cierra el turno, igual que `send_menu` ──────────────────────────
 *
 * La tentación es dejar que el modelo redacte el "te paso con una persona", que
 * sonaría más natural. **No funciona**, y falla de la peor manera: la acción
 * pausa la conversación, y el core vuelve a comprobar la pausa justo antes de
 * enviar (barrera pre-send). La encontraría activa, el turno moriría en
 * `skipped_paused` y el cliente se quedaría sin recibir absolutamente nada —
 * callado por el mismo mecanismo que acaba de pedir ayuda para él.
 *
 * Así que el texto lo pone el backend y el turno cierra aquí. Es la misma forma
 * que `send_menu`, por una razón emparentada: cuando la acción YA es la
 * respuesta, pedirle además una frase al modelo solo abre la puerta a que diga
 * algo que no es verdad.
 *
 * Efecto secundario feliz: el prompt conserva intacta su prohibición de decir
 * "ya avisé a alguien". En este turno el modelo no escribe, así que no puede
 * prometer nada — y el único texto que sale es uno que es cierto pase lo que
 * pase.
 *
 * ── Lo que el modelo NO decide ──────────────────────────────────────────────
 *
 * Sin argumentos, como el resto: no elige el motivo, ni el texto del aviso, ni
 * cuánto dura la pausa, ni a quién se avisa. Lo único que hace es reconocer que
 * esta conversación se le fue de las manos.
 */
import { NO_ARGUMENTS, type AgentTool, type AgentToolContext, type AgentToolOutcome } from './registry';

export const REQUEST_HUMAN = 'request_human';

export interface HandoffPort {
  escalate(input: {
    customerPhone: string;
    sourceMessageId: string;
    phoneNumberId: string | null;
    /** Lo que escribió el cliente; viaja al aviso del equipo, no al modelo. */
    inboundText: string;
  }): Promise<{ handed: boolean }>;
}

/** Lo que el modelo recibe de vuelta. Sin teléfono, sin ids, sin nada más. */
export interface RequestHumanToolResult {
  handed: boolean;
}

export function createRequestHumanAction(port: HandoffPort): AgentTool {
  return {
    definition: {
      name: REQUEST_HUMAN,
      description:
        'Deriva la conversación a una persona del equipo y deja de responder ' +
        'tú. Úsala cuando el cliente trae una queja o un reclamo, cuando algo ' +
        'salió mal con su pedido, cuando pide hablar con una persona, cuando ' +
        'se nota molesto, o cuando lleva varios mensajes trabado sin poder ' +
        'pedir — por ejemplo, insistiendo en dictarte el pedido después de ' +
        'haber recibido el menú. NO la uses para algo que puedes resolver: un ' +
        'precio es get_menu_items, ver qué hay es send_menu, y una duda normal ' +
        'es answer_directly. Tampoco por un "gracias" ni por un mensaje seco ' +
        'que se arregla contestando bien.',
      parameters: NO_ARGUMENTS,
    },
    // Manda un mensaje al cliente y silencia al agente: el core tiene que
    // comprobar la pausa ANTES. Si ya hay una persona atendiendo, esto no debe
    // ejecutarse siquiera.
    producesUserVisibleEffect: true,
    // Ver la cabecera: dejar que el modelo redacte después dejaría al cliente
    // sin nada, porque la pausa que acabamos de poner frenaría ese envío.
    effectCompletesTurn: true,
    async execute(context: AgentToolContext): Promise<AgentToolOutcome> {
      const { handed } = await port.escalate({
        customerPhone: context.customerPhone,
        sourceMessageId: context.sourceMessageId,
        phoneNumberId: context.phoneNumberId,
        inboundText: context.inboundText,
      });

      const toolResult: RequestHumanToolResult = { handed };

      // `handed: false` = no se pudo avisar al cliente. El turno NO cierra, y
      // el modelo redacta con ese dato delante. Puede que la pausa lo frene
      // igual —y entonces el cliente calla, pero el equipo ya fue alertado—,
      // que es preferible a cerrar en falso como si le hubiéramos contestado.
      return { result: toolResult, userVisibleEffectConfirmed: handed };
    },
  };
}
