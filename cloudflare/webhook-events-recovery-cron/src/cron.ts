/**
 * Núcleo del Cloudflare Cron de recuperación del inbox de webhooks (6D.2F.5C.1).
 *
 * Un ÚNICO despertador HTTP: hace UNA sola llamada `POST {}` al endpoint interno
 * de Vercel y registra un log saneado. NO conoce Supabase, Kapso, OpenAI,
 * teléfonos ni mensajes: el endpoint y la base resuelven qué recuperar. La
 * protección contra concurrencia vive en los claims atómicos de la base
 * (`FOR UPDATE SKIP LOCKED` y el lease), no aquí.
 *
 * ── Por qué es un Worker APARTE de notification-recovery-cron ───────────────
 *
 * Podrían compartir despertador, y no lo hacen a propósito. Un evento de este
 * inbox puede llevar un turno completo del agente —11–12 s medidos en
 * Production— así que encadenar los dos recoveries en la misma ventana de 55 s
 * significa que uno le come el presupuesto al otro, y que si la invocación se
 * pasa de tiempo fallan LOS DOS ese minuto. La durabilidad de los mensajes de
 * clientes no debe depender de la salud del worker de notificaciones.
 *
 * Garantías (las mismas que su hermano):
 *  - COMO MÁXIMO un POST por ejecución (sin bucles, sin retry, sin fallback);
 *  - timeout explícito (aborta la espera; el siguiente Cron recupera);
 *  - logs saneados (nunca token, Authorization, URL, ni datos de clientes);
 *  - configuración ausente ⇒ fallo local seguro y CERO POST.
 */

/**
 * Timeout de la llamada: ≤ `maxDuration = 60` del endpoint de Vercel, y por
 * encima de su presupuesto interno de reloj (42 s), para que el endpoint tenga
 * ocasión de cerrar por su cuenta y devolver recuentos en vez de que le
 * cortemos la respuesta.
 */
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
 * Ejecuta UN tick: una sola petición `POST {}` con Bearer y timeout, y traduce
 * el resultado a un log saneado. Nunca lanza hacia el caller. Nunca hace un
 * segundo POST: ante timeout, error o estado inesperado, la recuperación es el
 * siguiente Cron — dentro de un minuto, y con el trabajo intacto en la base.
 */
export async function runWebhookRecoveryTick(
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
    // ÚNICA petición de la ejecución. Cuerpo EXACTO `{}`: el caller no elige
    // qué se recupera, ni cuántos eventos, ni de quién.
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
    else log('cron_fetch_error', { duration_ms: durationMs });
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
    // Contrato REAL de este endpoint. Nada de campos de order_notifications:
    // un log que informa de algo que el endpoint no devuelve es peor que no
    // tener log, porque parece una medición.
    log('cron_completed', {
      status,
      duration_ms: durationMs,
      ok: body.ok === true,
      claimed: numOrNull(body.claimed),
      processed: numOrNull(body.processed),
      failed: numOrNull(body.failed),
      budget_exhausted: body.budget_exhausted === true,
    });
    return;
  }

  if (status === 401) {
    log('cron_unauthorized', { status, duration_ms: durationMs });
    return;
  }
  if (status === 405 || status === 422 || status === 400) {
    log('cron_contract_error', { status, duration_ms: durationMs });
    return;
  }
  if (status === 429) {
    log('cron_rate_limited', { status, duration_ms: durationMs });
    return;
  }
  if (status >= 500 && status <= 599) {
    // Incluye el 404 disfrazado de nada: si el endpoint todavía no está
    // desplegado, esto se ve en el log y no rompe nada.
    log('cron_upstream_error', { status, duration_ms: durationMs });
    return;
  }

  // Cualquier otro estado inesperado (404, 3xx…): contrato roto. Sin reintento;
  // el siguiente Cron Trigger es la recuperación natural.
  log('cron_contract_error', { status, duration_ms: durationMs });
}
