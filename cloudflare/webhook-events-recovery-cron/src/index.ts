import {
  runWebhookRecoveryTick,
  TICK_TIMEOUT_MS,
  type CronBindings,
  type CronDeps,
} from './cron';

/**
 * Cloudflare Module Worker — despertador del recovery del inbox de webhooks
 * (Fase 6D.2F.5C.1).
 *
 * Un solo Worker, un solo Cron Trigger, un solo endpoint. `scheduled()` hace UNA
 * llamada `POST {}` al endpoint interno de Vercel. `fetch()` es un health check
 * inerte que NUNCA dispara el tick: no hay ruta pública que invoque producción.
 *
 * Es un despliegue INDEPENDIENTE de `notification-recovery-cron`. Ver `cron.ts`
 * para el porqué.
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
  /** Disparado por el Cron Trigger. Una sola llamada, sin datos de entrada. */
  async scheduled(
    _controller: ScheduledController,
    env: CronBindings,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(runWebhookRecoveryTick(env, defaultDeps()));
  },

  /**
   * Health check inerte. NO ejecuta el tick, no acepta parámetros, no expone
   * configuración ni secretos: solo confirma que el Worker está vivo.
   */
  async fetch(): Promise<Response> {
    return new Response(
      JSON.stringify({ service: 'webhook-events-recovery-cron', status: 'ok' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  },
};
