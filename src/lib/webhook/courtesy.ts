import { normalizeIntentText } from './menu-intent';

/**
 * ¿ESTE MENSAJE PIDE ALGO, O SOLO ACUSA RECIBO? (07-09-2026)
 *
 * La única pregunta que hace falta responder cuando el pedido ya está en cocina
 * y el aviso ya salió al grupo de reparto. A partir de ahí la respuesta es
 * siempre la misma —`deliveryRelayText`: decíselo al repartidor— así que da
 * igual QUÉ pida: solo importa si pide.
 *
 * ── Por qué esto no es otro detector de disparadores ────────────────────────
 *
 * Porque la pregunta es la contraria, y eso cambia de qué lado cae la duda.
 *
 * `order-change-intent` tiene que reconocer una intención concreta entre
 * muchas, y su error caro es tratar un cambio de líneas como una preferencia:
 * cuesta dinero. Por eso allí la duda NO dispara, y por eso necesita saber
 * conjugar "poner" y "mandar" — y por eso la noche del 06-09-2026 tres clientes
 * se quedaron sin respuesta: "no le coloquen locoto al trancapecho" no traía
 * ninguna de las formas que la lista conocía.
 *
 * Aquí no hay nada que anotar, ningún total que recalcular y ningún botón que
 * mandar. El único error posible es el silencio, que es el que estamos
 * arreglando. Así que la duda SÍ contesta: se reconoce lo que no pide nada
 * —"ok", "muchas gracias", un 🙏 suelto— y todo lo demás recibe el relevo.
 *
 * Eso invierte quién carga con el vocabulario. Una palabra de cortesía que
 * falte aquí produce un "decíselo al delivery" a quien solo daba las gracias:
 * molesto y recuperable. Una palabra de cambio que falte en la otra lista
 * produce el silencio de anoche. La lista de las gracias, además, no crece:
 * es la misma desde hace cien años.
 */

/**
 * Palabras con las que se acusa recibo y NADA más.
 *
 * Ninguna nombra comida, cantidad, ni pide una acción sobre el pedido. La
 * comparación es por PALABRA COMPLETA y el mensaje entero tiene que estar hecho
 * solo de estas: basta una palabra de fuera para que el mensaje pida algo. Así,
 * "ok muchas gracias" es un acuse y "gracias, sin locoto" no lo es.
 *
 * Por eso pueden entrar `no`, `si` y `mas` sin peligro: solas o entre cortesías
 * son un acuse ("no hay problema", "ya no gracias"), y en cuanto acompañan a
 * algo real —"mas salsita"— ese algo las delata.
 */
const PALABRAS_DE_ACUSE: ReadonlySet<string> = new Set([
  // El acuse seco.
  'ok', 'oka', 'okas', 'okey', 'okay', 'okis', 'oki', 'k',
  'ya', 'listo', 'lista', 'dale', 'va', 'vale', 'sale', 'hecho',
  // La conformidad.
  'bueno', 'buenisimo', 'perfecto', 'excelente', 'genial', 'barbaro', 'chevere',
  'bien', 'esta', 'asi', 'muy', 'todo', 'de', 'acuerdo', 'entendido', 'entiendo',
  'claro', 'si', 'sip', 'sii', 'no', 'nada', 'hay', 'sin', 'problema', 'problemas',
  // Las gracias.
  'gracias', 'graciass', 'gracia', 'grax', 'gracs', 'mil', 'muchas', 'mucha',
  'muchisimas', 'agradecido', 'agradecida', 'amable', 'bendiciones', 'saludos',
  // La despedida y la espera.
  'chau', 'chao', 'adios', 'bye', 'espero', 'esperare', 'esperando', 'aqui',
  'tranquilo', 'tranqui', 'nomas', 'pues', 'pe', 'y', 'a', 'te', 'lo', 'la',
  'buenas', 'buenos', 'noches', 'noche', 'dias', 'dia', 'tardes', 'tarde',
]);

/**
 * ¿El mensaje entero está hecho solo de acuse?
 *
 * Un mensaje SIN una sola letra ni número —"🙏", "👍👍", "..."— también lo es:
 * son los emojis con los que se cierra una conversación, y no hay lista que
 * mantener para reconocerlos.
 *
 * @param text Mensaje del cliente, tal como llegó.
 */
export function isCourtesyOnly(text: string | null | undefined): boolean {
  if (typeof text !== 'string') return false;

  // `normalizeIntentText` quita tildes y los signos del castellano; lo que
  // sobrevive y no es letra ni número son emojis y símbolos, que aquí no
  // aportan nada y estorban al comparar.
  const norm = normalizeIntentText(text)
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');

  if (norm === '') return true;

  return norm.split(' ').every((palabra) => PALABRAS_DE_ACUSE.has(palabra));
}
