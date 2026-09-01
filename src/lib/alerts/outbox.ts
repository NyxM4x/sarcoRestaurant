/**
 * Outbox de alertas de Telegram — módulo PURO.
 *
 * Decide qué pasa con una alerta después de intentar mandarla: si se cierra, si
 * vuelve a la cola y cuándo, o si se rinde. No hace E/S y no conoce Supabase.
 *
 * ── Lo que había antes ──────────────────────────────────────────────────────
 *
 * Dos avisos salían por Telegram y ninguno era durable.
 *
 * El del grupo de reparto escribía `orders.delivery_notice_sent_at` ANTES de
 * llamar a Telegram. Si Telegram fallaba después, el pedido quedaba marcado
 * como avisado para siempre: nadie salía a repartirlo, no se reintentaba, no
 * aparecía en el panel y lo único que quedaba era un `log.warn`. La columna
 * decía "enviado" y significaba "reclamado", y esa mentira es justo la que
 * impide darse cuenta mirando la base.
 *
 * El del handoff no tenía ni columna: el agente se pausaba dos horas, el
 * cliente quedaba esperando a una persona, y si Telegram fallaba nadie se
 * enteraba nunca.
 *
 * ── Reintentar sin duplicar ─────────────────────────────────────────────────
 *
 * Sigue siendo cierto lo que decía el código anterior: para el grupo de
 * reparto, un aviso duplicado es PEOR que uno ausente, porque dos personas
 * pueden salir a llevar el mismo pedido. Lo que cambia es dónde vive esa
 * protección.
 *
 * Antes era el orden de dos escrituras —marcar y luego mandar—, y por eso
 * reintentar era peligroso. Ahora es el índice único `(kind, target_ref)` de la
 * migración 0028: solo puede existir UNA alerta por destino, así que encolar
 * dos veces no crea dos avisos y reintentar el ENVÍO no arriesga un segundo.
 *
 * ── El transporte ya sabía distinguir, y se le ignoraba ─────────────────────
 *
 * `createTelegramAlertSender` devuelve `transient`, `rate_limited`, `permanent`
 * e `invalid` desde siempre. Los dos servicios miraban solo si era `sent` y
 * tiraban el resto. Aquí esa información por fin decide algo.
 */

/** Qué clase de aviso es. Decide el texto y a qué chat va. */
export const TELEGRAM_ALERT_KINDS = ['delivery_notice', 'handoff_notice'] as const;
export type TelegramAlertKind = (typeof TELEGRAM_ALERT_KINDS)[number];

export const TELEGRAM_ALERT_STATUSES = ['pending', 'sending', 'sent', 'failed'] as const;
export type TelegramAlertStatus = (typeof TELEGRAM_ALERT_STATUSES)[number];

/** Fila ya reclamada, con lo justo para intentar mandarla. */
export interface TelegramAlertRow {
  id: string;
  kind: TelegramAlertKind;
  targetRef: string;
  body: string;
  /** Intentos YA gastados, incluido el que acaba de reclamarse. */
  attempts: number;
  maxAttempts: number;
}

/**
 * Desenlace del transporte, tal como lo devuelve `createTelegramAlertSender`.
 * Se declara aquí en su forma mínima para no arrastrar el módulo de red a un
 * archivo puro.
 */
export type AlertSendOutcome =
  | { kind: 'sent' }
  | { kind: 'permanent'; code: string }
  | { kind: 'rate_limited'; retryAfterSeconds?: number }
  | { kind: 'transient'; code: string }
  | { kind: 'invalid' };

/**
 * Backoff entre intentos, en segundos: 30 s, 2 min, 8 min, 30 min.
 *
 * Crece rápido a propósito. Un aviso de reparto que no salió en dos minutos ya
 * no llega "a tiempo" en ningún sentido útil, y a partir de ahí lo que importa
 * es que acabe saliendo sin castigar a una API que probablemente esté caída.
 */
export const ALERT_BACKOFF_SECONDS = [30, 120, 480, 1800] as const;

/**
 * Techo del `retry_after` que se acepta de Telegram.
 *
 * Un 429 con una espera enorme dejaría la fila agendada más allá de cualquier
 * ventana útil. Se respeta lo que pide el proveedor hasta este límite, y a
 * partir de ahí manda nuestro backoff: es preferible un reintento de más a un
 * aviso que reaparece mañana.
 */
export const MAX_RETRY_AFTER_SECONDS = 900;

export type AlertDisposition =
  /** Salió. Terminal. */
  | { kind: 'sent' }
  /** Vuelve a la cola con su próxima cita. */
  | { kind: 'retry'; delaySeconds: number; error: string }
  /** Terminal sin haber salido: se rinde y queda visible para una persona. */
  | { kind: 'failed'; error: string };

/** Espera correspondiente al número de intentos ya gastados. */
export function backoffSecondsFor(attempts: number): number {
  const i = Math.max(0, attempts - 1);
  return ALERT_BACKOFF_SECONDS[Math.min(i, ALERT_BACKOFF_SECONDS.length - 1)];
}

/**
 * Qué hacer con la alerta después de intentar mandarla.
 *
 * ── `permanent` e `invalid` NO se reintentan ────────────────────────────────
 *
 * Un chat que no existe o un token mal puesto no se arreglan esperando: cinco
 * intentos producirían cinco fallos idénticos y retrasarían media hora el
 * momento en que alguien ve el problema en el panel. Se marca `failed` a la
 * primera, que es la forma más rápida de que una persona lo descubra.
 */
export function dispositionForOutcome(
  outcome: AlertSendOutcome,
  attempts: number,
  maxAttempts: number,
): AlertDisposition {
  if (outcome.kind === 'sent') return { kind: 'sent' };

  if (outcome.kind === 'permanent') {
    return { kind: 'failed', error: `permanent:${outcome.code}` };
  }
  if (outcome.kind === 'invalid') {
    // La respuesta no se pudo interpretar. NO se reintenta a ciegas: el mensaje
    // pudo haber salido, y en el grupo de reparto un duplicado es peor que una
    // ausencia. Queda `failed` y visible, que es lo que permite comprobarlo.
    return { kind: 'failed', error: 'invalid_response' };
  }

  // Transitorio o límite de tasa: reintentable mientras queden intentos.
  const error = outcome.kind === 'rate_limited' ? 'rate_limited' : `transient:${outcome.code}`;
  if (attempts >= maxAttempts) return { kind: 'failed', error: `exhausted:${error}` };

  const pedido =
    outcome.kind === 'rate_limited' && typeof outcome.retryAfterSeconds === 'number'
      ? Math.min(Math.max(Math.floor(outcome.retryAfterSeconds), 1), MAX_RETRY_AFTER_SECONDS)
      : 0;

  return { kind: 'retry', delaySeconds: Math.max(pedido, backoffSecondsFor(attempts)), error };
}

/** Instante de la próxima cita, en ISO. */
export function nextAttemptAt(nowMs: number, delaySeconds: number): string {
  return new Date(nowMs + delaySeconds * 1000).toISOString();
}
