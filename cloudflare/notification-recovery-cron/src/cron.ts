/**
 * Núcleo del Cloudflare Cron de recuperación de notificaciones (Fase 5.2D.5E.1).
 *
 * Un ÚNICO despertador HTTP, COMPARTIDO por todos los restaurantes: hace UNA sola
 * llamada `POST {}` al endpoint interno de Vercel y registra un log saneado con el
 * resultado. NO conoce Supabase, Kapso, pedidos, teléfonos ni restaurantes: el
 * endpoint y la base resuelven el tenant y seleccionan el trabajo. La protección
 * contra concurrencia vive en los claims atómicos de la base, no aquí.
 *
 * Garantías:
 *  - COMO MÁXIMO un POST por ejecución (sin bucles, sin retry, sin fallback);
 *  - timeout explícito (aborta la espera; el siguiente Cron recupera);
 *  - logs saneados (nunca token, Authorization, URL, ni datos de pedidos);
 *  - configuración ausente ⇒ fallo local seguro y CERO POST.
 */

/** Timeout de la llamada: ≤ maxDuration=60 del endpoint de Vercel. */
export const TICK_TIMEOUT_MS = 55_000;

/** Variables/secretos inyectados por Cloudflare (Wrangler vars + secret). */
export interface CronBindings {
  /** URL del endpoint interno del worker (variable, no secreto). */
  WORKER_TICK_URL?: string;
  /** Token interno. SOLO como Cloudflare secret; jamás en código/config/logs. */
  WORKER_INTERNAL_TOKEN?: string;
}

/** Respuesta mínima que el núcleo necesita del `fetch`. */
export interface CronResponse {
  readonly status: number;
  json(): Promise<unknown>;
}

/** Init exacto de la única petición (forma fija, sin datos dinámicos). */
export interface CronFetchInit {
  method: 'POST';
  headers: Record<string, string>;
  body: '{}';
  signal: AbortSignal;
}

export type CronFetchFn = (url: string, init: CronFetchInit) => Promise<CronResponse>;

/** Logger saneado: solo recibe recuentos/estado, nunca secretos ni datos. */
export type CronLogFn = (event: string, fields?: Record<string, unknown>) => void;

type TimerHandle = unknown;

/** Dependencias inyectables (para pruebas sin red ni relojes reales). */
export interface CronDeps {
  fetch: CronFetchFn;
  now: () => number;
  log: CronLogFn;
  timeoutMs: number;
  /** Por defecto `setTimeout`/`clearTimeout` globales. */
  setTimer?: (cb: () => void, ms: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Ejecuta UN tick: una sola petición `POST {}` con Bearer y timeout, y traduce el
 * resultado a un log saneado. Nunca lanza hacia el caller. Nunca hace un segundo
 * POST: ante timeout/error/estado inesperado, el siguiente Cron es la recuperación.
 */
export async function runNotificationRecoveryTick(
  env: CronBindings,
  deps: CronDeps,
): Promise<void> {
  const { log, now } = deps;
  const startedAt = now();
  log('cron_started');

  // Configuración ausente ⇒ fallo local seguro, CERO POST.
  const url = (env.WORKER_TICK_URL ?? '').trim();
  const token = (env.WORKER_INTERNAL_TOKEN ?? '').trim();
  if (url === '') {
    log('cron_contract_error', { reason: 'missing_url' });
    return;
  }
  if (token === '') {
    log('cron_contract_error', { reason: 'missing_token' });
    return;
  }

  const setTimer = deps.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
  const clearTimer =
    deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  const controller = new AbortController();
  const timer = setTimer(() => controller.abort(), deps.timeoutMs);

  let res: CronResponse;
  try {
    // ÚNICA petición de la ejecución. Cuerpo EXACTO `{}`: sin order_id,
    // restaurant_id, notification_type, límites, timestamps ni datos de pedidos.
    res = await deps.fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
      signal: controller.signal,
    });
  } catch {
    clearTimer(timer);
    const durationMs = now() - startedAt;
    // Abortado por nuestro timeout vs. fallo de red genuino.
    if (controller.signal.aborted) log('cron_timeout', { duration_ms: durationMs });
    else log('cron_network_error', { duration_ms: durationMs });
    return;
  }
  clearTimer(timer);

  const durationMs = now() - startedAt;
  const status = res.status;

  if (status === 200) {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      log('cron_invalid_response', { status, duration_ms: durationMs });
      return;
    }
    if (!isRecord(body)) {
      log('cron_invalid_response', { status, duration_ms: durationMs });
      return;
    }
    // Solo recuentos/estado; NUNCA el contenido de `results` ni de las alertas.
    log('cron_completed', {
      status,
      duration_ms: durationMs,
      ok: body.ok === true,
      selected: numOrNull(body.selected),
      processed: numOrNull(body.processed),
      history_reads: numOrNull(body.history_reads),
      network_send_attempts: numOrNull(body.network_send_attempts),
      budget_exhausted: body.budget_exhausted === true,
      results_count: Array.isArray(body.results) ? body.results.length : 0,
      alerts_selected: numOrNull(body.alerts_selected),
      alert_send_attempts: numOrNull(body.alert_send_attempts),
      alerts_sent: numOrNull(body.alerts_sent),
      alerts_rescheduled: numOrNull(body.alerts_rescheduled),
    });
    return;
  }

  if (status === 401) {
    log('cron_unauthorized', { status, duration_ms: durationMs });
    return;
  }
  if (status === 405 || status === 422) {
    log('cron_contract_error', { status, duration_ms: durationMs });
    return;
  }
  if (status === 429) {
    log('cron_rate_limited', { status, duration_ms: durationMs });
    return;
  }
  if (status >= 500 && status <= 599) {
    log('cron_upstream_error', { status, duration_ms: durationMs });
    return;
  }

  // Cualquier otro estado inesperado (p. ej. 400/404/3xx): contrato roto. Sin
  // reintento: el siguiente Cron Trigger es la recuperación natural.
  log('cron_contract_error', { status, duration_ms: durationMs });
}
