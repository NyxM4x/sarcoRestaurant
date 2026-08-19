import {
  runNotificationRecoveryTick,
  TICK_TIMEOUT_MS,
  type CronBindings,
  type CronDeps,
} from './cron';

/**
 * Cloudflare Module Worker — despertador COMPARTIDO del worker interno de
 * recuperación de notificaciones (Fase 5.2D.5E.1).
 *
 * Un solo Worker, un solo Cron Trigger, un solo endpoint. `scheduled()` hace UNA
 * llamada `POST {}` al endpoint interno de Vercel. `fetch()` es un health check
 * inerte que NUNCA dispara el tick. No hay ruta pública que invoque producción.
 */

/** Claves que jamás deben aparecer en un log, por si se cuelan en `fields`. */
const SENSITIVE_KEYS = new Set([
  'authorization',
  'token',
  'url',
  'order_id',
  'order_number',
  'phone',
  'wamid',
  'claim_token',
  'results',
]);

/** Emite un log estructurado saneado: elimina cualquier clave sensible. */
function emit(event: string, fields: Record<string, unknown> = {}): void {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!SENSITIVE_KEYS.has(key.toLowerCase())) safe[key] = value;
  }
  console.log(JSON.stringify({ event, ...safe }));
}

/** Dependencias reales del runtime de Cloudflare. */
function defaultDeps(): CronDeps {
  return {
    fetch: (url, init) => fetch(url, init),
    now: () => Date.now(),
    log: emit,
    timeoutMs: TICK_TIMEOUT_MS,
  };
}

/** Firma mínima del Cron de Cloudflare (evita depender de workers-types). */
interface ScheduledController {
  readonly scheduledTime: number;
  readonly cron: string;
}
interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

export default {
  /** Disparado por el Cron Trigger. Una sola llamada, sin datos de entrada. */
  async scheduled(
    _controller: ScheduledController,
    env: CronBindings,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(runNotificationRecoveryTick(env, defaultDeps()));
  },

  /**
   * Health check inerte. NO ejecuta el tick, no acepta parámetros, no expone
   * configuración ni secretos: solo confirma que el Worker está vivo.
   */
  async fetch(): Promise<Response> {
    return new Response(
      JSON.stringify({ service: 'notification-recovery-cron', status: 'ok' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  },
};
