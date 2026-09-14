import { runRecoveryTick, TICK_TIMEOUT_MS, type CronBindings, type CronDeps } from './cron';

/**
 * Cloudflare Module Worker — el despertador único de Sarco (14-09-2026).
 *
 * Un solo Worker, un solo Cron Trigger, cuatro endpoints. `scheduled()` toca
 * los cuatro timbres a la vez. `fetch()` es un health check inerte que NUNCA
 * dispara nada: no hay ruta pública que invoque producción.
 *
 * Ver `cron.ts` para el porqué de uno solo y en paralelo.
 */

/** Claves que jamás deben aparecer en un log, por si se cuelan en `fields`. */
const SENSITIVE_KEYS = new Set([
  'authorization',
  'token',
  'url',
  'payload',
  'phone',
  'customer_phone',
  'wamid',
  'message_id',
  'event_id',
  'idempotency_key',
  'signature',
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
  /** Disparado por el Cron Trigger. Cuatro llamadas en paralelo, sin datos de entrada. */
  async scheduled(
    _controller: ScheduledController,
    env: CronBindings,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(runRecoveryTick(env, defaultDeps()));
  },

  /**
   * Health check inerte. NO ejecuta ningún tick, no acepta parámetros, no expone
   * configuración ni secretos: solo confirma que el Worker está vivo.
   */
  async fetch(): Promise<Response> {
    return new Response(JSON.stringify({ service: 'sarco-recovery-cron', status: 'ok' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  },
};
