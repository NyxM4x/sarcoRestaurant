import type { NormalizedOutboundMessage } from '@/lib/kapso/message-history';
import type { NotificationType } from './web-notify';

/**
 * Matcher puro de reconciliación (Fase 5.2D.5A).
 *
 * Responde a una única pregunta ante un envío ambiguo (timeout / respuesta
 * perdida): **¿existe ya un mensaje saliente que corresponda a esta
 * notificación?** Solo si la respuesta es "no" es seguro reintentar.
 *
 * Regla rectora: ante cualquier duda se devuelve `ambiguous` y decide una
 * persona. NUNCA se elige arbitrariamente entre dos candidatos.
 *
 * El resultado puede llevar `externalMessageId` (para persistirlo luego), pero
 * jamás teléfono ni contenido del mensaje.
 */

/**
 * Ventana por defecto tras el inicio del intento.
 *
 * 300 s (no 120): Kapso confirmó que un mensaje puede enviarse DESPUÉS de que
 * nuestra llamada HTTP expire. Una ventana corta haría que ese envío tardío
 * quedara fuera → `not_found` → reintento → duplicado.
 */
export const DEFAULT_MATCH_WINDOW_MS = 300_000;

/** Tolerancia hacia atrás para absorber desfase de reloj entre sistemas. */
export const DEFAULT_CLOCK_SKEW_MS = 5_000;

/** Estados que Kapso considera envío consumado. */
const CONFIRMED_STATUSES = new Set(['sent', 'delivered', 'read']);

export interface ReconciliationInput {
  orderNumber: string;
  /** Teléfono del pedido, ya normalizado a dígitos. */
  normalizedRecipient: string;
  notificationType: NotificationType;
  /** ISO 8601: momento en que empezó el intento de envío. */
  attemptStartedAt: string;
  windowMs?: number;
  clockSkewMs?: number;
  candidates: NormalizedOutboundMessage[];
}

export type ReconciliationResult =
  | { result: 'matched'; externalMessageId: string; status: string | null }
  | { result: 'not_found' }
  | { result: 'ambiguous'; count: number }
  | { result: 'provider_failed'; externalMessageId: string };

/**
 * El tipo de notificación debe corresponder al tipo del mensaje saliente. Con el
 * clasificador determinista (6D.2C) la equivalencia es directa e incluye
 * order_received, que ya NO colisiona con confirmation.
 */
function typeMatches(candidate: NormalizedOutboundMessage, type: NotificationType): boolean {
  return candidate.type === type;
}

/**
 * El candidato ya trae el instante normalizado (`timestampMs`), que acepta Unix
 * en segundos, en milisegundos o ISO. Un timestamp no interpretable NO coincide.
 */
function withinWindow(
  candidate: NormalizedOutboundMessage,
  startedAtMs: number,
  windowMs: number,
  skewMs: number,
): boolean {
  const ts = candidate.timestampMs;
  if (ts === null || !Number.isFinite(ts)) return false;
  return ts >= startedAtMs - skewMs && ts <= startedAtMs + windowMs;
}

/**
 * Filtra los candidatos que corresponden inequívocamente a la notificación.
 * Exportado para poder probar el filtrado por separado de la decisión.
 */
export function selectMatchingCandidates(
  input: ReconciliationInput,
): NormalizedOutboundMessage[] {
  const startedAtMs = Date.parse(input.attemptStartedAt);
  if (!Number.isFinite(startedAtMs)) return [];

  const windowMs = input.windowMs ?? DEFAULT_MATCH_WINDOW_MS;
  const skewMs = input.clockSkewMs ?? DEFAULT_CLOCK_SKEW_MS;

  return input.candidates.filter(
    (candidate) =>
      // 1. Solo salientes.
      candidate.direction === 'outbound' &&
      // 2. Destinatario exacto tras normalizar.
      candidate.recipient !== null &&
      candidate.recipient === input.normalizedRecipient &&
      // 3. Número de pedido como token exacto (lo extrae el parser, no substring).
      candidate.orderNumber !== null &&
      candidate.orderNumber === input.orderNumber &&
      // 4/5. Tipo de mensaje acorde a la notificación.
      typeMatches(candidate, input.notificationType) &&
      // 6. Dentro de la ventana temporal.
      withinWindow(candidate, startedAtMs, windowMs, skewMs),
  );
}

/**
 * Decide si un envío ambiguo ya ocurrió.
 *
 * - `matched`: exactamente un saliente confirmado (sent/delivered/read).
 * - `provider_failed`: solo evidencia de fallo del proveedor → reintentar es seguro.
 * - `ambiguous`: varios confirmados, o evidencia con estado no concluyente.
 * - `not_found`: ningún candidato → reintentar es seguro.
 */
export function reconcileOutbound(input: ReconciliationInput): ReconciliationResult {
  const matching = selectMatchingCandidates(input);
  if (matching.length === 0) return { result: 'not_found' };

  const confirmed = matching.filter(
    (c) => c.status !== null && CONFIRMED_STATUSES.has(c.status),
  );
  const failed = matching.filter((c) => c.status === 'failed');
  const inconclusive = matching.filter(
    (c) => !(c.status !== null && CONFIRMED_STATUSES.has(c.status)) && c.status !== 'failed',
  );

  // 12. Nunca elegir entre varios confirmados.
  if (confirmed.length > 1) return { result: 'ambiguous', count: confirmed.length };

  if (confirmed.length === 1) {
    return {
      result: 'matched',
      externalMessageId: confirmed[0].externalMessageId,
      status: confirmed[0].status,
    };
  }

  // Sin confirmados: un estado no concluyente sigue siendo evidencia de que
  // existe un mensaje. Reintentar podría duplicar → decide una persona.
  if (inconclusive.length > 0) {
    return { result: 'ambiguous', count: matching.length };
  }

  if (failed.length === 1) {
    return { result: 'provider_failed', externalMessageId: failed[0].externalMessageId };
  }

  // Varios fallidos: el reintento es seguro, pero no hay un id único que
  // persistir; se trata como ambiguo para que quede registro.
  return { result: 'ambiguous', count: failed.length };
}
