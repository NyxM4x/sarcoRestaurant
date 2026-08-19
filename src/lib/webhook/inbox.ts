/**
 * Inbox durable de webhooks — módulo PURO (Fase 6D.2F.5C.1).
 *
 * Kapso exige ACK 200 en menos de 10 s y un turno del agente con herramienta
 * tarda 11–12 s. La respuesta deja de esperar al procesamiento: se acepta el
 * evento de forma durable, se responde, y el trabajo pesado ocurre después.
 *
 * Aquí vive solo la POLÍTICA: qué significa cada estado, cuánto dura un lease y
 * cuándo toca el siguiente intento. El acceso a datos se inyecta.
 *
 * ── after() NO es la durabilidad ────────────────────────────────────────────
 *
 * `after()` ejecuta tras enviar la respuesta y es el mecanismo de LATENCIA: sin
 * él, el trabajo esperaría al siguiente tick del worker y un chat no puede
 * tardar un minuto en contestar. Pero vive en la memoria de una invocación: si
 * el proceso muere, se lo lleva. La durabilidad es la FILA, y el recovery es
 * quien la recoge. Ninguno de los dos vale solo.
 */

/**
 * Estados de `webhook_events`. Los cuatro existen en el CHECK desde 0001; lo
 * que 5C.1 cambia es su uso.
 */
export type WebhookEventStatus = 'received' | 'processing' | 'processed' | 'failed';

/**
 * `received`   pendiente, o reintento ya agendado en `next_attempt_at`.
 * `processing` reclamado; el lease dice hasta cuándo se le da por vivo.
 * `processed`  terminal, con éxito.
 * `failed`     terminal, tras AGOTAR los intentos.
 *
 * Un fallo transitorio con intentos disponibles vuelve a `received`, NO a
 * `failed`: `failed` significa "ya no se intenta más".
 */
export const WEBHOOK_TERMINAL_STATUSES: readonly WebhookEventStatus[] = ['processed', 'failed'];

export function isTerminalWebhookStatus(status: WebhookEventStatus): boolean {
  return WEBHOOK_TERMINAL_STATUSES.includes(status);
}

/**
 * Cuánto vale un reclamo, en segundos.
 *
 * Por encima del `maxDuration` de la ruta (60 s) para que una invocación viva
 * nunca pierda su propio lease a mitad del trabajo, y lo bastante corto como
 * para que un crash no deje el mensaje del cliente parado mucho rato.
 */
export const WEBHOOK_LEASE_SECONDS = 90;

/**
 * Reintentos: cortos al principio porque esto es un chat.
 *
 * Un cliente que escribe y no recibe nada en dos segundos no está viendo un
 * sistema resiliente, está viendo un sistema roto. Los primeros reintentos van
 * pegados; los últimos se separan porque a esas alturas el fallo ya no es un
 * hipo de red.
 *
 * El tick del worker es de ~60 s, así que los dos primeros escalones solo se
 * aprovechan de verdad si la misma invocación o una reentrega de Kapso llegan
 * antes. No sobran por eso: cuando se aprovechan, se nota.
 */
export const WEBHOOK_RETRY_DELAYS_MS: readonly number[] = [
  2_000,
  10_000,
  30_000,
  120_000,
];

/** Tope de intentos. Coincide con el `max_attempts` por defecto de 0016. */
export const WEBHOOK_MAX_ATTEMPTS = 5;

/**
 * Cuándo toca el próximo intento, en ms desde ahora.
 *
 * `attempts` es el número de intentos YA gastados. Agotada la tabla se
 * mantiene el último escalón: no hay reintento infinito porque quien corta es
 * `max_attempts`, no este cálculo.
 */
export function retryDelayMs(attempts: number): number {
  const index = Math.max(0, attempts - 1);
  return (
    WEBHOOK_RETRY_DELAYS_MS[Math.min(index, WEBHOOK_RETRY_DELAYS_MS.length - 1)] ??
    WEBHOOK_RETRY_DELAYS_MS[WEBHOOK_RETRY_DELAYS_MS.length - 1]!
  );
}

/** ¿Quedan intentos? Con `attempts` ya gastados. */
export function hasAttemptsLeft(attempts: number, maxAttempts: number): boolean {
  return attempts < maxAttempts;
}

/**
 * Qué hacer con una fila que acaba de fallar.
 *
 * `retry` lleva el instante del próximo intento; `exhausted` no lleva ninguno,
 * porque un terminal no puede quedar agendado (lo impide un CHECK de 0016).
 */
export type FailureDisposition =
  | { kind: 'retry'; nextAttemptAt: string }
  | { kind: 'exhausted' };

/**
 * Qué hacer tras un fallo: reintentar o rendirse.
 *
 * La decisión es solo del contador, no del tipo de error. Distinguir "error
 * transitorio" de "error definitivo" desde aquí exigiría interpretar excepciones
 * de media docena de subsistemas, y equivocarse hacia el lado de no reintentar
 * pierde el mensaje de un cliente. Reintentar de más solo cuesta tiempo, y el
 * tope lo acota.
 */
export function dispositionAfterFailure(
  attempts: number,
  maxAttempts: number,
  nowMs: number,
): FailureDisposition {
  if (!hasAttemptsLeft(attempts, maxAttempts)) return { kind: 'exhausted' };
  return {
    kind: 'retry',
    nextAttemptAt: new Date(nowMs + retryDelayMs(attempts)).toISOString(),
  };
}
