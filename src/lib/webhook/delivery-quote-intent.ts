import { normalizeIntentText } from './menu-intent';

/**
 * "¿Cuánto me sale el envío?" — detección determinística, módulo PURO.
 *
 * ── Por qué esto NO se le pregunta al modelo ────────────────────────────────
 *
 * Se intentó. Dos veces, y las dos se midió con el eval contra el modelo real:
 *
 *   · Ronda 1 — se abrió `answer_directly` al costo del envío y se le prohibió
 *     a `request_human` derivar por ello. Resultado: "hola como esta zarco
 *     cuanto me saldria delivery aqui" siguió derivando 3 de 3 veces.
 *   · Ronda 2 — se quitó del prompt la salida "eso tendría que confirmártelo
 *     una persona del equipo" y se reescribió el bloque de delivery como una
 *     capacidad y no como una carencia. Resultado: PEOR, 0 de 3 en los cuatro
 *     casos de envío.
 *
 * El patrón es claro y no es de redacción: el modelo tiene delante una pregunta
 * por un precio que él no puede dar, y con `toolChoice: 'required'` tiene que
 * elegir algo. Todas las palabras del mundo no cambian que "no tengo este dato"
 * se parece más a "esto lo ve una persona" que a "contesto yo".
 *
 * Pero es que además no hace falta preguntárselo. La respuesta a esta pregunta
 * es SIEMPRE la misma, palabra por palabra: pedirle la ubicación. Una respuesta
 * fija no necesita un modelo que la elija — necesita reconocer la pregunta, que
 * es justo lo que hace `isMenuIntent` desde 6D.2E y con el mismo rigor.
 *
 * ── Cómo reconoce, y por qué así ────────────────────────────────────────────
 *
 * Exige DOS cosas juntas: una palabra de COSTE y una de ENVÍO. Ninguna de las
 * dos basta sola, y esa es toda la defensa contra los falsos positivos:
 *
 *   · "cuánto cuesta el trancapecho"  → coste sí, envío no  → NO
 *   · "hacen delivery?"                → envío sí, coste no  → NO
 *   · "cuánto sale el envío"           → las dos             → SÍ
 *
 * No va anclado al comienzo, a diferencia de `isMenuIntent`, y no puede estarlo:
 * esta pregunta llega casi siempre en mitad de la frase —"hola como esta zarco
 * cuanto me saldria delivery aqui"—. Lo que sustituye al ancla es la exigencia
 * de las dos familias de palabras a la vez.
 *
 * ── Qué pasa si se equivoca ─────────────────────────────────────────────────
 *
 * Un falso positivo le pide la ubicación a alguien que preguntaba otra cosa: se
 * arregla con el mensaje siguiente. Un falso negativo lo devuelve al camino de
 * hoy, que es el modelo. Ninguno de los dos se acerca al daño que hace el fallo
 * que esto viene a cerrar — dos horas de silencio por preguntar cuánto cuesta
 * que te lo lleven.
 */

/**
 * Preguntar por un precio. `cuanto` cubre "cuánto sale", "cuánto cuesta",
 * "cuánto cobran", "cuánto me saldría" y "en cuánto me sale" sin enumerarlas.
 */
const COSTE = /\b(cuanto|cuantos|precio|costo|coste|tarifa|vale)\b/;

/**
 * Hablar del envío.
 *
 * Los sustantivos (`delivery`, `envio`, `domicilio`) son inequívocos. Los verbos
 * de traslado entran porque medio Santa Cruz pregunta "¿cuánto sale que me lo
 * traigan?" sin nombrar el envío ni una vez, y sin ellos ese cliente —que es
 * exactamente el que esto atiende— seguiría cayendo en el modelo.
 *
 * `moto` queda FUERA a propósito: "¿tienen moto?" o "¿vienen en moto?" son
 * preguntas sobre el servicio, no sobre su precio, y con `cuanto` cerca se
 * colarían sin querer.
 *
 * Los verbos llevan cosidos los PRONOMBRES ENCLÍTICOS, que en español van
 * pegados a la palabra y rompen cualquier lista de formas: "cuánto cobran por
 * llevarlo" no coincide con `llevar`, ni "cuánto sale traérmelo" con `traer`.
 * Se modelan como sufijos opcionales en vez de enumerar las combinaciones, que
 * son decenas.
 *
 * Y la terminación va ACOTADA, no abierta: con `mand\w*`, "cuánto cuesta el
 * jugo de mandarina" acabaría pidiéndole la ubicación a alguien que preguntaba
 * por una fruta.
 */
const ENVIO =
  /\b(?:delivery|envio|envios|domicilio|reparto|(?:mand(?:ar|a|an|en|e)|tra(?:er|e|en|iga|igan)|llev(?:ar|a|an|e|en))(?:me|te|se|nos)?(?:lo|la|los|las)?)\b/;

/**
 * `true` solo si el texto pregunta por el COSTE del ENVÍO.
 *
 * Se normaliza con el mismo `normalizeIntentText` del detector de menú —sin
 * tildes, sin signos, minúsculas—: si los dos no normalizaran igual, "¿cuánto
 * sale el envío?" se reconocería en un sitio y en el otro no, y nadie
 * entendería por qué.
 */
export function isDeliveryQuoteIntent(text: string | null | undefined): boolean {
  if (typeof text !== 'string') return false;

  const norm = normalizeIntentText(text);
  if (norm === '') return false;

  return COSTE.test(norm) && ENVIO.test(norm);
}
