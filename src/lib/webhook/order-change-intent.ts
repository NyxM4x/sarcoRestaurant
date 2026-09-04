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
 */
const MARCAS_DE_PREFERENCIA =
  /(^|\s)(sin|con|extra|aparte|bien|poca|poco|poquito|harta|harto|mucha|mucho|nada de|aumenta|aumentame|aumenteme|agrega|agregame|agregue|agregeme|aumente|anade|anadime|ponle|pongale|ponme|pongame|echale|echele|que (no )?(lleve|tenga|venga))(\s|$)/;

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

  const norm = normalizeIntentText(text);
  if (norm === '' || norm.length > KITCHEN_NOTE_MAX_LENGTH) return false;

  // 1. Tiene que pedir algo sobre lo ya pedido.
  if (!MARCAS_DE_PREFERENCIA.test(norm)) return false;

  // 2. Ni un número: "2 sodas", "3 papas", "10 bs" no son preferencias.
  if (/\d/.test(norm)) return false;

  // 3. Ni una cantidad escrita con letra.
  if (CANTIDADES_EN_LETRA.test(norm)) return false;

  // 4. Ni el nombre de nada que se venda. Se compara por PALABRA COMPLETA: si
  //    se buscara como subcadena, "sin papas" bloquearía por `papa` dentro de
  //    `papas` —que está bien— pero "solomillo" bloquearía por `lomito` sin
  //    tener nada que ver.
  const palabras = new Set(norm.split(/[^a-z0-9]+/).filter((p) => p !== ''));
  for (const termino of [...catalogTerms, ...GENERICOS_DE_PRODUCTO]) {
    if (palabras.has(termino)) return false;
    // El plural del castellano, que el catálogo guarda en singular: `papas`
    // tiene que reconocerse desde `papa`.
    if (palabras.has(`${termino}s`) || palabras.has(`${termino}es`)) return false;
  }

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

  const norm = normalizeIntentText(text);
  if (norm === '') return false;

  const palabras = new Set(norm.split(/[^a-z0-9]+/).filter((p) => p !== ''));
  const nombraProducto = [...catalogTerms, ...GENERICOS_DE_PRODUCTO].some(
    (t) => palabras.has(t) || palabras.has(`${t}s`) || palabras.has(`${t}es`),
  );
  if (!nombraProducto) return false;

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
  /(?:\s+(?:algo|alguna cosa|una cosa|otra cosa|otras cosas|cosas|mas|un poco|la cantidad|cantidad|mi pedido|el pedido|mi orden|la orden|pedido|mi compra|de nuevo|denuevo|otra vez|nuevamente|todo|porfa|porfis|porfavor|por favor|please|ahora|ahorita))+$/;

/**
 * Reconocer un olvido ya es pedir el cambio, aunque no haya verbo detrás.
 *
 * Es el momento en que uno relee lo que pidió: llega el total y aparece el "me
 * equivoqué". No hace falta que diga qué falta para devolverle su pedido.
 */
const ANUNCIO_DE_ERROR =
  /(^|\s)(me equivoque|me equivoco|equivoque|equivocado|me falto|me falta|me olvide|se me olvido|olvide|no puse|puse mal|esta mal mi pedido|mi pedido esta mal)(\s|$)/;

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

  const norm = normalizeIntentText(text);
  if (norm === '' || norm.length > ORDER_CHANGE_ANNOUNCEMENT_MAX_LENGTH) return false;

  // Habla de algo que se cambia y no es lo que lleva dentro el pedido.
  if (FUERA_DEL_PEDIDO.test(norm)) return false;

  if (ANUNCIO_DE_ERROR.test(norm)) return true;

  return ANUNCIO_DE_CAMBIO.test(norm.replace(COLA_SIN_CONTENIDO, ''));
}
