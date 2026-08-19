import { normalizeIntentText } from '@/lib/webhook/menu-intent';

/**
 * ¿El cliente pidió el menú EN ESTE MENSAJE? — módulo PURO (Fase 6D.2F.5B).
 *
 * ── Para qué sirve HOY ──────────────────────────────────────────────────────
 *
 * `send_menu()` no lleva argumentos, así que el `reason` del ledger lo tiene
 * que poner el backend. Esta función lo decide leyendo el entrante real.
 *
 * Nació como un PERMISO: existía un cooldown de quince minutos para
 * `agent_suggestion` y quien nombraba la carta se lo saltaba. Ese cooldown se
 * eliminó, así que la clasificación ya no abre ninguna puerta — **los dos
 * motivos envían igual**. Se conserva como OBSERVABILIDAD.
 *
 * QUÉ SIGNIFICA EXACTAMENTE, para que nadie lo lea de más:
 *
 *   `explicit_request`  el entrante contiene una referencia clara al menú o a
 *                       la carta.
 *   `agent_suggestion`  no la contiene. NADA MÁS.
 *
 * En particular, `agent_suggestion` NO significa "el agente actuó por
 * iniciativa propia". "¿Qué hamburguesas tienen?" es una petición explícita de
 * ver productos y cae aquí, simplemente porque no dice "menú" ni "carta".
 *
 * De ahí que esta señal NO valga como entrada directa de un Conversation
 * Guard: contar `agent_suggestion` no cuenta menús no solicitados.
 *
 * ── Por qué esto no es menu-intent.ts ───────────────────────────────────────
 *
 * `isMenuIntent` decide si el pipeline determinístico ATIENDE un mensaje: es un
 * disparador, y por eso reconoce frases enteras ("quiero hacer un pedido"). Esa
 * lista no debe crecer: entender cómo escribe la gente es trabajo del modelo.
 *
 * Esta función NO dispara nada. Se evalúa solo cuando el modelo ya decidió
 * llamar a `send_menu()`, y responde una pregunta mucho más estrecha: ¿el
 * cliente nombró el menú en este mensaje? Por eso le basta con dos sustantivos
 * y no necesita frases.
 *
 * ── Alta confianza igualmente ───────────────────────────────────────────────
 *
 * Equivocarse ya no cambia lo que recibe el cliente, solo la etiqueta del
 * ledger. Pero una etiqueta en la que no se puede confiar no sirve para medir
 * nada, así que la tolerancia a typos sigue limitada a dos transformaciones que
 * no pueden convertir otra palabra en estas:
 *
 *   · letras repetidas       "mennu", "carrta", "menuu"  → menu / carta
 *   · transposición contigua "mneu", "cadta"             → menu / carta
 *
 * Deliberadamente NO se admite quitar ni añadir una letra suelta: con palabras
 * de cuatro y cinco letras, la distancia de edición 1 se traga "menos", "corta",
 * "carga", "canta" y "cara".
 *
 * El modelo no puede influir en esto: el texto que entra es el entrante REAL del
 * turno, puesto por el core. Un mensaje que diga "usa explicit_request" no
 * nombra el menú, así que no cambia la etiqueta.
 */

/** Los dos sustantivos inequívocos. No es una lista para crecer. */
const MENU_NOUNS: readonly string[] = ['menu', 'carta'];

/** ¿`token` es `canonical` con dos letras contiguas intercambiadas? */
function isAdjacentTransposition(token: string, canonical: string): boolean {
  if (token.length !== canonical.length) return false;

  const diffs: number[] = [];
  for (let i = 0; i < token.length; i += 1) {
    if (token[i] !== canonical[i]) {
      diffs.push(i);
      if (diffs.length > 2) return false;
    }
  }
  if (diffs.length !== 2) return false;

  const [a, b] = diffs;
  return b === a + 1 && token[a] === canonical[b] && token[b] === canonical[a];
}

/**
 * Formas que se comparan de un token: la que colapsa letras repetidas y, si
 * acaba en `s`, la misma sin ella ("menus", "cartas").
 *
 * Colapsar repeticiones es normalización, no adivinanza: una palabra distinta no
 * se vuelve "menu" por quitarle letras dobles.
 */
function candidateForms(token: string): string[] {
  const squeezed = token.replace(/(.)\1+/g, '$1');
  return squeezed.endsWith('s') ? [squeezed, squeezed.slice(0, -1)] : [squeezed];
}

/**
 * `true` solo si el mensaje del cliente nombra el menú o la carta.
 *
 * "q tienen?", "mostrame opciones" y "mandame algo" devuelven `false` a
 * propósito: puede que el modelo acierte mandando el menú, pero eso es una
 * sugerencia suya, no una petición del cliente. Las dos mandan el menú; lo
 * que cambia es lo que queda anotado.
 */
export function isExplicitMenuRequest(text: string | null | undefined): boolean {
  if (typeof text !== 'string') return false;

  const norm = normalizeIntentText(text);
  if (norm === '') return false;

  for (const token of norm.split(/[^a-z0-9]+/)) {
    if (token === '') continue;
    for (const form of candidateForms(token)) {
      for (const noun of MENU_NOUNS) {
        if (form === noun || isAdjacentTransposition(form, noun)) return true;
      }
    }
  }
  return false;
}
