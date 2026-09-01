import { z } from 'zod';
import { getServerEnv } from '@/lib/env/env';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import { extractBearer, safeCompare } from '@/lib/security/auth';
import { log } from '@/lib/log';
import { runAlertOutboxTick } from '@/lib/alerts/outbox-runner';
import { createAlertRunnerDeps } from '@/lib/alerts/outbox-store';

// Requiere APIs de Node (service_role, POST a Telegram) — no Edge.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Cuatro alertas con timeout de 10 s cada una caben de sobra; el margen cubre
// el peor caso sin acercarse al techo.
export const maxDuration = 60;

/**
 * POST /api/internal/telegram-alerts/worker/tick
 *
 * Recovery del outbox de alertas: recoge lo que el fast path no consiguió
 * mandar. El caller NO decide qué alerta se manda — la elige la base con
 * `claim_due_telegram_alerts`. Si pudiera elegirla, este endpoint sería una
 * forma de mandar mensajes al grupo a voluntad con solo conocer un id.
 *
 * Mismo contrato que los otros dos workers internos: Bearer, cuerpo vacío
 * estricto y solo recuentos en la respuesta.
 */
const tickRequestSchema = z.strictObject({});

function json(status: number, body: unknown): Response {
  return Response.json(body, { status });
}

export async function POST(request: Request): Promise<Response> {
  if (request.method !== 'POST') return json(405, { error: 'method_not_allowed' });

  let internalToken: string | undefined;
  try {
    internalToken = getServerEnv().INTERNAL_API_TOKEN;
  } catch {
    log.error('alert_outbox_worker_env_unavailable');
    return json(500, { error: 'internal_error' });
  }

  // Sin token configurado se responde como con token inválido: nunca se abre.
  const provided = extractBearer(request.headers.get('authorization'));
  if (!internalToken || !safeCompare(provided, internalToken)) {
    return json(401, { error: 'unauthorized' });
  }

  const text = await request.text();
  let raw: unknown = {};
  if (text.trim() !== '') {
    try {
      raw = JSON.parse(text);
    } catch {
      return json(400, { error: 'invalid_json' });
    }
  }
  if (!tickRequestSchema.safeParse(raw).success) {
    return json(422, { error: 'validation_error' });
  }

  try {
    const result = await runAlertOutboxTick(createAlertRunnerDeps(getSupabaseAdmin()));
    // Solo recuentos: ni ids, ni teléfonos, ni el texto de ninguna alerta.
    log.info('alert_outbox_tick', { ...result });
    return json(200, result);
  } catch {
    log.error('alert_outbox_tick_failed');
    return json(500, { error: 'internal_error' });
  }
}
