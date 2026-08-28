/**
 * Cómo se LEE un número de pedido — módulo PURO.
 *
 * Desde 0026 el número guardado es `ORD-260828-007`: lleva la jornada dentro
 * para ser único para siempre. Pero nadie en cocina dice "ORD guion dos seis
 * cero ocho dos ocho guion cero cero siete": dice "el siete".
 *
 * Este módulo separa las dos cosas. El valor que viaja, se busca y se guarda no
 * cambia nunca; lo que cambia es lo que se pinta.
 *
 * ── Los números viejos siguen funcionando ───────────────────────────────────
 *
 * `ORD-000019` y cualquier otro formato anterior se devuelven TAL CUAL. Un
 * pedido viejo tiene que poder mirarse, buscarse y nombrarse igual que antes;
 * inventarle un correlativo que nunca tuvo sería peor que enseñar el número
 * largo.
 */

/** `ORD-AAMMDD-NNN`, con al menos tres dígitos de correlativo. */
const DAILY_FORMAT = /^ORD-(\d{2})(\d{2})(\d{2})-(\d{3,})$/;

export interface OrderNumberParts {
  /** Correlativo de la noche, ya sin ceros a la izquierda: `7`. */
  daily: number | null;
  /** Día de la jornada, `DD/MM`. */
  dayLabel: string | null;
}

/**
 * Descompone un número de pedido. Ambos campos son `null` si no tiene el
 * formato con jornada — que es exactamente lo que hay que saber para decidir si
 * se puede acortar.
 */
export function parseOrderNumber(raw: string | null | undefined): OrderNumberParts {
  const m = DAILY_FORMAT.exec((raw ?? '').trim());
  if (!m) return { daily: null, dayLabel: null };
  const [, , mes, dia, correlativo] = m;
  return { daily: Number(correlativo), dayLabel: `${dia}/${mes}` };
}

/**
 * El número como se dice en voz alta: `#7`.
 *
 * Si el pedido es de antes de la numeración diaria, devuelve el número entero
 * sin tocarlo.
 */
export function shortOrderNumber(raw: string): string {
  const { daily } = parseOrderNumber(raw);
  return daily === null ? raw : `#${daily}`;
}

/**
 * La jornada a la que pertenece, `DD/MM`, o `null`.
 *
 * Va SIEMPRE junto al número corto en cualquier pantalla que pueda mostrar más
 * de una noche a la vez. Sin ella, dos pedidos "#7" de dos noches distintas son
 * indistinguibles, y ese es justo el precio de reiniciar el contador.
 */
export function orderDayLabel(raw: string): string | null {
  return parseOrderNumber(raw).dayLabel;
}
