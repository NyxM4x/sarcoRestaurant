import { normalizeIntentText } from '@/lib/webhook/menu-intent';

/**
 * LO QUE DE VERDAD NECESITA UNA PERSONA — módulo PURO (04-09-2026).
 *
 * ── Los datos que obligaron a escribir esto ─────────────────────────────────
 *
 * Estas son las últimas 29 derivaciones reales, con el mensaje que las disparó:
 *
 *   "😓"   "🫠🫠🫠"   "😫"   "?"   "???"   "."   "Okay"   "Si señor"
 *   "Si porfa"   "disculpe"   "Por favor"   "Va disculpar"   "Efectivo"
 *   "Se puede?"   "Cuánto dera"   "Me cotiza Aver"   "30 ? Mioj"
 *   "Estoy viendo su live"   "Adjunto comprobante electrónico"   "Ta en caminon"
 *   "Le pago páseme su qr"   "Me confirmas por favor"   "Puedo aumentar"
 *   "Dn zarco en q tiempo podría pasar mi moto por el pedido"
 *
 * Ni una pide hablar con nadie. Varias son clientes intentando PEDIR o PAGAR.
 * Cada una costó dos horas de bot callado (`HANDOFF_PAUSE_MINUTES`) y una alarma
 * al equipo, y todas pasaron el umbral de conversación: contar mensajes mide
 * cuánto lleva escribiendo el cliente, no si hay un motivo.
 *
 * ── Por qué la puerta se invierte ───────────────────────────────────────────
 *
 * `request_human` es la casilla que el modelo elige cuando no sabe qué
 * contestar, y eso no se arregla pidiéndoselo por prompt —se intentó dos veces y
 * el eval midió que no servía—. Así que la derivación deja de ser algo que el
 * modelo decide y el backend cuenta, y pasa a necesitar EVIDENCIA en el mensaje:
 * o el cliente pide una persona con todas las letras (`explicit-request.ts`), o
 * dice algo que solo una persona puede arreglar. Esto es lo segundo.
 *
 * ── Qué NO entra, y es deliberado ───────────────────────────────────────────
 *
 * "Cuánto tarda", "demora mucho", "en qué tiempo llega": impaciencia, no
 * problema. Eso lo contesta el bot, y meterlo aquí devolvería la mitad de las
 * alarmas falsas por la puerta de atrás.
 *
 * Tampoco entra "me equivoqué": ese cliente quiere rearmar su pedido y ya tiene
 * su propio camino (`order-change-intent.ts`).
 *
 * ── El dinero manda ─────────────────────────────────────────────────────────
 *
 * Lo que el negocio no puede permitirse es perderse un susto monetario, así que
 * el bloque de dinero es el más ancho de los tres: cobros de más, pagos dobles,
 * devoluciones y la palabra estafa en cualquiera de sus formas. Ante un mensaje
 * que hable de plata mal cobrada, se deriva aunque sea el primero que escribe.
 */

/**
 * Dinero mal cobrado, mal pagado o sin devolver.
 *
 * Es el único bloque que se mira con lupa hacia el lado permisivo: una alarma de
 * más por dinero cuesta un minuto de una persona; una de menos, un cliente que
 * pagó dos veces y nadie se enteró.
 */
const PROBLEMA_DE_DINERO =
  /(^|\s)(estafa|estafas|estafado|estafada|estafaron|estafador|estafadores|fraude|robo|robaron|robaste|ladron|ladrones|reembolso|devolucion|devolver|devuelvan|devuelvame|descontaron|cobraron|cobrado|cobraste|sobrecobro)(\s|$)|cobro de mas|cobraron de mas|me cobro de mas|pague de mas|pague dos veces|pague doble|doble cobro|dos veces el pago|mi plata|mi dinero|no me devolvieron/;

/** El pedido llegó mal, o no llegó. */
const PROBLEMA_CON_EL_PEDIDO =
  /(^|\s)(frio|fria|crudo|cruda|podrido|podrida|malogrado|malograda|vencido|vencida)(\s|$)|no me llego|no me llega|no llego mi pedido|no llego nada|no llega nada|no me ha llegado|no ha llegado|nunca llego|no me llegaron|mal estado|esta en mal estado|no es lo que pedi|no era lo que pedi|se equivocaron|pedido equivocado|falta la mitad|vino incompleto|llego incompleto/;

/**
 * Queja formal o enfado dicho con todas las letras.
 *
 * "Nadie me responde" entra aquí y no es un capricho: es el cliente diciendo que
 * el canal automático ya le falló, y contestarle con más automatismo es
 * exactamente lo que no hay que hacer.
 */
const QUEJA_O_ENFADO =
  /(^|\s)(reclamo|reclamar|queja|quejarme|denuncia|denunciar|denuncio|pesimo|pesima|horrible|malisimo|malisima|verguenza|indignante|inaceptable|asco|basura|porqueria)(\s|$)|no sirve|nadie me responde|no me responden|nadie contesta|no me contestan|nadie me atiende|voy a denunciar/;

/**
 * ¿Este mensaje trae algo que solo una persona puede resolver?
 *
 * Se lee el mensaje del cliente tal como llegó. Sin texto no hay evidencia, y
 * sin evidencia no se deriva: un audio o una foto sueltos no abren esta puerta.
 */
export function hasProblemSignal(text: string | null | undefined): boolean {
  if (typeof text !== 'string') return false;

  const norm = normalizeIntentText(text);
  if (norm === '') return false;

  return (
    PROBLEMA_DE_DINERO.test(norm) ||
    PROBLEMA_CON_EL_PEDIDO.test(norm) ||
    QUEJA_O_ENFADO.test(norm)
  );
}
