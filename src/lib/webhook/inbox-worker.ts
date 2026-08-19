import { z } from 'zod';
import { extractBearer, safeCompare } from '@/lib/security/auth';
import { log } from '@/lib/log';
import { WEBHOOK_LEASE_SECONDS } from './inbox';
import { processClaimedEvent, type HandleKapsoWebhookParams } from './kapso';
import type { DueWebhookEventSelector } from './store';

/**
 * Worker de recuperación del inbox de webhooks (Fase 6D.2F.5C.1).
 *
 * `after()` es el fast path de latencia; ESTO es la garantía. Recoge lo que
 * `after()` no llegó a ejecutar y lo que murió a mitad, que es la mitad sin la
 * cual una fila durable no sirve de nada.
 *
 * Sigue el patrón operativo de `order-notifications/worker`, que lleva meses en
 * producción: presupuesto por tick, el caller no elige el trabajo, y Bearer
 * interno. No se inventa una forma nueva de hacer lo mismo.
 */

/** Cuerpo aceptado: vacío. `strictObject` rechaza cualquier campo. */
export const inboxTickRequestSchema = z.strictObject({});

/**
 * Eventos por tick.
 *
 * Tres, no cinco. Un evento puede llevar un turno completo del agente y en
 * Production eso son 11–12 s medidos: cinco no caben en el timeout de 55 s del
 * despertador de Cloudflare, y un tick que muere a mitad no recupera nada.
 *
 * No hace falta más caudal: el worker corre cada minuto y esto es el camino de
 * RECUPERACIÓN, no el normal. Lo que no entra sigue agendado y lo toma el
 * siguiente tick. Y no se paraleliza para compensar: varios turnos a la vez
 * contra el mismo teléfono es justo lo que la idempotencia no debería tener que
 * arbitrar.
 */
export const INBOX_TICK_BUDGET = 3;

/**
 * Presupuesto de reloj, por debajo del timeout del caller (55 s) y del
 * `maxDuration` de la ruta (60 s).
 *
 * El contador de eventos solo acota el caso típico; este acota el peor. Se
 * comprueba ANTES de reclamar cada fila, nunca después: reclamar y no procesar
 * gastaría un intento sin haberlo intentado.
 */
export const INBOX_TICK_WALL_CLOCK_MS = 42_000;

export interface InboxWorkerDeps {
  selector: DueWebhookEventSelector;
  /** Las mismas dependencias de negocio del webhook: una sola implementación. */
  processing: HandleKapsoWebhookParams;
  /** Token interno configurado. Ausente o vacío = no configurado. */
  internalToken?: string | null;
  /** Reloj inyectable, para probar el presupuesto sin esperar 42 segundos. */
  now?: () => number;
}

export interface InboxTickResult {
  ok: true;
  claimed: number;
  processed: number;
  failed: number;
  /** El tick paró por presupuesto, no por falta de trabajo. */
  budget_exhausted: boolean;
}

/**
 * Un tick. El trabajo lo elige la BASE (`claim_due_webhook_events`), nunca el
 * caller: no acepta id, evento, teléfono, wamid, estado ni timestamps.
 *
 * Reclama de UNA EN UNA, comprobando el presupuesto antes de cada reclamo. La
 * alternativa —pedir tres de golpe y procesar las que quepan— dejaría filas
 * reclamadas y sin intentar, gastándoles un intento y reteniéndolas bajo lease
 * hasta que venciera.
 *
 * Una fila que falle no tumba el tick: su desenlace ya lo gestiona
 * `processClaimedEvent` —reintento o terminal— y las demás siguen.
 */
export async function runInboxTick(deps: InboxWorkerDeps): Promise<InboxTickResult> {
  const now = deps.now ?? (() => Date.now());
  const startedAt = now();

  let claimed = 0;
  let processed = 0;
  let failed = 0;
  let budgetExhausted = false;

  for (let i = 0; i < INBOX_TICK_BUDGET; i += 1) {
    if (now() - startedAt >= INBOX_TICK_WALL_CLOCK_MS) {
      budgetExhausted = true;
      break;
    }

    const [row] = await deps.selector.claimDue(1, WEBHOOK_LEASE_SECONDS);
    if (!row) break; // No queda trabajo vencido.
    claimed += 1;

    try {
      const result = await processClaimedEvent(row, deps.processing);
      if (result.outcome === 'processed') processed += 1;
      else failed += 1;
    } catch {
      // `processClaimedEvent` no debería lanzar: ya captura y decide. Si algún
      // día lo hiciera, el lease vencido devuelve la fila al siguiente tick.
      failed += 1;
      log.error('webhook_inbox_row_failed');
    }
  }

  return { ok: true, claimed, processed, failed, budget_exhausted: budgetExhausted };
}

function jsonResponse(status: number, body: unknown): Response {
  return Response.json(body, { status });
}

/**
 * `POST /api/internal/webhook-events/worker/tick`.
 *
 * Códigos: 401 auth inválida · 405 método incorrecto · 400 JSON inválido ·
 * 422 cuerpo con campos no permitidos · 200 tick ejecutado · 500 solo si no
 * pudo seleccionar el trabajo inicial.
 */
export async function handleInboxTick(
  request: Request,
  deps: InboxWorkerDeps,
): Promise<Response> {
  if (request.method !== 'POST') {
    return jsonResponse(405, { error: 'method_not_allowed' });
  }

  // Sin token configurado se responde como con token inválido: nunca se abre.
  const provided = extractBearer(request.headers.get('authorization'));
  if (!deps.internalToken || !safeCompare(provided, deps.internalToken)) {
    return jsonResponse(401, { error: 'unauthorized' });
  }

  let raw: unknown = {};
  const text = await request.text();
  if (text.trim() !== '') {
    try {
      raw = JSON.parse(text);
    } catch {
      return jsonResponse(400, { error: 'invalid_json' });
    }
  }
  if (!inboxTickRequestSchema.safeParse(raw).success) {
    return jsonResponse(422, { error: 'validation_error' });
  }

  try {
    const result = await runInboxTick(deps);
    // Solo recuentos: ni ids, ni eventos, ni teléfonos, ni wamids.
    log.info('webhook_inbox_tick', { ...result });
    return jsonResponse(200, result);
  } catch {
    log.error('webhook_inbox_tick_failed');
    return jsonResponse(500, { error: 'internal_error' });
  }
}
