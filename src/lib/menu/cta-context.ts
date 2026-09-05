import {
  isDictatedOrder,
  isGreetingOnly,
  normalizeIntentText,
} from '@/lib/webhook/menu-intent';

/**
 * Qué acababa de preguntar el cliente cuando le mandamos el botón — PURO.
 *
 * ── Por qué existe, separado del `reason` ───────────────────────────────────
 *
 * `MenuSendReason` responde "¿con qué autoridad se manda este menú?" —petición
 * explícita, reenvío, sugerencia del agente, prueba interna— y se PERSISTE en
 * `menu_send_deliveries`. Esto responde otra pregunta: "¿de qué venía
 * hablando?", y no se guarda en ningún sitio: solo elige el copy.
 *
 * Mantenerlos separados evita ampliar el dominio de una columna cada vez que se
 * quiere afinar una frase, y sobre todo evita que dos conceptos distintos
 * acaben viajando en la misma palabra.
 *
 * ── Qué problema resuelve ───────────────────────────────────────────────────
 *
 * El cuerpo del CTA es lo ÚNICO que sale cuando se manda el menú: un
 * `send_menu` confirmado cierra el turno en silencio. Así que ese mensaje es la
 * única oportunidad de contestar lo que el cliente acababa de preguntar — y
 * hasta ahora decía siempre lo mismo, así que a quien preguntaba un precio le
 * llegaba un botón que no mencionaba los precios.
 *
 * Aprovecharlo hace dos cosas a la vez: contesta, y enseña que eso se hace en
 * el botón. Dos mensajes en uno.
 *
 * ── Por qué el texto sigue siendo FIJO ──────────────────────────────────────
 *
 * Podría escribirlo el modelo y sonaría mejor. Pero este mensaje es el que en
 * agosto llegó a afirmar envíos que no ocurrieron, y hoy es el único que sale
 * siempre bien redactado, cuesta cero tokens y llega igual por el camino
 * determinista —que ni pasa por el agente—. Lo que se afina es CUÁL de las
 * frases fijas sale, no quién la escribe.
 */

/**
 * De qué venía la conversación. `null` = nada reconocible, y entonces manda el
 * texto del `reason`, que es el comportamiento de siempre.
 */
export type MenuCtaContext = 'cash' | 'price' | 'delivery' | 'dictated' | 'greeting';

/**
 * "¿Puedo pagar en efectivo?" — la pregunta que se hace ANTES de entrar
 * (05-09-2026).
 *
 * Hay gente que no toca el botón hasta saber si va a poder pagar como quiere, y
 * la respuesta es que sí: el método de pago se elige dentro, al confirmar. Sin
 * este contexto recibía el copy genérico —"todo lo que tenemos está acá"— que no
 * contesta lo que preguntó, y se quedaba esperando una respuesta que ya tenía
 * delante.
 *
 * `efectivo` a secas basta: nadie escribe esa palabra en un chat de comida salvo
 * para preguntar por el método. Las otras formas son las de quien lo dice sin
 * nombrarlo —"contra entrega", "pago al recibir"— y la contraria, la de quien
 * cree que solo hay QR.
 */
const EFECTIVO =
  /(^|\s)(efectivo|contra entrega|contraentrega|solo qr|solamente qr|unicamente qr|puro qr)(\s|$)|(pagar|pago|pagarle|cancelar|cancelo|abonar)\s+(al recibir|cuando llegue|cuando me llegue|en la puerta|al final|despues)/;

/** Preguntar por un importe. Mismo vocabulario que el detector de cotización. */
const COSTE = /\b(cuanto|cuantos|precio|precios|costo|coste|vale|valen|sale|salen|cuesta|cuestan)\b/;

/** Hablar del envío. */
const ENVIO = /\b(delivery|envio|envios|domicilio|reparto|aqui|aca|a mi casa)\b/;

/**
 * Dictar el pedido: una cantidad seguida de algo.
 *
 * "2 lomitos", "quiero 3 trancapechos", "mandame 2 hamburguesas". Es el cliente
 * que todavía pide como se pedía antes, y el que más necesita que el botón le
 * explique por qué ahora conviene armarlo él.
 *
 * Se exige el DÍGITO junto a una palabra: sin él, "quiero lomito" es una
 * intención de pedir cualquiera y ya la cubre el texto normal. Con él, la
 * intención es inequívoca — nadie escribe "2 lomitos" para preguntar algo.
 */
const DICTADO = /\b\d{1,2}\s+[a-z]{3,}/;

/**
 * Clasifica el mensaje del cliente. `null` si no encaja en nada.
 *
 * El orden importa: "cuánto sale el envío" es COSTE y ENVÍO a la vez, y lo que
 * de verdad pregunta es el envío. Contestarle con "los precios están dentro"
 * sería contestar a otra pregunta.
 *
 * El saludo va el ÚLTIMO de todos, y por construcción no se lo quita a nadie:
 * un mensaje que es SOLO saludo no tiene palabra de coste, ni de envío, ni
 * cantidad, así que ninguna de las ramas anteriores podía haberlo tomado.
 */
export function classifyMenuCtaContext(
  text: string | null | undefined,
): MenuCtaContext | null {
  if (typeof text !== 'string') return null;

  const norm = normalizeIntentText(text);
  if (norm === '') return null;

  // El efectivo va PRIMERO, por delante incluso del envío: "se puede pagar el
  // delivery en efectivo" habla de las dos cosas, y lo que de verdad pregunta
  // —lo que le impide tocar el botón— es cómo va a pagar.
  if (EFECTIVO.test(norm)) return 'cash';

  if (COSTE.test(norm) && ENVIO.test(norm)) return 'delivery';
  // Las dos formas de dictar: con dígito ("2 lomitos") y con la cantidad en
  // letra tras un verbo de pedir ("quisiera un trancapecho"). La segunda la
  // decide el MISMO criterio que abre el menú, importado y no recopiado.
  if (DICTADO.test(norm) || isDictatedOrder(text)) return 'dictated';
  if (COSTE.test(norm)) return 'price';
  if (isGreetingOnly(text)) return 'greeting';
  return null;
}
