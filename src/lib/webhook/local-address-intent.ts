import { normalizeIntentText } from './menu-intent';

/**
 * "¿Dónde están ubicados?" — detección determinística, módulo PURO (09-09-2026).
 *
 * ── Por qué esto NO se le pregunta al modelo ────────────────────────────────
 *
 * Por lo mismo que la pregunta del envío (`delivery-quote-intent.ts`): la
 * respuesta es SIEMPRE la misma, palabra por palabra —la dirección escrita y el
 * enlace de Maps, juntos— y una respuesta fija no necesita un modelo que la
 * elija. Necesita reconocer la pregunta.
 *
 * Y además hoy el modelo ni siquiera llega a verla. Desde que el botón del menú
 * es la respuesta por defecto (03-09-2026), todo texto que ninguna puerta
 * atiende cae en el `return { action: 'menu' }` final y el turno se cierra ahí.
 * Dos conversaciones del 09-09-2026:
 *
 *   "Me pasa la ubicación" · "Por favor"   →  saludo + botón del menú
 *   "Dónde están ubicados?"                →  botón del menú, dos veces
 *
 * El agente tiene la dirección escrita en `business/facts.ts` y la orden
 * explícita de darla con el enlace. Nunca se le preguntó.
 *
 * ── LA trampa: "ubicación" viaja en las dos direcciones ─────────────────────
 *
 * En este sistema la palabra significa dos cosas opuestas según quién la diga:
 *
 *   NOSOTROS → "envíame tu ubicación GPS para calcular el costo del envío"
 *   EL CLIENTE → "¿dónde queda el local?"
 *
 * Alrededor de lo primero la gente escribe "ya te paso mi ubicacion", "no me
 * sale la ubicacion", "como mando la ubicacion". Todas llevan la palabra y
 * ninguna pregunta por el local. Si el detector se las come, le contestamos la
 * dirección a alguien que está peleando con el clip de WhatsApp — y ese pedido
 * se atasca.
 *
 * ── Los dos errores NO cuestan lo mismo ─────────────────────────────────────
 *
 *   falso negativo → recibe un menú de más. Molesto, y el mensaje siguiente lo
 *                    arregla.
 *   falso positivo → rompe un pedido en curso.
 *
 * Ante la duda, no se dispara.
 *
 * ── Lo que este módulo NO tiene que mirar ───────────────────────────────────
 *
 * El estado del pedido. Vive al final de la cascada de `decideDefaultReply`,
 * después de todas las guardas de pedido abierto, así que cuando un texto llega
 * hasta aquí ya se sabe que ese cliente no tiene nada en curso: ni esperando
 * GPS, ni en la plancha, ni en camino. El cliente que pregunta "por donde
 * estan" mientras espera su moto —que quiere saber por dónde viene su comida, no
 * dónde queda el local— lo intercepta `wait_notice` mucho antes.
 *
 * Pasarle una bandera de estado sería duplicar aquí lo que la cascada ya sabe, y
 * dos sitios que definen lo mismo acaban discrepando.
 */

/**
 * Preguntar DÓNDE. Es la familia interrogativa.
 *
 * `donde` cubre "donde estan", "donde queda", "donde es", "por donde estan" y
 * "de donde salen" sin enumerarlas. `dnd` es la abreviatura que se teclea con
 * una mano a las dos de la mañana.
 */
const DONDE = /\b(donde|dnd|dond)\b/;

/**
 * Nombrar el LUGAR con un sustantivo.
 *
 * `ubi` entra porque es como se dice en Santa Cruz y llega sola, sin verbo:
 * un mensaje que es literalmente "ubi" es una petición completa.
 *
 * `boliche` es el local de comida en cruceño. `anillo` y `zona` son la forma
 * local de preguntar por una parte de la ciudad —"en q anillo estan"— y no
 * significan otra cosa en un chat de restaurante.
 */
const LUGAR =
  /\b(ubi|ubicacion|ubicacions|direccion|direcciones|local|locales|sucursal|sucursales|boliche|anillo|anillos|zona|zonas|parte|altura|avenida|calle|barrio|centro|norte|sur|via)\b/;

/**
 * Pedir que te pasen algo.
 *
 * Los pronombres enclíticos van cosidos por lo mismo que en el detector del
 * envío: en español se pegan al verbo —"pasame", "mandame"— y una lista de
 * `pasar` no los agarra.
 *
 * `mande` está incluido a sabiendas de que es ambiguo: es el imperativo de
 * usted ("mande la ubicacion") y también el pasado sin tilde ("le mande mi
 * ubicacion"). Lo desambigua `PROPIA`, no este patrón.
 */
const PEDIR =
  /\b(?:pas(?:ar|a|as|e|en|eme)|mand(?:ar|a|as|e|en|eme)|envi(?:ar|a|as|e|en)|comparti(?:r|s)?|dig(?:a|an|ame))(?:me|nos|le)?(?:la|lo|las|los)?\b/;

/**
 * Ir HASTA el local: recoger, pasar, comer ahí.
 *
 * Quien pregunta esto quiere la dirección aunque no la nombre: "se puede pasar
 * a recoger" no lleva ni `donde` ni `direccion`, y es exactamente alguien que
 * necesita saber adónde ir.
 */
const IR_AL_LOCAL =
  /\b(recoger|recojo|recojer|buscarlo|recogerlo|presencial|para llevar)\b|\b(?:pasar|ir|venir|llegar|comer)\b[^.]{0,25}\b(?:local|ahi|alla|recoger|buscar)\b/;

/**
 * Preguntar CUÁL o QUÉ. La otra forma interrogativa.
 *
 * En Santa Cruz una dirección se pregunta tanto con `donde` como señalando la
 * referencia: "en q anillo estan", "q zona es", "a q altura de la guardia".
 * La `q` suelta es como se teclea `que` con una mano.
 *
 * No basta sola —"q tienen" pregunta por la carta— y por eso siempre va
 * acompañada de `LUGAR`.
 */
const INTERROGA = /\b(q|que|cual|cuales|k)\b/;

/**
 * ESTAR en un sitio, o HABER uno.
 *
 * La tercera forma de preguntarlo, y la más cruceña: no interroga ni pide, solo
 * nombra la referencia y el verbo. "estan en el centro", "por la doble via
 * estan", "hay uno por el norte".
 *
 * Como `INTERROGA`, nunca dispara sola: "estan abiertos?" lleva el verbo y no
 * pregunta por ningún sitio.
 */
const ESTAR = /\b(estan|estas|esta|queda|quedan|encuentran|atienden|salen|hay|tienen)\b/;

/**
 * "Ya te la mandé" — el cliente diciendo que él ya cumplió.
 *
 * `le pase la ubi` lleva verbo de pasar y sustantivo de lugar, así que cumple
 * la regla de la petición y significa lo contrario. Lo distingue el pronombre
 * de OBJETO delante: `te`/`le` marcan que el que mandó fue él.
 *
 * No lo cubre `PROPIA` porque aquí no hay posesivo: dice "la ubi", no "mi ubi".
 */
const YA_LA_MANDE = /\b(te|le|ya)\s+(la\s+|lo\s+)?(pase|mande|envie|compartí|comparti)\b/;

/**
 * LO SUYO, no lo nuestro. Es la guarda que apaga todo lo demás.
 *
 * ── Por qué el posesivo y no el verbo ───────────────────────────────────────
 *
 * "hola ayer le mande mi direccion y nada" es la frase que se dio por
 * irresoluble: `mande` es a la vez imperativo ("mande la direccion") y pasado
 * sin tilde ("le mandé"), y sin tildes no hay forma de separarlos.
 *
 * Pero la ambigüedad no está en el verbo: está en de quién es la dirección. Y
 * eso sí lo dice el texto, con el posesivo. `mi direccion` es la del cliente
 * SIEMPRE, diga lo que diga el verbo que la acompaña.
 *
 * `su` NO entra, y es deliberado: en Bolivia es el posesivo de usted, así que
 * "cual es su direccion" pregunta por la NUESTRA. Meterlo aquí apagaría media
 * familia A.
 */
const PROPIA = /\b(mi|mis)\s+(ubi|ubicacion|direccion|gps|casa|domicilio|zona)\b|\bmi gps\b/;

/**
 * Mandar algo A un sitio: el cliente diciendo dónde quiere su comida.
 *
 * "a esta direccion me lo mandas", "mandamelo a esta ubicacion". Lleva `LUGAR`
 * y `PEDIR`, así que sin esta guarda dispararía — y es justo lo contrario de
 * preguntar dónde estamos.
 */
const HACIA_EL_CLIENTE = /\b(a|hasta)\s+(esta|esa|mi)\s+(direccion|ubicacion|zona|casa)\b/;

/**
 * Datos de PAGO, no de sitio.
 *
 * "pasame el qr que mi hermano pasa a recoger" cumple `PEDIR` + `IR_AL_LOCAL` y
 * pide otra cosa completamente. Es el falso positivo que quedó sin resolver al
 * diseñar las familias, y se cierra con una lista corta: lo que se pide aquí no
 * es un lugar.
 */
const ES_UN_PAGO = /\b(qr|cuenta|banco|codigo|transferencia|nro de cuenta|numero de cuenta)\b/;

/**
 * `true` solo si el cliente pregunta por la dirección DEL LOCAL.
 *
 * Se normaliza con el mismo `normalizeIntentText` del detector de menú —sin
 * tildes, sin signos, minúsculas—: si los dos no normalizaran igual, la misma
 * frase se reconocería en un sitio y en el otro no, y nadie entendería por qué.
 */
export function isLocalAddressRequest(text: string | null | undefined): boolean {
  if (typeof text !== 'string') return false;

  const norm = normalizeIntentText(text);
  if (norm === '') return false;

  // ── Las guardas van PRIMERO y no se negocian ──────────────────────────────
  //
  // Cualquiera de las tres significa que esto no es una pregunta por el local,
  // por muchas palabras de lugar que lleve alrededor.
  if (PROPIA.test(norm)) return false;
  if (YA_LA_MANDE.test(norm)) return false;
  if (HACIA_EL_CLIENTE.test(norm)) return false;
  if (ES_UN_PAGO.test(norm)) return false;

  // ── Y ahora, las tres formas de preguntarlo ───────────────────────────────
  //
  // Son tres estructuras gramaticales distintas y ninguna cubre a las otras:
  // preguntar dónde, pedir el dato, o anunciar que vas a ir.

  // 1. INTERROGATIVA — "donde estan", "por donde queda", "dnd es"
  //
  // `donde` solo, sin nombrar el lugar, ya es suficiente aquí: en un chat de
  // restaurante y sin ningún pedido abierto —lo único que llega a este módulo—
  // "¿dónde están?" no puede significar otra cosa.
  if (DONDE.test(norm)) return true;

  // 2. INTERROGATIVA CON REFERENCIA — "en q anillo estan", "cual es su direccion"
  //
  // Las DOS: la partícula interrogativa y el sustantivo de lugar. Sin la
  // segunda, "q tienen" preguntaría por la carta y acabaría mandando una
  // dirección.
  if (INTERROGA.test(norm) && LUGAR.test(norm)) return true;

  // 3. SEÑALANDO LA REFERENCIA — "estan en el centro", "por la doble via estan"
  //
  // La forma más cruceña: ni interroga ni pide, nombra la zona y el verbo. Y
  // también exige las dos, por lo mismo: "estan abiertos?" no pregunta por
  // ningún sitio.
  if (ESTAR.test(norm) && LUGAR.test(norm)) return true;

  // 4. PETICIÓN — "pasame la ubi", "me manda su direccion", "mandame el local"
  //
  // Exige las DOS: el verbo de pedir y el sustantivo de lugar. Ninguna basta
  // sola —"pasame el menu" pide otra cosa, y "ubicacion" suelta ya se atendió
  // arriba— y esa exigencia es toda la defensa contra los falsos positivos.
  if (PEDIR.test(norm) && LUGAR.test(norm)) return true;

  // 5. EL SUSTANTIVO SOLO — "ubi", "la ubi", "direccion porfa"
  //
  // Un mensaje corto que es solo el sustantivo (con cortesía o artículo) es una
  // petición completa: nadie escribe "ubicacion" a secas para otra cosa. El
  // límite de palabras es la defensa: en una frase larga, `LUGAR` suelto puede
  // ser cualquier cosa.
  const palabras = norm.split(' ').length;
  if (palabras <= 3 && LUGAR.test(norm)) return true;

  // 6. VOY PARA ALLÁ — "se puede pasar a recoger", "quiero ir al local"
  //
  // No nombra la dirección ni pregunta dónde, pero necesita saber adónde ir.
  if (IR_AL_LOCAL.test(norm)) return true;

  return false;
}
