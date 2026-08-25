/**
 * Temporizador del ticket — modulo PURO con el reloj `nowMs` INYECTADO.
 *
 * Nunca devuelve tiempos negativos ni `NaN`: una fecha ilegible cuenta como
 * cero. Un pedido con el reloj del servidor adelantado no muestra "-00:12".
 */

/** A los 15 minutos en preparacion la tarjeta entra en alerta. */
export const KITCHEN_LATE_THRESHOLD_MS = 15 * 60 * 1000;

const HOUR_MS = 3_600_000;

/** Milisegundos transcurridos desde `fromIso`. Nunca negativo; invalido = 0. */
export function elapsedMs(fromIso: string | null | undefined, nowMs: number): number {
  if (!fromIso) return 0;
  const from = Date.parse(fromIso);
  if (Number.isNaN(from)) return 0;
  const diff = nowMs - from;
  return diff > 0 ? diff : 0;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** Formatea una duracion como `mm:ss`, o `h:mm:ss` a partir de la hora. */
export function formatElapsed(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}:${pad(minutes)}:${pad(seconds)}`;
  return `${pad(minutes)}:${pad(seconds)}`;
}

/** Atajo: duracion desde una fecha ISO hasta `nowMs`, ya formateada. */
export function formatElapsedSince(fromIso: string | null | undefined, nowMs: number): string {
  return formatElapsed(elapsedMs(fromIso, nowMs));
}

/** ¿El pedido lleva 15 minutos o mas esperando? (la alerta salta EN el minuto 15) */
export function isLate(fromIso: string | null | undefined, nowMs: number): boolean {
  return elapsedMs(fromIso, nowMs) >= KITCHEN_LATE_THRESHOLD_MS;
}

/** ¿Ya paso de la hora? (el formato cambia a `h:mm:ss`) */
export function exceedsHour(fromIso: string | null | undefined, nowMs: number): boolean {
  return elapsedMs(fromIso, nowMs) >= HOUR_MS;
}

/** Hora del dia en formato 24 h (`HH:MM`) para el historial de "Listos". */
export function formatClockTime(iso: string | null | undefined): string {
  if (!iso) return '--:--';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '--:--';
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
