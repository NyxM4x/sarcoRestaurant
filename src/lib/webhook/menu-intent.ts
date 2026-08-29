/**
 * Detección determinística de intención de menú (Fase 6D.2E) — módulo PURO.
 *
 * Reemplaza en producción la necesidad de que el cliente escriba un código de
 * testing: reconoce frases naturales ("quiero pedir", "ver menú", "menu", …) con
 * normalización robusta (minúsculas, sin tildes, espacios colapsados) y matching
 * por FRASE/keyword controlada — NUNCA por substring ingenuo. Sin IA.
 *
 * Las NEGACIONES se evalúan ANTES que la intención positiva: "no quiero pedir"
 * jamás abre el menú. El trigger QA `TESTMENU9842` vive aparte (`menu-trigger`).
 */

/**
 * Normaliza para matching: trim, minúsculas, NFD sin diacríticos, sin signos y
 * espacios colapsados.
 *
 * ── Por qué se quitan los signos ────────────────────────────────────────────
 *
 * "¿Menú?" es la forma MÁS natural de preguntar por la carta, y con los signos
 * dentro no coincidía con nada: `menu?` no es `menu`, así que el cliente
 * escribía exactamente lo que había que escribir y no le llegaba nada. Un
 * detector que exige escribir sin signos de interrogación no es un detector.
 *
 * Se quitan los de puntuación y cierre, no los alfanuméricos: lo que distingue
 * una intención de otra son las palabras.
 */
export function normalizeIntentText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // elimina diacríticos/tildes (marcas combinantes)
    .toLowerCase()
    .replace(/[¿?¡!.,;:"'()]/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Saludos con los que la gente ABRE el mensaje antes de pedir de verdad.
 *
 * "Hola, quiero pedir" es un mensaje real y frecuentísimo, y no coincidía con
 * nada: las frases de intención están ancladas al COMIENZO —y con razón, es lo
 * que evita los falsos positivos— pero eso dejaba fuera a todo el que saluda
 * primero, que en WhatsApp es casi todo el mundo.
 *
 * Se retiran los saludos ENCADENADOS del principio, y solo del principio.
 * Quitar palabras hasta que algo encaje convertiría el detector en una búsqueda
 * de subcadena, que es justo lo que este módulo no hace; retirar prefijos de
 * una lista CERRADA es otra cosa, y es la que se hace aquí.
 *
 * ── Por qué se encadenan (29-08-2026) ───────────────────────────────────────
 *
 * Se retiraba UNO y se paraba. Con eso, dos mensajes reales de prueba no se
 * reconocían y acababan en el modelo:
 *
 *   "Hola Zarco cómo va quiero pedir"  → quedaba "zarco como va quiero pedir"
 *   "Hola buenas quería pedir"         → quedaba "buenas queria pedir"
 *
 * Nadie saluda con una sola palabra: se encadena el saludo, el vocativo y la
 * fórmula de cortesía. Por eso entran también `zarco`, `don zarco`, `como va` y
 * `que dice` — el nombre del negocio usado como vocativo es parte del saludo en
 * este chat, no parte de la petición.
 */
const SALUDOS: readonly string[] = [
  'hola',
  'holi',
  'buenas',
  'buenas noches',
  'buenas tardes',
  'buenos dias',
  'buen dia',
  'hey',
  'que tal',
  'que dice',
  'que hay',
  'como va',
  'como esta',
  'como estas',
  'zarco',
  'don zarco',
  'disculpa',
  'disculpe',
  'por favor',
];

/**
 * Cuántos saludos encadenados se retiran como mucho.
 *
 * Un tope, no un bucle abierto: sin él, una lista de saludos suficientemente
 * larga acabaría comiéndose mensajes enteros palabra a palabra, que es
 * exactamente la búsqueda de subcadena que este módulo evita. Cuatro cubre
 * "hola buenas noches don zarco …", que ya es más de lo que escribe nadie.
 */
const MAX_SALUDOS_ENCADENADOS = 4;

/** Quita los saludos iniciales encadenados. Devuelve el texto tal cual si no hay. */
function sinSaludoInicial(norm: string): string {
  // Del más largo al más corto: "buenas noches" antes que "buenas", o quedaría
  // un "noches" suelto delante de la intención.
  const ordenados = [...SALUDOS].sort((a, b) => b.length - a.length);

  let actual = norm;
  for (let i = 0; i < MAX_SALUDOS_ENCADENADOS; i += 1) {
    const antes = actual;
    for (const saludo of ordenados) {
      if (actual === saludo) return '';
      if (actual.startsWith(`${saludo} `)) {
        actual = actual.slice(saludo.length + 1).trim();
        break;
      }
    }
    // Ninguno encajó: ya no queda saludo que quitar.
    if (actual === antes) break;
  }
  return actual;
}

/**
 * Frases que solo activan por COINCIDENCIA EXACTA del texto completo normalizado.
 * Palabras sueltas o frases cortas donde un "empieza por" daría falsos positivos.
 */
const EXACT_PHRASES: ReadonlySet<string> = new Set([
  'menu', // "menú" normaliza a "menu"
  'carta',
  'pedir',
  'ordenar',
  'que tienen', // "qué tienen" → "que tienen"
]);

/**
 * Frases de intención que activan de forma EXACTA o como COMIENZO de frase
 * (p. ej. "quiero pedir una doble o nada" empieza por "quiero pedir").
 */
const PREFIX_PHRASES: readonly string[] = [
  'ver menu',
  'ver carta',
  'ver productos',
  'quiero pedir',
  'quiero ordenar',
  'quiero comprar',
  'quiero hacer un pedido',
  'quiero un pedido',
  'hacer pedido',
  'hacer un pedido',
  // El imperfecto de cortesía. En Bolivia "quería pedir" es MÁS frecuente que
  // "quiero pedir" —suaviza la petición— y se quedaba fuera por un acento y
  // dos letras. Salió en un flujo real el 29-08-2026: "Hola buenas quería
  // pedir" no abría el menú.
  'queria pedir',
  'queria ordenar',
  'queria hacer un pedido',
  'quisiera pedir',
  'quisiera ordenar',
  'quisiera hacer un pedido',
  'necesito pedir',
];

/**
 * "No puedo acceder al menú" SÍ es necesidad del menú (6D.2E.final): frases con
 * negación pero que expresan que el cliente NO logra ver/abrir la carta. Debe
 * distinguirse de rechazar un pedido ("no quiero pedir"). Requiere un verbo de
 * acceso frustrado + un sustantivo de menú.
 */
const NEEDS_MENU =
  /\b(no encuentro|no veo|no me aparece|no me sale|no puedo ver|no puedo abrir|no carga|no me carga|no abre)\b.*\b(menu|carta|productos)\b/;

/**
 * `true` solo si el texto expresa intención/necesidad de ver o pedir del menú.
 *
 * Orden:
 *   1. "No puedo ver el menú" (negación de ACCESO) → true.
 *   2. Frase exacta o comienzo de frase controlada de intención → true.
 *   3. Todo lo demás → false.
 *
 * Las negaciones de INTENCIÓN de pedir ("no quiero pedir", "ya no quiero
 * ordenar", "todavía no quiero hacer un pedido") caen a false SIN necesidad de
 * un guard global: empiezan por "no/ya no/todavía…", así que nunca coinciden con
 * las frases de intención (ancladas al COMIENZO) ni con las exactas. Evitar un
 * bloqueo global por el token "no" es justo lo que permite (1).
 */
export function isMenuIntent(text: string | null | undefined): boolean {
  if (typeof text !== 'string') return false;

  const norm = normalizeIntentText(text);
  if (norm === '') return false;

  // 1. Necesidad de menú expresada con negación de acceso ("no veo la carta").
  if (NEEDS_MENU.test(norm)) return true;

  // 2. Intención positiva, con y sin el saludo de apertura. Las negaciones
  //    siguen cayendo fuera: quitar "hola" de "hola no quiero pedir" deja "no
  //    quiero pedir", que tampoco empieza por ninguna frase de intención.
  const candidatos = [norm, sinSaludoInicial(norm)];
  return candidatos.some(
    (c) =>
      c !== '' &&
      (EXACT_PHRASES.has(c) || PREFIX_PHRASES.some((p) => c === p || c.startsWith(`${p} `))),
  );
}
