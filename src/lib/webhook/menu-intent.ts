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

/** Normaliza para matching: trim, minúsculas, NFD sin diacríticos, espacios colapsados. */
export function normalizeIntentText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // elimina diacríticos/tildes (marcas combinantes)
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
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

  // 2. Intención positiva por frase/keyword controlada (anclada al comienzo).
  if (EXACT_PHRASES.has(norm)) return true;
  return PREFIX_PHRASES.some((p) => norm === p || norm.startsWith(`${p} `));
}
