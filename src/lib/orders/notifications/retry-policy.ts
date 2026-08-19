/**
 * Política de reintentos — módulo puro y PRELIMINAR (Fase 5.2D.5A).
 *
 * Por ahora SOLO clasifica: no ejecuta reintentos, no toca la base de datos y
 * no cambia el comportamiento del servicio actual. La siguiente subfase la
 * consumirá desde el worker.
 *
 * Premisa confirmada por Kapso: un `timeout` es resultado DESCONOCIDO — el
 * mensaje puede enviarse después de que nuestra llamada expire. Por eso esos
 * casos no son "reintentables", sino `pending_reconciliation`: antes de
 * reenviar hay que comprobar si el mensaje existe.
 */

export type RetryClass =
  /** Resultado desconocido: reconciliar ANTES de decidir. Nunca reenviar a ciegas. */
  | 'pending_reconciliation'
  /** Seguro reintentar con backoff: el envío no llegó a procesarse. */
  | 'retryable'
  /** Reintentable, pero conviene reconciliar o esperar un backoff largo. */
  | 'retryable_after_reconciliation_or_backoff'
  /** No reintentar: requiere corrección humana o de datos. */
  | 'permanent'
  /**
   * No entendemos el fallo. NUNCA autoriza un reintento automático: reconciliar
   * requiere saber qué se envió, y aquí ni siquiera eso está claro. Decide una
   * persona.
   */
  | 'manual_review';

/** Códigos de error que ya produce el transporte y el orquestador. */
export type SendFailureCode =
  | 'timeout'
  | 'network_error'
  | 'invalid_response'
  | 'http_error'
  | 'invalid_phone'
  | 'invalid_text'
  | 'invalid_body_text'
  | 'persistence_error'
  | (string & {});

/**
 * Clasifica un fallo de envío.
 *
 * `httpStatus` solo es relevante para `http_error`; se ignora en el resto.
 * Un código desconocido se trata como `pending_reconciliation`: ante lo que no
 * entendemos, comprobar antes que reenviar.
 */
export function classifySendFailure(
  error: SendFailureCode,
  httpStatus?: number | null,
): RetryClass {
  // Entrada incompleta o no textual: no se clasifica a ciegas.
  if (typeof error !== 'string' || error.trim() === '') return 'manual_review';

  switch (error) {
    // Resultado desconocido: el mensaje pudo haber salido.
    case 'timeout':
    case 'network_error':
    case 'invalid_response':
      return 'pending_reconciliation';

    // Problemas de datos o de nuestro propio código: reintentar no ayuda.
    case 'invalid_phone':
    case 'invalid_text':
    case 'invalid_body_text':
      return 'permanent';

    // Fallo de nuestra base, no de Kapso: nada se envió.
    case 'persistence_error':
      return 'retryable';

    case 'http_error':
      return classifyHttpStatus(httpStatus);

    default:
      // Código que no conocemos: revisión manual, nunca reintento automático.
      return 'manual_review';
  }
}

/** Clasificación por status HTTP (solo para `http_error`). */
export function classifyHttpStatus(status?: number | null): RetryClass {
  // Sin status válido no hay nada que clasificar: no se adivina.
  if (typeof status !== 'number' || !Number.isInteger(status)) return 'manual_review';
  // 409: conflicto; el estado real del envío es incierto.
  if (status === 409) return 'pending_reconciliation';
  // 429: límite de tasa; reintentable, pero con espera y preferiblemente
  // comprobando antes si el envío llegó a producirse.
  if (status === 429) return 'retryable_after_reconciliation_or_backoff';
  if (status >= 500 && status <= 599) return 'retryable';
  if (status >= 400 && status <= 499) return 'permanent';
  // Un `http_error` con status fuera de 4xx/5xx es incoherente.
  return 'manual_review';
}

/** ¿Puede reenviarse sin comprobar antes si el mensaje ya existe? */
export function canRetryWithoutReconciliation(retryClass: RetryClass): boolean {
  return retryClass === 'retryable';
}

/** ¿Requiere intervención humana antes de cualquier acción automática? */
export function requiresManualReview(retryClass: RetryClass): boolean {
  return retryClass === 'manual_review';
}

// ── Presupuesto de tiempo por invocación ───────────────────────────────────

/** `maxDuration` declarado en las rutas de checkout y de reintento interno. */
export const CHECKOUT_ROUTE_MAX_DURATION_SECONDS = 60;

/**
 * Presupuesto por envío SOLO para las notificaciones del checkout. El resto de
 * flujos (webhook, CTA del menú) conserva el default de 10 s del transporte.
 */
export const NOTIFICATION_SEND_TIMEOUT_MS = 20_000;

/** Un delivery envía confirmación y, después, la solicitud de ubicación. */
export const MAX_NETWORK_SENDS_PER_DELIVERY_DISPATCH = 2;

/**
 * Margen reservado para Supabase (claims, marcas) y arranque de la función
 * dentro de la misma invocación.
 */
export const RESERVED_NON_NETWORK_MS = 10_000;

/**
 * El futuro worker debe procesar como máximo UNA notificación de red por
 * ejecución, o respetar un deadline interno: dos envíos de 20 s más Supabase
 * consumen casi todo el presupuesto de una invocación.
 */
export const MAX_NETWORK_SENDS_PER_WORKER_RUN = 1;

/** ¿Caben `sendCount` envíos de `timeoutMs` dentro del presupuesto? */
export function fitsInInvocationBudget(
  sendCount: number,
  timeoutMs: number,
  maxDurationSeconds: number = CHECKOUT_ROUTE_MAX_DURATION_SECONDS,
  reservedMs: number = RESERVED_NON_NETWORK_MS,
): boolean {
  return sendCount * timeoutMs + reservedMs <= maxDurationSeconds * 1000;
}
