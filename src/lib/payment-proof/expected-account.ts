/**
 * La cuenta que DEBE aparecer en un comprobante — módulo PURO.
 *
 * Es el patrón contra el que se contrasta lo que se lee en la imagen: si el
 * dinero no fue a esta cuenta, no fue a Don Zarco. Todo sale de configuración,
 * nunca de la base ni del navegador: cambia una vez al año y no debe poder
 * cambiarlo quien entra al panel.
 *
 * ── Por qué la comparación es tolerante ─────────────────────────────────────
 *
 * Cada banco pinta lo mismo de forma distinta. La cuenta puede venir enmascarada
 * (`****1234`), con guiones o con espacios; el titular, en mayúsculas, con la
 * inicial del segundo nombre, con el apellido delante o con la razón social
 * abreviada. Comparar cadenas crudas produciría una alerta en cada pago legítimo
 * — y una alerta que salta siempre deja de leerse en dos días.
 *
 * Así que se compara lo que de verdad identifica: los dígitos finales de la
 * cuenta y las palabras del nombre. Estricto en lo que distingue, indiferente al
 * formato.
 *
 * ── Tres respuestas, no dos ─────────────────────────────────────────────────
 *
 * `unknown` existe a propósito y NO es una sospecha: significa que el dato no se
 * pudo leer, o que no está configurado. Tratar "no lo sé" como "no coincide"
 * convertiría cada foto borrosa en una acusación.
 */

export type FieldMatch = 'match' | 'mismatch' | 'unknown';

export interface ExpectedAccount {
  /** Banco o billetera donde se cobra. Informativo: no dispara sospecha. */
  bank: string | null;
  /** Número de cuenta destino. Se compara por sus dígitos finales. */
  accountNumber: string | null;
  /**
   * Nombres válidos del titular: el de la cuenta y cuantas variantes pinte cada
   * banco. Basta con que UNO coincida.
   */
  holderNames: string[];
}

/** Cuántos dígitos finales bastan para reconocer la cuenta enmascarada. */
export const ACCOUNT_TAIL_DIGITS = 4;

/** Deja solo los dígitos: fuera guiones, espacios, puntos y asteriscos. */
export function digitsOf(value: string | null | undefined): string {
  return (value ?? '').replace(/\D+/g, '');
}

/**
 * Normaliza un nombre para compararlo: mayúsculas, sin tildes, sin puntuación y
 * con los espacios colapsados. `JUAN PÉREZ-GARCÍA` y `juan perez garcia` son el
 * mismo nombre escrito por dos bancos distintos.
 */
export function normalizeName(value: string | null | undefined): string {
  return (value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9ÑÜ\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Palabras con las que se identifica a alguien. Las de una o dos letras se
 * descartan: `J.` y `DE` no distinguen a nadie, y exigirlas haría fallar
 * `JUAN P. ZARCO` contra `JUAN PABLO ZARCO`, que son la misma persona.
 */
function significantTokens(name: string): string[] {
  return normalizeName(name)
    .split(' ')
    .filter((t) => t.length > 2);
}

/**
 * ¿Coincide la cuenta leída con la esperada?
 *
 * Coincide si una contiene a la otra por sus dígitos, o si comparten los cuatro
 * últimos — que es lo único visible cuando el banco enmascara. Cuatro dígitos
 * son 1 entre 10 000: suficiente para reconocer la cuenta propia, y no es una
 * defensa criptográfica sino una comprobación de que el dinero fue al sitio.
 */
export function matchesAccount(read: string | null, expected: string | null): FieldMatch {
  const leido = digitsOf(read);
  const esperado = digitsOf(expected);
  if (!leido || !esperado) return 'unknown';
  if (leido === esperado) return 'match';

  // Un fragmento más corto que la cola no distingue lo suficiente NI para
  // reconocer ni para acusar: con dos dígitos visibles, una de cada cien cuentas
  // coincidiría por azar. Se comprueba ANTES que la inclusión, porque `90` está
  // dentro de casi cualquier número de cuenta.
  if (leido.length < ACCOUNT_TAIL_DIGITS || esperado.length < ACCOUNT_TAIL_DIGITS) {
    return 'unknown';
  }

  if (leido.includes(esperado) || esperado.includes(leido)) return 'match';
  const cola = (v: string) => v.slice(-ACCOUNT_TAIL_DIGITS);
  return cola(leido) === cola(esperado) ? 'match' : 'mismatch';
}

/**
 * ¿Es el titular leído el nuestro?
 *
 * Coincide si TODAS las palabras significativas del nombre más corto están en el
 * otro. Así `DON ZARCO` encaja dentro de `DON ZARCO SRL`, y `JUAN ZARCO` dentro
 * de `JUAN CARLOS ZARCO MENDOZA`, sin que `MARIA LOPEZ` encaje en ninguno.
 *
 * Con una sola palabra significativa a un lado se exige que esté en el otro: un
 * apellido suelto es poco, pero es exactamente lo que pinta más de un banco.
 */
export function matchesHolder(read: string | null, expected: string[]): FieldMatch {
  const leidos = significantTokens(read ?? '');
  const candidatos = expected.map(significantTokens).filter((t) => t.length > 0);
  if (leidos.length === 0 || candidatos.length === 0) return 'unknown';

  for (const esperados of candidatos) {
    const [corto, largo] =
      leidos.length <= esperados.length ? [leidos, esperados] : [esperados, leidos];
    if (corto.every((t) => largo.includes(t))) return 'match';
  }
  return 'mismatch';
}

/**
 * Lee la cuenta esperada de la configuración.
 *
 * Devuelve `null` si no hay cuenta ni titular: sin patrón no hay nada que
 * contrastar, y el análisis se queda apagado en vez de inventarse un veredicto.
 * Es el mismo fail-closed que usa la captura sin bucket.
 */
export function parseExpectedAccount(raw: {
  bank?: string | null;
  accountNumber?: string | null;
  holder?: string | null;
  holderAliases?: string | null;
}): ExpectedAccount | null {
  const accountNumber = (raw.accountNumber ?? '').trim() || null;
  const nombres = [raw.holder ?? '', ...(raw.holderAliases ?? '').split('|')]
    .map((n) => n.trim())
    .filter((n) => n.length > 0);
  if (accountNumber === null && nombres.length === 0) return null;
  return {
    bank: (raw.bank ?? '').trim() || null,
    accountNumber,
    holderNames: nombres,
  };
}
