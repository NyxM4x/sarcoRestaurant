import { normalizeIntentText } from './menu-intent';

/**
 * QUÉ QUIERE EL CLIENTE CON UN PEDIDO QUE YA ARMÓ (04-09-2026).
 *
 * ── Qué distingue esto de rearmar el pedido ─────────────────────────────────
 *
 * Después de la cotización, el cliente que escribe puede querer dos cosas muy
 * distintas, y confundirlas cuesta dinero:
 *
 *   "sin cebolla" · "con ketchup" · "auméntame la mayonesa"
 *        → una PREFERENCIA de cocina. No cambia una sola línea del pedido ni un
 *          centavo del total. Mandarle a rearmar todo su pedido por esto es
 *          desproporcionado: se anota y se le dice que sí.
 *
 *   "mándame 2 sodas más" · "no puse la gaseosa"
 *        → un CAMBIO DE LÍNEAS. Cambia el total, y por tanto el QR y lo que la
 *          cocina prepara. Eso NO se anota: se arma de nuevo.
 *
 * ── La asimetría es deliberada, y es toda la seguridad de este módulo ───────
 *
 * Los dos errores posibles NO cuestan lo mismo:
 *
 *   una preferencia tratada como cambio  →  el cliente recibe un mensaje que no
 *                                           le encaja. Molesto, recuperable.
 *   un cambio tratado como preferencia   →  "2 sodas más" queda escrito en las
 *                                           notas, el total sigue siendo el
 *                                           viejo, y o cobramos de menos o el
 *                                           cliente no recibe lo que pidió.
 *
 * Así que en la duda NO es una nota. Hace falta una marca de preferencia Y que
 * no aparezca ni un producto del catálogo ni una cantidad. Cualquier sombra de
 * cambio de líneas cae fuera y sigue el camino de siempre.
 *
 * ── Por qué el catálogo se inyecta y no se escribe aquí ─────────────────────
 *
 * Los términos salen de `menu_items` en tiempo de ejecución. Si mañana el local
 * vende "Cebolla frita", "sin cebolla" deja de ser una nota automáticamente y
 * sin que nadie tenga que acordarse de tocar este archivo. Una lista de
 * productos copiada aquí se desincronizaría con la carta el primer día.
 */

/**
 * Lo que convierte un mensaje en una instrucción para la plancha.
 *
 * Todas piden algo SOBRE lo ya pedido: quitar, poner o graduar. Ninguna
 * introduce un producto — eso es justo lo que las separa de un cambio.
 *
 * ── La "q" cuesta un pedido (04-09-2026) ────────────────────────────────────
 *
 * "Me olvide colocar q tenga toda sus salsas" no entraba por dos letras: el
 * patrón exigía "que" entero y el cliente escribió "q", que es como se escribe
 * en WhatsApp. Sin marca de preferencia, la frase cayó al anuncio de cambio
 * —"olvidé" está ahí— y ese cliente recibió el botón de rehacer su pedido por
 * pedir salsas. Acabó con dos pedidos.
 *
 * Por eso entran también `q` y `ke`, y los verbos con los que se pide que algo
 * ACOMPAÑE al plato ("colocá", "poné"): son preferencias de cocina, y si además
 * nombran un producto, el filtro del catálogo las devuelve al camino del cambio.
 */
const MARCAS_DE_PREFERENCIA =
  /(^|\s)(sin|con|extra|aparte|bien|poca|poco|poquito|harta|harto|mucha|mucho|nada de|aumenta|aumentame|aumenteme|agrega|agregame|agregue|agregeme|aumente|anade|anadime|ponle|pongale|ponme|pongame|coloca|colocale|coloque|colocar|echale|echele|(que|q|ke) (no )?(lleve|tenga|venga|sea|vaya|pique|piquen|este|salga))(\s|$)/;

/**
 * Palabras que delatan un CAMBIO de líneas aunque no estén en la carta.
 *
 * Son las categorías con las que la gente pide sin nombrar el producto exacto
 * ("mandame otra bebida", "agregame un combo"). El catálogo inyectado cubre los
 * nombres propios; esto cubre el genérico.
 */
const GENERICOS_DE_PRODUCTO: readonly string[] = [
  'combo',
  'combos',
  'promo',
  'promos',
  'promocion',
  'bebida',
  'bebidas',
  'gaseosa',
  'gaseosas',
  'refresco',
  'refrescos',
  'jugo',
  'jugos',
  'plato',
  'platos',
  'porcion',
  'porciones',
  'racion',
  'unidad',
  'unidades',
];

/**
 * Cantidades escritas con letra. Un numeral delante de cualquier cosa ya es
 * señal de "quiero N de algo", que es un cambio de líneas y no una preferencia.
 *
 * `un` y `una` entran aunque también sean artículos: "con una salsa" quedará
 * fuera y se tratará como cambio. Es el lado seguro del error.
 */
const CANTIDADES_EN_LETRA =
  /(^|\s)(un|una|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|media|medio|otra|otro|otras|otros|mas)(\s|$)/;

/**
 * Tope de longitud de una nota. Una preferencia de cocina cabe de sobra en dos
 * líneas; lo que pasa de aquí es una conversación, no una instrucción, y no
 * debe acabar impreso en la comanda.
 */
export const KITCHEN_NOTE_MAX_LENGTH = 120;

/**
 * Palabras del catálogo que bloquean la nota, ya normalizadas.
 *
 * Se toman los nombres de los productos ACTIVOS y se parten en palabras de
 * cuatro letras o más: "Gaseosa 2 L" aporta `gaseosa`, y "Vaso grande de
 * maracuyá" aporta `vaso`, `grande` y `maracuya`. Las palabras cortas se
 * descartan porque `de`, `2` o `L` aparecen en cualquier frase.
 */
export function catalogTermsFromNames(names: readonly string[]): string[] {
  const terminos = new Set<string>();
  for (const name of names) {
    for (const palabra of normalizeIntentText(name).split(/[^a-z0-9]+/)) {
      if (palabra.length >= 4) terminos.add(palabra);
    }
  }
  return [...terminos];
}

/**
 * El texto del cliente, normalizado y con los pegotes de WhatsApp separados.
 *
 * Un número pegado a una palabra es como se escribe una ráfaga con el pulgar:
 * "2com todo", "1sin locoto", "3trancapechos". Sin separarlo, ese mensaje no
 * tiene ni cantidad ni producto que reconocer — la ráfaga entera del pedido #20
 * pasó por delante de los tres detectores sin activar ninguno.
 *
 * Se separa aquí y no en `normalizeIntentText` a propósito: esa la comparten el
 * menú, la cotización y el recojo, y cambiarla movería a la vez puertas que hoy
 * funcionan. Este módulo es el que lee cantidades, así que es el que paga por
 * leerlas bien.
 */
function normalizeOrderText(text: string): string {
  return normalizeIntentText(text)
    .replace(/(\d)([a-z])/g, '$1 $2')
    .replace(/([a-z])(\d)/g, '$1 $2');
}

/**
 * Las palabras del mensaje, más las formas en que la gente escribe lo que se
 * vende. Es el set contra el que se compara el catálogo.
 *
 * ── El producto PARTIDO (05-09-2026) ────────────────────────────────────────
 *
 * "Que sean 3 tranca pecho" no activó nada la noche del pedido #20: la carta
 * dice `Trancapecho` —una palabra— y el cliente escribió dos. Como la
 * comparación es por palabra completa, el mensaje no nombraba ningún producto y
 * la puerta del cambio, que exige nombrarlo, lo dejó pasar de largo. Escrito
 * junto sí funcionaba: entre atender a ese cliente y no atenderlo había un
 * espacio.
 *
 * Se arregla por el lado del MENSAJE y no por el del catálogo: se añaden los
 * pares de palabras consecutivas ya pegados —"tranca pecho" aporta
 * `trancapecho`—. Partir en cambio los nombres de la carta obligaría a inventar
 * por dónde se cortan ("tranca|pecho", "hambur|guesa"), que es una decisión que
 * nadie puede tomar bien para un nombre que todavía no existe.
 *
 * ── El diminutivo ───────────────────────────────────────────────────────────
 *
 * Aquí se pide en diminutivo: "papitas", "gaseosita", "coquita". `papitas` no
 * es `papas` para una comparación exacta, así que "aumentame papitas" se
 * anotaba como preferencia de cocina —una porción más de papas que nadie
 * cobraba—. Se compara también la forma sin el infijo, que es una regla del
 * castellano y no una lista de productos.
 */
function wordsForCatalogMatch(norm: string): Set<string> {
  const palabras = norm.split(/[^a-z0-9]+/).filter((p) => p !== '');
  const set = new Set(palabras);

  for (let i = 0; i < palabras.length - 1; i += 1) {
    set.add(palabras[i] + palabras[i + 1]);
  }

  for (const palabra of palabras) {
    const sinDiminutivo = palabra.replace(/(?:it|ecit|cit)([oa]s?)$/, '$1');
    if (sinDiminutivo !== palabra) set.add(sinDiminutivo);
  }

  return set;
}

/**
 * ¿El mensaje nombra algo que se venda?
 *
 * La MISMA pregunta para las dos puertas: en la de la preferencia nombrar un
 * producto la descarta, y en la del cambio es requisito. Que sea una sola
 * función es lo que impide que se separen — el día que una reconozca "tranca
 * pecho" y la otra no, una frase caería en las dos o en ninguna.
 */
function namesAProduct(norm: string, catalogTerms: readonly string[]): boolean {
  const palabras = wordsForCatalogMatch(norm);
  for (const termino of [...catalogTerms, ...GENERICOS_DE_PRODUCTO]) {
    // El plural del castellano, que el catálogo guarda en singular: `papas`
    // tiene que reconocerse desde `papa`.
    if (palabras.has(termino) || palabras.has(`${termino}s`) || palabras.has(`${termino}es`)) {
      return true;
    }
  }
  return false;
}

/**
 * ¿Es una preferencia para la cocina y NADA más?
 *
 * @param text          Mensaje del cliente, tal como llegó.
 * @param catalogTerms  Términos del catálogo (ver `catalogTermsFromNames`).
 */
export function isKitchenNoteRequest(
  text: string | null | undefined,
  catalogTerms: readonly string[],
): boolean {
  if (typeof text !== 'string') return false;

  // Sin carta no se anota NADA. Una lista vacía significa que no se pudo leer
  // qué se vende, y sin eso no hay forma de descartar que el cliente esté
  // pidiendo un producto — que es el error caro. La duda no anota.
  if (catalogTerms.length === 0) return false;

  const norm = normalizeOrderText(text);
  if (norm === '' || norm.length > KITCHEN_NOTE_MAX_LENGTH) return false;

  // 1. Tiene que pedir algo sobre lo ya pedido.
  if (!MARCAS_DE_PREFERENCIA.test(norm)) return false;

  // 2. Ni un número: "2 sodas", "3 papas", "10 bs" no son preferencias.
  if (/\d/.test(norm)) return false;

  // 3. Ni una cantidad escrita con letra.
  if (CANTIDADES_EN_LETRA.test(norm)) return false;

  // 4. Y quien reconoce un OLVIDO no está pidiendo una preferencia, por mucho
  //    que la frase traiga un verbo de los de poner (05-09-2026).
  //
  //    "Me olvide, agregame esto" activaba las dos puertas —`agregame` es marca
  //    de preferencia y `me olvide` es anuncio de cambio— y esta se evalúa
  //    ANTES, así que ganaba: la frase se escribía tal cual en la comanda y al
  //    cliente se le contestaba "listo, ya lo anotamos". El total no cambiaba y
  //    él se quedaba creyendo que su cambio estaba hecho. Es peor que no
  //    entenderlo: es afirmar algo falso.
  //
  //    El olvido gana siempre, y con eso la frase sigue hasta la puerta del
  //    cambio, que le devuelve su pedido para que lo rearme él.
  if (ANUNCIO_DE_ERROR.test(norm)) return false;

  // 5. Ni el nombre de nada que se venda. Ver `namesAProduct`: se compara por
  //    PALABRA COMPLETA, porque como subcadena "solomillo" bloquearía por
  //    `lomito` sin tener nada que ver.
  if (namesAProduct(norm, catalogTerms)) return false;

  return true;
}

/**
 * La nota tal como la verá la cocina: el texto del cliente, saneado.
 *
 * Es SU texto y no una paráfrasis: quien lee la comanda tiene que ver lo que
 * pidió, no lo que alguien entendió que pedía. Se recorta a una línea y se
 * limita la longitud; el resto se conserva tal cual, con sus tildes y su forma
 * de escribir.
 */
export function kitchenNoteFrom(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, KITCHEN_NOTE_MAX_LENGTH);
}

// ── La otra mitad: cuando SÍ hay que rearmar el pedido ──────────────────────

/**
 * Verbos con los que se pide quitar, poner o cambiar algo del pedido.
 *
 * Incluye las formas en que la gente reconoce un olvido —"no puse", "me
 * faltó", "olvidé"—, que son las que más aparecen justo después de ver el
 * total: es el momento en que uno relee lo que pidió.
 */
const MARCAS_DE_CAMBIO =
  /(^|\s)(sin|quita|quitame|quiteme|saca|sacame|saque|elimina|cambia|cambiame|cambieme|agrega|agregame|agregue|aumenta|aumentame|aumenteme|anade|anadime|sumale|mandame|mandeme|manda|envia|enviame|falta|falto|faltaba|olvide|olvidaste|no puse|me equivoque|quiero tambien|tambien quiero)(\s|$)/;

/** Una cantidad —en dígito o en letra— pegada a una palabra. "2 sodas". */
const CANTIDAD_CON_COSA =
  /(^|\s)(\d{1,2}|un|una|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|otra|otro)\s+[a-z]{3,}/;

/**
 * ¿Pide cambiar lo que hay dentro del pedido?
 *
 * Es la mitad CARA de la pregunta que abre este módulo: si esto acierta, el
 * cliente recibe el enlace para rearmar y su total se recalcula; si falla por
 * defecto, recibe el recordatorio del pago —molesto, pero sin consecuencias
 * sobre el dinero—. Por eso puede ser más laxo que `isKitchenNoteRequest` sin
 * que el error cambie de precio.
 *
 * Hacen falta DOS piezas, y esa exigencia es lo que lo separa de una pregunta
 * cualquiera: una marca de cambio o una cantidad, Y algo que se venda. "¿Cuánto
 * era la gaseosa?" nombra un producto y no pide nada, así que no entra.
 */
export function isOrderChangeRequest(
  text: string | null | undefined,
  catalogTerms: readonly string[],
): boolean {
  if (typeof text !== 'string') return false;
  if (catalogTerms.length === 0) return false;

  const norm = normalizeOrderText(text);
  if (norm === '') return false;

  if (!namesAProduct(norm, catalogTerms)) return false;

  return MARCAS_DE_CAMBIO.test(norm) || CANTIDAD_CON_COSA.test(norm);
}

// ── El ANUNCIO: pide cambiar antes de decir qué ─────────────────────────────

/**
 * "Puedo aumentar" — la frase con la que empieza casi todo cambio (04-09-2026).
 *
 * `isOrderChangeRequest` exige nombrar algo que se venda, y esa exigencia deja
 * fuera justo el primer mensaje: la gente pregunta si puede antes de decir qué
 * quiere. Una conversación real de esa madrugada lo enseña entero:
 *
 *   01:58  "Puedo aumentar"                    → no nombra producto: nadie contestó
 *   01:59  "Una hamburguesa con papas"         → esto SÍ lo reconocía… pero ya era tarde
 *
 * Entre las dos frases pasaron 81 segundos, y en ese hueco el turno cayó al
 * modelo —el determinístico no tenía nada que decir— que derivó la conversación
 * a una persona y la dejó en pausa dos horas. Cuando el cliente por fin nombró
 * los productos, el bot ya estaba callado; acabó armando un SEGUNDO pedido y el
 * negocio con dos comandas del mismo cliente, que es lo que 0035 venía a evitar.
 *
 * Reconocer el anuncio cierra el turno ahí mismo: sale el botón y el modelo ni
 * llega a hablar. Es la forma más barata de que `request_human` no se dispare.
 *
 * ── Por qué esto puede prescindir del catálogo ──────────────────────────────
 *
 * Porque lo que lo define es la AUSENCIA de producto. Las otras dos preguntas
 * del módulo necesitan la carta para descartar que el cliente nombrara algo;
 * esta reconoce la frase que, por construcción, no nombra nada. De paso queda
 * inmune al día en que `menu_items` no se pueda leer.
 *
 * ── "Quiero armar de nuevo" (04-09-2026) ────────────────────────────────────
 *
 * Es lo que escribió el dueño probando el flujo, y no lo reconocía nadie: no
 * nombra producto —así que la vía del catálogo lo ignora— y "armar" no estaba
 * entre los verbos. Lo que recibió fue el botón del menú de siempre, que abre un
 * pedido NUEVO en vez de corregir el suyo. Con "de nuevo", "otra vez" y
 * "nuevamente" tratados como cola sin contenido, "quiero armar de nuevo" y
 * "quiero empezar otra vez" caen donde tienen que caer.
 *
 * ── Dónde está la línea, y por qué ahí ──────────────────────────────────────
 *
 * El verbo tiene que CERRAR la frase: "puedo aumentar" es un anuncio, "puedo
 * aumentar el ají" es una preferencia de cocina disfrazada. Lo único que se
 * recorta antes de mirar son las colas que no dicen nada del contenido ("algo",
 * "más", "mi pedido", "porfa"). Con esa regla, todo lo que lleve un complemento
 * de verdad sigue el camino de hoy en vez de mandar a rearmar por un condimento.
 *
 * Sigue siendo el lado barato del error: un anuncio mal leído le manda al
 * cliente un botón que no necesitaba, y el que no se lee le cuesta el pedido.
 */

/**
 * Tope de longitud de un anuncio.
 *
 * Un anuncio son tres palabras; lo que pasa de aquí ya trae el detalle dentro y
 * lo tiene que leer la vía del catálogo, que sabe qué se vende.
 */
export const ORDER_CHANGE_ANNOUNCEMENT_MAX_LENGTH = 80;

/**
 * El verbo CIERRA la frase: no hay complemento que interpretar.
 *
 * En infinitivo, que es como se pregunta ("¿puedo aumentar?", "quiero
 * agregar"), y con el enclítico que la gente les pega ("aumentarle",
 * "cambiarlo").
 */
const ANUNCIO_DE_CAMBIO =
  /(^|\s)(aumentar|agregar|anadir|sumar|incrementar|cambiar|corregir|modificar|rehacer|rearmar|armar|empezar|comenzar|quitar|sacar|eliminar|poner)(me|le|lo|la|los|las|selo|sela)?$/;

/**
 * Colas que no dicen nada del contenido, y por eso se recortan antes de mirar.
 *
 * "Quiero agregar algo más porfa" es exactamente el mismo anuncio que "quiero
 * agregar": ninguna de esas tres palabras nombra lo que el cliente quiere.
 */
const COLA_SIN_CONTENIDO =
  /(?:\s+(?:algo|alguna cosa|una cosa|una cosita|otra cosa|otra cosita|cosita|otras cosas|cosas|un detalle|mas|un poco|la cantidad|cantidad|mi pedido|el pedido|mi orden|la orden|pedido|mi compra|de nuevo|denuevo|otra vez|nuevamente|todo|porfa|porfis|porfavor|por favor|please|ahora|ahorita))+$/;

/**
 * Reconocer un olvido ya es pedir el cambio, aunque no haya verbo detrás.
 *
 * Es el momento en que uno relee lo que pidió: llega el total y aparece el "me
 * equivoqué". No hace falta que diga qué falta para devolverle su pedido.
 */
const ANUNCIO_DE_ERROR =
  /(^|\s)(me equivoque|me equivoco|equivoque|equivocado|me falto|me falta|me olvide|m olvide|se me olvido|se me paso|se me pasa|olvide|no puse|puse mal|anadi mal|agregue mal|pedi mal|esta mal mi pedido|mi pedido esta mal|esta mal la orden|esta mal el pedido)(\s|$)/;

/**
 * Lo que también se "cambia" y no es el contenido del pedido.
 *
 * Estas palabras aparecen justo en este momento de la conversación —el cliente
 * tiene su total y su QR delante— y significan otra cosa: "me falta pagar" o
 * "puedo cambiar la dirección" no piden rearmar nada. Sigue su camino de hoy.
 */
const FUERA_DEL_PEDIDO =
  /(^|\s)(pagar|pago|pagos|pague|pagando|comprobante|qr|transferencia|deposito|recibo|efectivo|factura|envio|delivery|reparto|direccion|ubicacion|domicilio|numero|telefono|nombre|hora|demora|tiempo)(\s|$)/;

/**
 * ¿Anuncia que quiere cambiar su pedido, sin decir todavía qué?
 *
 * Solo tiene sentido preguntárselo a quien YA tiene un pedido armado y sin
 * pagar: fuera de ese estado, "puedo aumentar" no se refiere a nada. Esa guarda
 * la pone quien llama (`default-reply.ts`), que es quien conoce el pedido.
 */
export function isOrderChangeAnnouncement(text: string | null | undefined): boolean {
  if (typeof text !== 'string') return false;

  const norm = normalizeOrderText(text);
  if (norm === '' || norm.length > ORDER_CHANGE_ANNOUNCEMENT_MAX_LENGTH) return false;

  // Habla de algo que se cambia y no es lo que lleva dentro el pedido.
  if (FUERA_DEL_PEDIDO.test(norm)) return false;

  if (ANUNCIO_DE_ERROR.test(norm)) return true;

  return ANUNCIO_DE_CAMBIO.test(norm.replace(COLA_SIN_CONTENIDO, ''));
}

// ── "Que sean 3": corregir la cantidad sin volver a nombrar nada ────────────

/**
 * Corregir CUÁNTO, dando por hecho el QUÉ (05-09-2026).
 *
 * Es la forma más natural de rectificar delante del total —el producto acaba de
 * decirse, así que nadie lo repite— y no la reconocía ninguna de las tres
 * puertas: `isOrderChangeRequest` exige nombrar algo que se venda,
 * `isOrderChangeAnnouncement` exige que el verbo cierre la frase, y la de la
 * preferencia rechaza cualquier cifra. Estas frases se quedaban sin nadie:
 *
 *   "que sean 3" · "son 3 no 2" · "mejor 2" · "en realidad quiero 3"
 *
 * Solo tiene sentido para quien YA tiene un pedido armado y sin pagar, que es
 * la guarda que pone `default-reply.ts`. Fuera de ese estado "mejor 2" no se
 * refiere a nada.
 *
 * ── Por qué NO exige producto, y qué lo sujeta en su lugar ──────────────────
 *
 * Exigirlo sería pedirle al cliente que repita lo que acaba de decir. Lo que
 * sujeta el patrón es el otro lado: un verbo de ajuste pegado a la cifra —"que
 * sean", "mejor", "en vez de"— y una lista de unidades que descarta las cifras
 * que no cuentan comida ("en 20 minutos", "a 3 cuadras", "son 50 bs").
 *
 * Los litros y los kilos NO están en esa lista a propósito: aquí se vende
 * "Gaseosa 2 L", y "mejor una de 2 litros" es un cambio de pedido de verdad.
 *
 * Se queda del lado barato del error. Un falso positivo le manda a alguien el
 * botón de cambiar su pedido cuando hablaba de otra cosa: lo ignora y sigue. Un
 * falso negativo es la noche del pedido #20 — la comanda con 2 y el pago de 3.
 */
const CORRECCION_DE_CANTIDAD =
  /(^|\s)((que|q|ke) (sean|serian|sea)|serian|mejor|son|eran|era|en vez de|en lugar de|cambialo a|cambiala a|puse|pedi|quiero|queria|aumentame|agregame|ponme|pongame|hazme|haceme|mandame|dejalo en|deja en|sube a|subelo a|bajalo a)\s+(\d{1,2}|un|una|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)(\s|$)/;

/**
 * Cifras que no cuentan comida. Si aparece una, la frase habla de otra cosa.
 *
 * Son las unidades con las que se contesta en este mismo punto de la
 * conversación: cuánto falta, a qué distancia vive, cuánto costó.
 */
const UNIDAD_QUE_NO_ES_PEDIDO =
  /(^|\s)(\d{1,2}|un|una|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)\s+(minutos?|min|horas?|hrs?|cuadras?|metros?|kilometros?|km|pesos?|bs|bolivianos?|personas?|dias?|semanas?|meses|veces)(\s|$)/;

/**
 * ¿Corrige la cantidad de lo que ya pidió?
 *
 * No mira el catálogo: por definición estas frases no nombran producto. Ver el
 * comentario de `CORRECCION_DE_CANTIDAD` para saber qué las sujeta en su sitio.
 */
export function isQuantityFixRequest(text: string | null | undefined): boolean {
  if (typeof text !== 'string') return false;

  const norm = normalizeOrderText(text);
  if (norm === '' || norm.length > ORDER_CHANGE_ANNOUNCEMENT_MAX_LENGTH) return false;

  // "Me falta pagar 20 bs" no pide cambiar el pedido: habla del pago.
  if (FUERA_DEL_PEDIDO.test(norm)) return false;
  if (UNIDAD_QUE_NO_ES_PEDIDO.test(norm)) return false;

  return CORRECCION_DE_CANTIDAD.test(norm);
}
