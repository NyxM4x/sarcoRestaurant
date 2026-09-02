/**
 * Formateo de presentacion — modulo PURO (seguro en cliente). Sin datos tecnicos.
 * Solo transforma la PRESENTACION: nunca modifica los datos almacenados ni los
 * contratos internos (la moneda en base sigue siendo 'BOB').
 */

const MONEY = new Intl.NumberFormat('es-BO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Simbolo visual por codigo de moneda. 'BOB' se muestra como 'Bs'. */
const CURRENCY_SYMBOL: Record<string, string> = { BOB: 'Bs' };

export function currencySymbol(currency = 'BOB'): string {
  return CURRENCY_SYMBOL[currency] ?? currency;
}

/** Formatter monetario centralizado: `Bs 86,00`. Solo presentacion. */
export function formatMoney(amount: number, currency = 'BOB'): string {
  const value = Number.isFinite(amount) ? amount : 0;
  return `${currencySymbol(currency)} ${MONEY.format(value)}`;
}

/**
 * Normaliza SOLO visualmente el nombre del cliente: si viene todo en MAYUSCULAS
 * lo pasa a Capitalizacion por palabra. Cualquier otro caso se deja intacto. No
 * altera datos almacenados, numeros de pedido ni referencias.
 */
export function formatCustomerName(name: string | null | undefined): string | null {
  if (name == null) return null;
  const trimmed = name.trim();
  if (trimmed === '') return null;
  const hasLetters = /\p{L}/u.test(trimmed);
  // Solo se transforma cuando esta completamente en mayusculas (grito de datos).
  if (hasLetters && trimmed === trimmed.toUpperCase()) {
    return trimmed
      .toLocaleLowerCase('es-BO')
      .replace(/\p{L}[\p{L}\p{M}'’-]*/gu, (w) => w.charAt(0).toLocaleUpperCase('es-BO') + w.slice(1));
  }
  return trimmed;
}

/**
 * Formatea SOLO visualmente un telefono. Cuando el valor es inequivocamente
 * boliviano —codigo 591 + movil de 8 digitos que empieza en 6 o 7— lo muestra
 * como `+591 76543210`. Cualquier otro formato se devuelve tal cual (sanitizado
 * con trim). No altera el dato almacenado, las APIs, WhatsApp ni Supabase.
 */
export function formatPhone(phone: string | null | undefined): string | null {
  if (phone == null) return null;
  const trimmed = phone.trim();
  if (trimmed === '') return null;
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('591') && /^[67]/.test(digits.slice(3))) {
    return `+591 ${digits.slice(3)}`;
  }
  return trimmed;
}

const TIME = new Intl.DateTimeFormat('es-BO', {
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'America/La_Paz',
});
const DATE = new Intl.DateTimeFormat('es-BO', {
  day: '2-digit',
  month: 'short',
  timeZone: 'America/La_Paz',
});
const DATE_LONG = new Intl.DateTimeFormat('es-BO', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'America/La_Paz',
});

/**
 * Fecha Y hora, en la zona del local.
 *
 * Sin `timeZone` explícito, `toLocaleString` usa la del navegador: el mismo
 * instante se leería distinto según dónde esté quien mira el panel, y en un
 * negocio que cierra a las 04:00 esa diferencia confunde de verdad.
 */
const DATE_TIME = new Intl.DateTimeFormat('es-BO', {
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'America/La_Paz',
});

function parse(iso: string): Date | null {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t) : null;
}

export function formatTime(iso: string): string {
  const d = parse(iso);
  return d ? TIME.format(d) : '--:--';
}

export function formatDate(iso: string): string {
  const d = parse(iso);
  return d ? DATE.format(d) : '';
}

export function formatDateTime(iso: string): string {
  const d = parse(iso);
  return d ? DATE_TIME.format(d) : '';
}

export function formatLongDate(nowMs: number): string {
  return DATE_LONG.format(new Date(nowMs));
}

export function deliveryTypeLabel(t: string): string {
  return t === 'delivery' ? 'Delivery' : 'Recojo';
}

/**
 * Formatea una distancia de ruta (metros enteros de la base) a kilómetros con
 * dos decimales, p. ej. `1627 → "1.63 km"`, `6169 → "6.17 km"`. Solo presentación
 * (información operativa del detalle). Defensivo: `null`/`undefined`/`NaN`/negativo
 * devuelven `null` para que la UI simplemente no muestre la fila (sin lanzar).
 */
export function formatDistanceKm(meters: number | null | undefined): string | null {
  if (meters == null || !Number.isFinite(meters) || meters < 0) return null;
  return `${(meters / 1000).toFixed(2)} km`;
}
