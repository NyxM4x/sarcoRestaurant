import { normalizeIntentText } from './menu-intent';

/**
 * "PASO YO A RECOGERLO" — el pedido ya armado que cambia a recojo (04-09-2026).
 *
 * ── Por qué este detector es el MÁS estricto del webhook ────────────────────
 *
 * Los dos errores no se parecen en nada:
 *
 *   no reconocerlo   →  el cliente sigue como hoy: alguien entra al chat y lo
 *                       arregla a mano. Molesto, y es lo que ya pasa.
 *   reconocerlo mal  →  el pedido deja de ser delivery. El repartidor NO sale,
 *                       el envío deja de cobrarse, y un cliente que esperaba en
 *                       su casa se queda esperando una moto que nadie mandó.
 *
 * Eso invierte la asimetría de `order-change-intent.ts`. Allí, en la duda se
 * manda el botón porque el peor desenlace es un mensaje que no encaja; aquí, en
 * la duda NO se toca el pedido. Hacen falta DOS señales a la vez —el verbo de
 * recoger Y que quien recoge sea el cliente— y basta una sombra de negación,
 * de dinero o de repartidor para descartarlo todo.
 *
 * ── Por qué el sujeto importa tanto como el verbo ───────────────────────────
 *
 * "¿Quién lo va a recoger?" y "¿pueden recoger el pago?" llevan el verbo y no
 * piden nada: en el primero pregunta por el repartidor y en el segundo habla de
 * dinero. Lo que convierte la frase en una decisión es que el cliente se ponga a
 * sí mismo a hacerlo — "yo", "paso", "voy", "puedo".
 *
 * ── "Para llevar" entra, y con qué contrapeso ───────────────────────────────
 *
 * Es como lo dice mucha gente, así que entra por decisión del negocio
 * (04-09-2026). Tiene un problema que las demás frases no tienen: se basta
 * sola, sin sujeto, y por WhatsApp la escribe igual quien pide el ENVASE para
 * llevarse la comida a otro sitio —"mándalo para llevar"—.
 *
 * El contrapeso es que cualquier verbo de MANDAR la descarta. Quien escribe
 * "mándamelo para llevar" está pidiendo delivery con envase, y lo dice él mismo
 * en la primera palabra.
 */

/** Un anuncio de recojo es corto. Lo que pasa de aquí es una conversación. */
export const PICKUP_SWITCH_MAX_LENGTH = 90;

/**
 * El verbo. Incluye el sustantivo ("quiero recojo") y las faltas con las que se
 * escribe de verdad ("recojer"), que en WhatsApp son la norma y no la excepción.
 */
const VERBO_DE_RECOJO =
  /(^|\s)(recoger|recogerlo|recogerla|recogerlos|recogerlas|recojerlo|recojer|recoge|recojo|recojemos|recogemos|retirar|retirarlo|retiro|buscarlo|buscarla|buscarlos)(\s|$)/;

/**
 * Quien recoge tiene que ser el cliente.
 *
 * `mi` y `mis` entran porque "lo recoge mi hermano" es exactamente la misma
 * decisión: el pedido no sale a reparto.
 */
const LO_HACE_EL_CLIENTE =
  /(^|\s)(yo|mi|mis|paso|pasare|pasaria|pasamos|voy|vamos|ire|iria|puedo|podria|podemos|prefiero|preferimos|quiero|queremos|quisiera|mejor|nosotros|me)(\s|$)/;

/**
 * Una negación lo descarta entero, esté donde esté.
 *
 * "No puedo pasar a recogerlo" es lo contrario de lo que este detector busca, y
 * distinguir a qué parte de la frase alcanza el "no" es justo el tipo de
 * finura que aquí no se puede fallar. Cae al lado barato: no se convierte.
 */
const NEGACION = /(^|\s)(no|nunca|tampoco|ya no|imposible)(\s|$)/;

/**
 * Palabras que delatan que la frase habla de OTRA cosa.
 *
 * El dinero y el repartidor son los dos contextos en los que "recoger" aparece
 * sin querer decir "voy yo": "¿pueden recoger el pago?", "¿cuándo lo recoge el
 * motorizado?". Ninguna de las dos toca el tipo de entrega.
 */
const FUERA_DEL_RECOJO =
  /(^|\s)(pago|pagos|pagar|pague|comprobante|qr|transferencia|deposito|efectivo|vuelto|cambio|delivery|repartidor|motorizado|moto|envio|domicilio)(\s|$)/;

/**
 * Verbos de MANDAR: quien los usa está pidiendo que se lo lleven.
 *
 * Son el contrapeso de "para llevar" —la única frase que se basta sin sujeto—,
 * y descartan la conversión entera: "mándamelo para llevar" es un delivery con
 * envase, no un recojo.
 */
const PIDE_QUE_SE_LO_MANDEN =
  /(^|\s)(mand[ae][a-z]*|envi[ae][a-z]*|tra[ei][a-z]*|lleve[a-z]*)(\s|$)/;

/**
 * Frases que YA son la decisión completa, sin sujeto que las acompañe.
 *
 * "Para llevar" no nombra a nadie y aun así lo dice todo: nadie escribe eso
 * esperando una moto. Van aparte porque la regla de las dos señales las dejaría
 * fuera por no tener sujeto, que es justo lo que no necesitan.
 */
const SE_LO_LLEVA_EL_MISMO =
  /(^|\s)(para llevar|pa llevar|es para llevar|sera para llevar|me lo llevo|melo llevo|me la llevo|nos lo llevamos|lo llevo yo|lo llevo|paso por el local|voy al local|paso al local)(\s|$)/;

/**
 * ¿Pide llevarse el pedido él mismo, en vez de que se lo manden?
 *
 * Solo tiene sentido preguntárselo por un pedido que HOY es delivery y todavía
 * no salió. Esa guarda la pone quien llama, que es quien conoce el pedido.
 */
export function isPickupSwitchRequest(text: string | null | undefined): boolean {
  if (typeof text !== 'string') return false;

  const norm = normalizeIntentText(text);
  if (norm === '' || norm.length > PICKUP_SWITCH_MAX_LENGTH) return false;

  if (NEGACION.test(norm)) return false;
  if (FUERA_DEL_RECOJO.test(norm)) return false;
  // Pide que se lo manden: eso no es recojo, lo diga con las palabras que lo diga.
  if (PIDE_QUE_SE_LO_MANDEN.test(norm)) return false;

  // "Para llevar" se basta sola; todo lo demás necesita las dos señales.
  if (SE_LO_LLEVA_EL_MISMO.test(norm)) return true;

  return VERBO_DE_RECOJO.test(norm) && LO_HACE_EL_CLIENTE.test(norm);
}
