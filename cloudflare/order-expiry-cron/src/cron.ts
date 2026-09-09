/**
 * Núcleo del Cloudflare Cron del barrido de pedidos caducados (09-09-2026).
 *
 * Un ÚNICO despertador HTTP: hace UNA sola llamada `POST {}` al endpoint interno
 * de Vercel y registra un log saneado. NO conoce Supabase, Kapso, teléfonos ni
 * qué pedido se cancela: el endpoint y la base resuelven todo eso.
 *
 * ── Qué barre ───────────────────────────────────────────────────────────────
 *
 * El pedido en EFECTIVO que ya fue cotizado —el cliente vio su total y la
 * pregunta— y que nadie confirmó ni canceló en veinte minutos. Se cancela y se
 * le avisa al cliente por WhatsApp.
 *
 * ── Por qué este Worker existe ──────────────────────────────────────────────
 *
 * Porque el barrido estaba escrito, probado, y NUNCA se ejecutó en producción.
 * Vivía dentro de `GET /api/internal/cron/tick`, que es el fallback de los otros
 * tres Workers y lo despertaría un cron de Vercel — pero el plan de Vercel no
 * admite crons, y ninguno de los tres Workers apunta a esa ruta. Nadie la
 * llamaba.
 *
 * Se descubrió el 09-09-2026 mirando la base: once pedidos en efectivo sin
 * confirmar, el más antiguo de hacía TRES DÍAS. Once clientes que nunca
 * recibieron el aviso de que su pedido se canceló, cada uno con un pedido
 * fantasma tapándole el menú durante 24 horas.
 *
 * Nadie se enteró en tres días. Un despertador que no suena no produce ningún
 * error: ese es el modo de fallo que este Worker viene a cerrar, y es también
 * el que puede volver a abrirse si ESTE deja de sonar.
 *
 * ── Por qué es un Worker APARTE de los otros tres ───────────────────────────
 *
 * Por el mismo motivo por el que ellos son tres y no uno, y aquí con un filo
 * extra: el peor caso de este tick son veinticinco avisos por WhatsApp. Si Kapso
 * se pone lento, eso se come el presupuesto de la invocación entera.
 *
 * Colgarlo del Worker de alertas de Telegram —el más liviano, el candidato
 * obvio— pondría en riesgo el aviso al grupo de reparto. Y un aviso de reparto
 * que no sale es un repartidor que no sale.
 *
 * Nunca se arriesga el flujo de OPERACIONES —que la comida llegue— por un
 * proceso de LIMPIEZA. Cancelar pedidos fantasma puede esperar al minuto que
 * viene; una comanda pagada que nadie lleva, no.
 *
 * Garantías (las mismas que sus hermanos):
 *  - COMO MÁXIMO un POST por ejecución (sin bucles, sin retry, sin fallback);
 *  - timeout explícito (aborta la espera; el siguiente Cron recupera);
 *  - logs saneados (nunca token, Authorization, URL, ni datos de clientes);
 *  - configuración ausente ⇒ fallo local seguro y CERO POST.
 */

/**
 * Timeout de la llamada: <= `maxDuration = 60` del endpoint de Vercel, y por
 * encima de su peor caso real (veinticinco pedidos caducados, cada uno con su
 * UPDATE y su aviso por WhatsApp), para que el endpoint tenga ocasion de cerrar
 * por su cuenta y devolver recuentos en vez de que le cortemos la respuesta.
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
export async function runOrderExpiryTick(
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
    // Contrato REAL de este endpoint: `{ cancelled: number }` y nada mas. Nada
    // de campos de los otros workers — un log que informa de algo que el
    // endpoint no devuelve es peor que no tener log, porque parece una medicion.
    //
    // `cancelled: 0` es el caso NORMAL y no significa que algo fallara: la
    // mayoria de los minutos no hay ningun pedido caducado que cerrar. Lo que
    // seria una averia es que este log dejara de aparecer.
    log('cron_completed', {
      status,
      duration_ms: durationMs,
      cancelled: numOrNull(body.cancelled),
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
