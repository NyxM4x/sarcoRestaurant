/**
 * Núcleo del despertador ÚNICO de Sarco (14-09-2026).
 *
 * Cada minuto toca los CUATRO timbres de recuperación a la vez —un `POST {}`
 * por endpoint, en paralelo— y deja un log saneado por cada uno. NO conoce
 * Supabase, Kapso, Telegram, teléfonos ni pedidos: cada endpoint y la base
 * resuelven qué recuperar, con sus claims atómicos y sus leases.
 *
 * ── Por qué uno y no cuatro ─────────────────────────────────────────────────
 *
 * Hasta el 14-09-2026 eran cuatro Workers, uno por endpoint. El plan Free de
 * Cloudflare admite CINCO Cron Triggers por CUENTA, y la cuenta es compartida
 * con otro restaurante que ya usa tres. Dos de los cuatro de Sarco nunca
 * tuvieron cron —primero porque nadie los desplegó, después porque no cabían—,
 * y el 13-09 una clienta pagó por QR, la foto de su comprobante quedó trabada a
 * mitad de proceso y nadie la retomó.
 *
 * Con un solo Worker, Sarco ocupa un lugar y no cuatro, y el fallo con el que
 * empezó todo —dos despliegues de cuatro olvidados— deja de ser posible: o está
 * el despertador o no está.
 *
 * ── Por qué en PARALELO, y por qué eso conserva lo que protegían los cuatro ──
 *
 * Eran despliegues separados para que una recuperación lenta no le comiera el
 * tiempo a otra: un evento del inbox puede llevar un turno completo del agente
 * (11–12 s medidos), y el barrido de caducados puede mandar 25 WhatsApp
 * seguidos. Eso sigue igual. Cada endpoint es su propia invocación en Vercel
 * con sus 60 s, y aquí cada uno espera con su propio AbortController. Lo único
 * que se comparte es quién toca el timbre.
 *
 * Encadenarlos —un `await` detrás de otro— sí rompería esa garantía. Lanzarlos
 * juntos, no.
 *
 * ── Límites del plan Free que esto respeta ──────────────────────────────────
 *
 *  - 10 ms de CPU por invocación. Esperar la red NO cuenta; lo que cuenta es
 *    armar cuatro peticiones, leer cuatro JSON pequeños y escribir cinco logs.
 *  - 6 conexiones simultáneas por invocación: cuatro caben. Por encima de seis,
 *    una recuperación esperaría a que termine otra, y volvería el problema de
 *    los tiempos compartidos. Lo vigila una prueba.
 *  - 50 subpeticiones por invocación: se usan cuatro.
 *
 * Garantías (las mismas que tenían los cuatro por separado):
 *  - COMO MÁXIMO un POST por endpoint y por ejecución (sin bucles, sin retry);
 *  - timeout explícito por endpoint (aborta la espera; el siguiente Cron recupera);
 *  - un endpoint que falla o se cuelga no impide que los otros terminen;
 *  - logs saneados (nunca token, Authorization, URL, ni datos de clientes);
 *  - configuración ausente o inválida ⇒ fallo local seguro y CERO POST.
 */

/**
 * Timeout de CADA llamada: ≤ `maxDuration = 60` de los endpoints de Vercel, y
 * por encima del peor caso real del más lento (el inbox, con su presupuesto
 * interno de reloj de 42 s), para que cada endpoint tenga ocasión de cerrar por
 * su cuenta y devolver recuentos en vez de que le cortemos la respuesta.
 */
export const TICK_TIMEOUT_MS = 55_000;

/** Conexiones simultáneas que Cloudflare permite por invocación. */
export const MAX_CONEXIONES_SIMULTANEAS = 6;

/** Variables/secretos inyectados por Cloudflare (Wrangler vars + secret). */
export interface CronBindings {
  /** Origen de la app en Vercel, SIN ruta (variable, no secreto). */
  APP_BASE_URL?: string;
  /** Token interno. SOLO como Cloudflare secret; jamás en código/config/logs. */
  WORKER_INTERNAL_TOKEN?: string;
}

/** Respuesta mínima que el núcleo necesita del `fetch`. */
export interface CronResponse {
  readonly status: number;
  json(): Promise<unknown>;
}

/** Init exacto de cada petición (forma fija, sin datos dinámicos). */
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

/** Una recuperación: a qué endpoint se llama y qué se registra de su respuesta. */
export interface Recovery {
  /** Nombre que acompaña cada log de esta recuperación. */
  readonly name: string;
  /** Ruta del endpoint interno, relativa a `APP_BASE_URL`. */
  readonly path: string;
  /**
   * Recuentos de una respuesta 200, según el contrato REAL de ESE endpoint.
   * Nada de campos de los otros: un log que informa de algo que el endpoint no
   * devuelve es peor que no tener log, porque parece una medición.
   */
  readonly summarize: (body: Record<string, unknown>) => Record<string, unknown>;
}

/**
 * Las cuatro recuperaciones. Una prueba contrasta esta lista con las rutas
 * `worker/tick` que existen en la app, en los dos sentidos: que cada ruta
 * exista, y que ninguna ruta se quede sin despertador.
 */
export const RECOVERIES: readonly Recovery[] = [
  {
    // Mensajes de WhatsApp que se cortaron a mitad: texto, ubicación, foto del
    // comprobante. Si no corre, el mensaje se pierde en silencio.
    name: 'webhook_events',
    path: '/api/internal/webhook-events/worker/tick',
    summarize: (body) => ({
      ok: body.ok === true,
      claimed: numOrNull(body.claimed),
      processed: numOrNull(body.processed),
      failed: numOrNull(body.failed),
      budget_exhausted: body.budget_exhausted === true,
    }),
  },
  {
    // Avisos al cliente que no salieron ("recibimos tu pedido"…) y las alertas
    // técnicas. Solo recuentos: NUNCA el contenido de `results`.
    name: 'order_notifications',
    path: '/api/internal/order-notifications/worker/tick',
    summarize: (body) => ({
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
    }),
  },
  {
    // Avisos al grupo de reparto y de handoff que Telegram no aceptó a la
    // primera. `failed` NO es un error del tick: son alertas que agotaron sus
    // intentos y quedan en el panel para que una persona avise a mano.
    name: 'telegram_alerts',
    path: '/api/internal/telegram-alerts/worker/tick',
    summarize: (body) => ({
      ok: body.ok === true,
      claimed: numOrNull(body.claimed),
      sent: numOrNull(body.sent),
      rescheduled: numOrNull(body.rescheduled),
      failed: numOrNull(body.failed),
    }),
  },
  {
    // Pedidos caducados: efectivo sin confirmar (20 min), carrito sin ubicación
    // (45 min) y QR sin comprobante (2 h). `cancelled: 0` es el caso NORMAL.
    name: 'order_expiry',
    path: '/api/internal/orders/expiry/worker/tick',
    summarize: (body) => ({
      cancelled: numOrNull(body.cancelled),
      cash_unconfirmed: numOrNull(body.cash_unconfirmed),
      abandoned_carts: numOrNull(body.abandoned_carts),
      unpaid_orders: numOrNull(body.unpaid_orders),
    }),
  },
];

/** Cómo terminó UNA recuperación en este minuto. Es el sufijo de su log. */
export type RecoveryOutcome =
  | 'completed'
  | 'invalid_response'
  | 'unauthorized'
  | 'contract_error'
  | 'rate_limited'
  | 'upstream_error'
  | 'timeout'
  | 'fetch_error'
  | 'crashed';

/**
 * Origen validado de `APP_BASE_URL`, o el motivo por el que no sirve.
 *
 * Solo un ORIGEN: si alguien pega aquí la URL completa de un tick —el error
 * natural al migrar desde los Workers viejos, que tenían `WORKER_TICK_URL`—,
 * las rutas se duplicarían y los cuatro POST darían 404. Mejor no llamar a
 * nadie y decirlo. Y `https` salvo en local: el Bearer no viaja en claro.
 */
export function resolveOrigin(
  raw: string | undefined,
): { origin: string } | { reason: 'missing_url' | 'invalid_url' } {
  const text = (raw ?? '').trim();
  if (text === '') return { reason: 'missing_url' };

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { reason: 'invalid_url' };
  }

  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  const protocolOk = url.protocol === 'https:' || (local && url.protocol === 'http:');
  const soloOrigen =
    (url.pathname === '/' || url.pathname === '') &&
    url.search === '' &&
    url.hash === '' &&
    url.username === '' &&
    url.password === '';

  if (!protocolOk || !soloOrigen) return { reason: 'invalid_url' };
  return { origin: url.origin };
}

/**
 * Toca UN timbre: una sola petición `POST {}` con Bearer y timeout propio, y
 * traduce el resultado a un log saneado. Nunca lanza. Nunca hace un segundo
 * POST: ante timeout, error o estado inesperado, la recuperación es el Cron del
 * minuto siguiente, con el trabajo intacto en la base.
 */
async function tickOne(
  recovery: Recovery,
  origin: string,
  token: string,
  deps: CronDeps,
): Promise<RecoveryOutcome> {
  const { log, now } = deps;
  const startedAt = now();

  const report = (
    outcome: RecoveryOutcome,
    fields: Record<string, unknown> = {},
  ): RecoveryOutcome => {
    log(`cron_${outcome}`, {
      recovery: recovery.name,
      duration_ms: now() - startedAt,
      ...fields,
    });
    return outcome;
  };

  const setTimer = deps.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
  const clearTimer =
    deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  // Controlador PROPIO: que el inbox se alargue no puede abortar a los demás.
  const controller = new AbortController();
  const timer = setTimer(() => controller.abort(), deps.timeoutMs);

  try {
    let res: CronResponse;
    try {
      // ÚNICA petición a este endpoint en esta ejecución. Cuerpo EXACTO `{}`:
      // el caller no elige qué se recupera, ni cuántos eventos, ni de quién.
      res = await deps.fetch(`${origin}${recovery.path}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: '{}',
        signal: controller.signal,
      });
    } catch {
      // Abortado por nuestro timeout vs. fallo de red genuino.
      return report(controller.signal.aborted ? 'timeout' : 'fetch_error');
    }

    const status = res.status;

    if (status === 200) {
      let body: unknown;
      try {
        // El temporizador sigue armado mientras se lee el cuerpo: una
        // respuesta que manda cabeceras y se cuelga también es un timeout.
        body = await res.json();
      } catch {
        return report(controller.signal.aborted ? 'timeout' : 'invalid_response', { status });
      }
      if (!isRecord(body)) return report('invalid_response', { status });
      return report('completed', { status, ...recovery.summarize(body) });
    }

    if (status === 401) return report('unauthorized', { status });
    if (status === 429) return report('rate_limited', { status });
    if (status >= 500 && status <= 599) return report('upstream_error', { status });

    // 400/405/422 son contrato roto por definición, y cualquier otro estado
    // inesperado (404, 3xx…) también: un 404 aquí es una ruta mal escrita o un
    // endpoint que no está desplegado.
    return report('contract_error', { status });
  } finally {
    clearTimer(timer);
  }
}

/**
 * Ejecuta UN minuto: valida la configuración una vez y toca los cuatro timbres
 * a la vez. Nunca lanza hacia el caller — un Cron que revienta no vuelve solo.
 *
 * Termina con `cron_finished`, que resume en UNA línea cómo le fue a cada uno:
 * es lo que hay que mirar para saber si Sarco está cubierto este minuto.
 */
export async function runRecoveryTick(env: CronBindings, deps: CronDeps): Promise<void> {
  const { log, now } = deps;
  const startedAt = now();
  log('cron_started');

  // Configuración ausente o inválida ⇒ fallo local seguro, CERO POST.
  const resolved = resolveOrigin(env.APP_BASE_URL);
  if ('reason' in resolved) {
    log('cron_contract_error', { reason: resolved.reason });
    return;
  }
  const token = (env.WORKER_INTERNAL_TOKEN ?? '').trim();
  if (token === '') {
    log('cron_contract_error', { reason: 'missing_token' });
    return;
  }

  // Los cuatro se lanzan en la MISMA vuelta del bucle: ninguno espera a otro.
  // `allSettled` y no `all`: `tickOne` no lanza, pero si algún día lo hiciera,
  // una recuperación rota no puede llevarse por delante el resumen de las demás.
  const settled = await Promise.allSettled(
    RECOVERIES.map((recovery) => tickOne(recovery, resolved.origin, token, deps)),
  );

  const outcomes: Record<string, RecoveryOutcome> = {};
  RECOVERIES.forEach((recovery, i) => {
    const result = settled[i];
    outcomes[recovery.name] = result.status === 'fulfilled' ? result.value : 'crashed';
  });

  const completed = Object.values(outcomes).filter((o) => o === 'completed').length;
  log('cron_finished', {
    duration_ms: now() - startedAt,
    all_completed: completed === RECOVERIES.length,
    completed,
    total: RECOVERIES.length,
    outcomes,
  });
}
