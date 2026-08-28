/**
 * La JORNADA DE SERVICIO — módulo PURO.
 *
 * Don Zarco abre a las 18:00 y cierra a las 04:00 de la madrugada siguiente. Su
 * jornada de trabajo cruza la medianoche, así que "hoy" en el calendario y "hoy"
 * en la cocina no son lo mismo — y confundirlos rompe cosas de verdad:
 *
 *   · el tablero de cocina borraba las comandas al llegar el corte, en plena
 *     hora punta y con los pedidos todavía en la plancha;
 *   · la numeración diaria empezaría de nuevo a mitad del servicio, dejando dos
 *     "pedido 1" en la misma noche.
 *
 * Aquí vive la única definición de qué noche es cada instante.
 *
 * ── El corte va al MEDIODÍA ─────────────────────────────────────────────────
 *
 * La jornada del 28 de agosto va del 28 a las 12:00 al 29 a las 12:00, hora de
 * Bolivia. El servicio entero (18:00 → 04:00) cae holgado dentro, con ocho horas
 * de margen por delante y por detrás.
 *
 * Podría cortarse a las 17:00, justo antes de abrir, y sería más ajustado — pero
 * también más frágil: un pedido de prueba a las 16:30, o el día que abran una
 * hora antes, caerían en la jornada anterior sin que nadie entienda por qué. El
 * mediodía es la hora del día en la que con más seguridad no hay nadie pidiendo.
 *
 * ── Bolivia es UTC−4 y no tiene horario de verano ───────────────────────────
 *
 * Es una constante, no una consulta a `Intl`: la jornada de un pedido no puede
 * depender de la zona horaria configurada en el servidor que lo procese. Un
 * despliegue en otra región cambiaría la numeración de la noche entera.
 */

/** Bolivia entera, todo el año. */
export const BOLIVIA_UTC_OFFSET_MS = 4 * 60 * 60 * 1000;

/** Hora local a la que cambia la jornada. */
export const BUSINESS_DAY_CUTOVER_HOUR = 12;

const DAY_MS = 86_400_000;

/**
 * Clave de la jornada a la que pertenece un instante: `YYYY-MM-DD`.
 *
 * Es la fecha en la que ABRIÓ el local, no la del reloj. Un pedido de las 02:00
 * del sábado pertenece a la jornada del viernes, que es la noche en la que el
 * cocinero lo preparó y con la que cuadra la caja.
 */
export function businessDayOf(ms: number): string {
  const local = new Date(ms - BOLIVIA_UTC_OFFSET_MS);
  // Antes del corte todavía es la jornada de ayer: se retrocede un día entero
  // para que la fecha resultante sea la de la apertura.
  const ajustado =
    local.getUTCHours() < BUSINESS_DAY_CUTOVER_HOUR
      ? new Date(local.getTime() - DAY_MS)
      : local;
  const y = ajustado.getUTCFullYear();
  const m = String(ajustado.getUTCMonth() + 1).padStart(2, '0');
  const d = String(ajustado.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Instante UTC en que empieza la jornada que contiene a `ms`. */
export function businessDayStart(ms: number): number {
  const clave = businessDayOf(ms);
  const [y, m, d] = clave.split('-').map(Number);
  // La clave es una fecha local; su mediodía local se convierte a UTC sumando
  // el desfase.
  return Date.UTC(y, m - 1, d, BUSINESS_DAY_CUTOVER_HOUR) + BOLIVIA_UTC_OFFSET_MS;
}

/**
 * Límites `[desde, hasta)` de la jornada que contiene a `ms`, en ISO UTC.
 *
 * `offsetDays` retrocede jornadas enteras: `-1` es la noche anterior.
 */
export function businessDayBounds(
  ms: number,
  offsetDays = 0,
): { since: string; until: string } {
  const inicio = businessDayStart(ms) + offsetDays * DAY_MS;
  return {
    since: new Date(inicio).toISOString(),
    until: new Date(inicio + DAY_MS).toISOString(),
  };
}

/**
 * Etiqueta corta de la jornada para un número de pedido: `260828`.
 *
 * Dos dígitos de año bastan y ahorran espacio en una pantalla que se lee a un
 * metro. El orden año-mes-día se mantiene para que los números se ordenen solos.
 */
export function businessDayTag(ms: number): string {
  return businessDayOf(ms).slice(2).replace(/-/g, '');
}
