/**
 * Cotizar el envío ANTES de que exista un pedido — módulo PURO.
 *
 * ── El cliente que esto atiende ─────────────────────────────────────────────
 *
 * No entra al menú hasta saber cuánto le sale el envío. Manda "cotizame el
 * delivery" y su ubicación por el botón normal de WhatsApp, y hasta ahora no le
 * contestaba nadie: el pipeline solo sabe atender un pin que RESPONDE a la
 * petición del sistema, y uno suelto se descartaba antes de llegar al agente.
 * Silencio absoluto, justo al que estaba decidiendo si pedir.
 *
 * ── Por qué no lo hace el modelo ────────────────────────────────────────────
 *
 * Porque no hay nada que interpretar. La tarifa es `feeForMeters`, una tabla de
 * metros a bolivianos, y la distancia la mide Mapbox. Un pin es una petición de
 * cotización sin ambigüedad posible: quien manda sus coordenadas a un
 * restaurante que reparte quiere saber cuánto cuesta que se lo lleven. Pasar eso
 * por el modelo añadiría tokens, latencia y la posibilidad de que un día diga un
 * número que no salió de la tabla.
 *
 * ── El cupo, y por qué la del pedido no cuenta ──────────────────────────────
 *
 * Cada medición es una llamada de pago. Una cotización gratis e ilimitada es un
 * juguete: diez pines son diez llamadas. Pero el cupo gobierna SOLO los pines
 * sueltos. La cotización del checkout —la del pedido armado, con productos y un
 * cliente que ya decidió— corre siempre, sin contador. Bloquearla sería dejar un
 * pedido real sin precio de envío por haber preguntado antes, que es castigar
 * exactamente la conducta que queremos.
 *
 * Así, el viaje completo del cliente que pregunta y luego pide gasta UNA unidad
 * de cupo, no dos.
 */

/** Cuántas cotizaciones sueltas recibe un mismo teléfono por ventana. */
export const STANDALONE_QUOTE_LIMIT = 2;

/**
 * Ventana del cupo. Doce horas y no una: cubre una jornada de servicio entera
 * (18:00 a 04:00), así que el cupo se mide por noche y no por rato. Quien
 * pregunta al abrir y vuelve a preguntar de madrugada sigue dentro.
 */
export const STANDALONE_QUOTE_WINDOW_HOURS = 12;

/**
 * Cuánto puede moverse un pin y seguir siendo el mismo punto.
 *
 * Diez metros es el temblor del GPS: la misma persona, sin moverse del sitio,
 * manda "ubicación actual" dos veces y las coordenadas no coinciden. Sin
 * tolerancia el reuso no acertaría casi nunca.
 *
 * Y es seguro porque los tramos del tarifario miden un kilómetro: para que diez
 * metros cambien el precio, el cliente tendría que estar parado justo encima de
 * la frontera de un tramo. Aun entonces la diferencia es de un escalón —1 o 2
 * Bs—, y a cambio se evita pagar dos veces por medir el mismo punto.
 */
export const QUOTE_REUSE_TOLERANCE_METERS = 10;

/**
 * Cuánto vale una medición antes de volver a preguntarle a Mapbox.
 *
 * La distancia por carretera hasta unas coordenadas no cambia entre las 12:18 y
 * las 12:25. Podría cambiar en semanas —una calle nueva, un sentido invertido—,
 * y doce horas está muy por debajo de eso.
 */
export const QUOTE_REUSE_WINDOW_HOURS = 12;

/** Radio terrestre medio, en metros. */
const EARTH_RADIUS_METERS = 6_371_000;

export interface Coords {
  lat: number;
  lng: number;
}

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/**
 * Distancia en línea recta entre dos puntos (haversine), en metros.
 *
 * En línea recta y NO por carretera, a propósito: aquí no se está tarifando, se
 * está preguntando "¿es este el mismo sitio?". Para eso la ruta sobra —y
 * costaría otra llamada—, mientras que la separación física responde exacto.
 *
 * Devuelve `Infinity` ante cualquier coordenada que no sea un número finito, de
 * forma que una entrada corrupta nunca se parezca a "el mismo punto".
 */
export function metersBetween(a: Coords, b: Coords): number {
  const valores = [a.lat, a.lng, b.lat, b.lng];
  if (valores.some((v) => typeof v !== 'number' || !Number.isFinite(v))) return Infinity;

  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** ¿Los dos pines son, a efectos de tarifa, el mismo sitio? */
export function isSamePoint(
  a: Coords,
  b: Coords,
  toleranceMeters: number = QUOTE_REUSE_TOLERANCE_METERS,
): boolean {
  return metersBetween(a, b) <= toleranceMeters;
}

/** ¿Le queda cupo a este teléfono? `answered` son las que llegó a recibir. */
export function hasQuoteQuota(
  answered: number,
  limit: number = STANDALONE_QUOTE_LIMIT,
): boolean {
  return answered < limit;
}

// ── Lo que se le dice al cliente ────────────────────────────────────────────

/** Bs con dos decimales solo cuando hacen falta: "15" y no "15.00". */
function formatBs(amount: number): string {
  return Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
}

/**
 * La cotización.
 *
 * Dice el precio y adónde ir después, sin prometer nada más. No afirma que el
 * pedido esté hecho, no da un plazo de entrega y no menciona kilómetros: la
 * distancia es un dato nuestro, y publicarla solo invita a discutirla.
 */
export function buildQuoteText(amount: number): string {
  return (
    `El envío hasta tu ubicación sale Bs ${formatBs(amount)} 🛵 ` +
    'Armá tu pedido en el menú y al confirmarlo lo ves sumado al total.'
  );
}

/**
 * Fuera de cobertura. Distinto del texto del pedido ya armado
 * (`OUT_OF_COVERAGE_TEXT`), que habla de "tu pedido": aquí todavía no hay
 * ninguno, y decir lo contrario confundiría a quien solo preguntó.
 */
export const QUOTE_OUT_OF_COVERAGE_TEXT =
  'Esa ubicación nos queda fuera de la zona de delivery 😔 ' +
  'Si querés, escribinos y vemos si hay alguna alternativa.';

/**
 * No se pudo medir. Se dice, y se ofrece el camino que sí funciona.
 *
 * Callar aquí sería repetir el fallo que este flujo vino a arreglar: el cliente
 * mandó algo y no recibió nada.
 */
export const QUOTE_FAILED_TEXT =
  'No pude calcularte el envío en este momento 😕 ' +
  'Armá tu pedido en el menú y al confirmarlo te lo cotizamos ahí mismo.';

/**
 * La respuesta a "¿cuánto me sale el envío?" cuando todavía no mandó el pin.
 *
 * Es una respuesta COMPLETA, no un rodeo: sin la ubicación no existe ninguna
 * cifra que dar —la tarifa depende de la distancia— así que pedirla es
 * exactamente lo que hay que hacer. Dice también que no hace falta armar el
 * pedido antes, que es lo que el cliente teme cuando pregunta esto.
 *
 * Sale por el camino determinista, sin pasar por el modelo. Ver
 * `webhook/delivery-quote-intent.ts` para las dos veces que se intentó al revés.
 */
export const ASK_LOCATION_FOR_QUOTE_TEXT =
  'Para decirte cuánto sale el envío necesito tu ubicación 📍 Compartila con el ' +
  'botón de WhatsApp y te la cotizo al toque, sin que tengas que armar el pedido antes.';

/**
 * Cupo agotado. NO se le niega el dato: se le manda por el camino que además
 * termina en un pedido.
 *
 * Sin acusar y sin hablar de límites ni de cuántas veces preguntó. Un cliente no
 * tiene por qué enterarse de que existe un contador.
 */
export const QUOTE_OVER_LIMIT_TEXT =
  'Para cotizarte el envío exacto, armá tu pedido en el menú 🛵 ' +
  'Al confirmarlo compartís tu ubicación y te sale el costo antes de pagar.';
