/**
 * `request_human` — el agente reconoce que aquí ya no ayuda.
 *
 * Un cliente con una queja, con un reclamo o que pide hablar con alguien no
 * necesita otra respuesta del bot: necesita a una persona. Esta acción calla al
 * agente y avisa al equipo. El cliente NO recibe nada — ver `handoff/service.ts`
 * para el porqué.
 *
 * ── Lo que esta acción NO cubre, y quién lo cubre ───────────────────────────
 *
 * El cliente ATASCADO —el que recibe el menú una y otra vez y nunca consigue
 * pedir— no se detecta aquí. Se cuenta, en `handoff/menu-loop.ts`: tres menús
 * enviados en 45 minutos sin ningún pedido creado. Pedirle ese juicio al modelo
 * salió mal en la primera prueba real: con una ventana de decisión que no dice
 * cuánto tiempo pasó entre mensajes, un "hola" nuevo se lee como la
 * continuación de una conversación trabada de hace horas, y la gente escribe
 * "hola" / "zarco" / "quiero ordenar" en mensajes sueltos.
 *
 * El reparto es el que corresponde a cada uno: lo que hay que LEER —enfado,
 * queja, "quiero hablar con alguien"— lo juzga el modelo; lo que se puede
 * CONTAR se cuenta.
 *
 * ── Por qué cierra el turno, igual que `send_menu` ──────────────────────────
 *
 * La acción pausa la conversación. Si el turno siguiera hasta la ronda de
 * redacción, la barrera pre-send encontraría esa pausa activa y el run moriría
 * en `skipped_paused` — habiendo gastado una llamada más al modelo para nada. El
 * silencio es el mismo; lo que cambia es que así no se paga y el run queda
 * registrado como lo que fue: un turno completado que decidió callar.
 *
 * Y hay una razón anterior a la mecánica: dejar redactar al modelo aquí es
 * invitarle a prometer lo que el prompt le prohíbe — "ya avisé a alguien", "te
 * paso con un compañero". En este turno no escribe, así que no puede.
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
    /** Lo que escribió el cliente; viaja al aviso del equipo, no al modelo. */
    inboundText: string;
  }): Promise<{
    /**
     * ¿La conversación quedó derivada — pausada y con el equipo avisado?
     *
     * NO significa "el cliente recibió un acuse": no hay acuse. `false` es el
     * caso raro en que ni siquiera se pudo escribir la pausa.
     */
    handed: boolean;
  }>;
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
        'salió mal con su pedido, cuando pide hablar con una persona, o cuando ' +
        'se nota molesto. NO la uses para algo que puedes resolver: un precio ' +
        'es get_menu_items, ver qué hay es send_menu, y una duda normal es ' +
        'answer_directly. Tampoco por un "gracias" ni por un mensaje seco que ' +
        'se arregla contestando bien. Y NUNCA por escribir seguido: un saludo, ' +
        'varios mensajes cortos uno detrás de otro ("hola", "zarco", "como ' +
        'estas", "quiero ordenar") o un cliente que pide a menudo son una ' +
        'conversación normal empezando, no un problema. Que alguien quiera ' +
        'pedir o te dicte su pedido tampoco se deriva: eso es send_menu, ' +
        'aunque lo repita.',
      parameters: NO_ARGUMENTS,
    },
    // Silencia al agente, y eso es un efecto real aunque no salga ningún
    // mensaje: el core tiene que comprobar la pausa ANTES. Si ya hay una
    // persona atendiendo, esto no debe ejecutarse siquiera.
    producesUserVisibleEffect: true,
    // Ver la cabecera: sin esto el turno seguiría a redactar, la barrera
    // pre-send encontraría la pausa recién puesta y el run moriría en
    // `skipped_paused` habiendo pagado una llamada de más.
    effectCompletesTurn: true,
    async execute(context: AgentToolContext): Promise<AgentToolOutcome> {
      const { handed } = await port.escalate({
        customerPhone: context.customerPhone,
        sourceMessageId: context.sourceMessageId,
        inboundText: context.inboundText,
      });

      const toolResult: RequestHumanToolResult = { handed };

      // `handed: false` = la derivación no llegó a ocurrir (ni pausa). El turno
      // NO cierra, y el modelo redacta con ese dato delante: es el único caso
      // en que el cliente recibe algo, y debe recibirlo — nadie le está
      // atendiendo por otro lado.
      return { result: toolResult, userVisibleEffectConfirmed: handed };
    },
  };
}
