import { getServerEnv } from '@/lib/env/env';
import { log } from '@/lib/log';
import { handleAgentResume } from '@/lib/agent/control/resume-handler';
import { resumeAgentConversationByPhone } from '@/lib/agent/service';

// Requiere APIs de Node (crypto, service_role) — no Edge. Siempre dinámico.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/internal/agent/resume
 *
 * Devuelve el control de una conversación al agente tras un takeover humano.
 * Protegido con el Bearer interno (`VERCEL_INTERNAL_TOKEN`), igual que el resto
 * de `/api/internal/*`. No hay superficie pública ni escritura desde el frontend.
 *
 * Es la ÚNICA vía legítima para pasar de `paused` a `active`: registra el
 * `agent_control_events` correspondiente, cosa que un UPDATE a mano en Supabase
 * no haría. No borra mensajes ni eventos de pausa anteriores.
 *
 * La ruta solo cablea dependencias; la lógica vive en
 * `@/lib/agent/control/resume-handler` y `@/lib/agent/control/resume`.
 */
export async function POST(request: Request): Promise<Response> {
  let internalToken: string | undefined;
  try {
    internalToken = getServerEnv().VERCEL_INTERNAL_TOKEN;
  } catch {
    // Entorno incompleto: nunca se detalla qué falta.
    log.error('internal.agent.env_unavailable');
    return Response.json({ error: 'internal_error' }, { status: 500 });
  }

  return handleAgentResume(request, {
    internalToken,
    resume: resumeAgentConversationByPhone,
  });
}
