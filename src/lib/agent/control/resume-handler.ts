import { z } from 'zod';
import { extractBearer, safeCompare } from '@/lib/security/auth';
import { maskPhone, normalizePhone } from '@/lib/phone';
import { log } from '@/lib/log';
import type { ResumeAgentResult } from '@/lib/agent/core/types';

/**
 * Handler del resume interno de una conversación del agente — módulo PURO.
 *
 * Devolver el control al agente es una acción de OPERACIÓN, no de negocio, y por
 * eso reutiliza tal cual la seguridad ya existente para los endpoints internos
 * (`INTERNAL_API_TOKEN` por Bearer), igual que
 * `/api/internal/order-notifications/retry`. No hay superficie pública ni
 * escritura desde el frontend, y no se inventa ningún secreto nuevo.
 *
 * El request solo puede indicar A QUIÉN reanudar. Nunca el estado resultante,
 * ni el instante, ni el motivo, ni la fuente: todo eso lo decide el servidor.
 *
 * El teléfono jamás sale entero: ni en la respuesta ni en los logs.
 */

/** Único cuerpo aceptado. `strictObject` rechaza cualquier campo extra. */
export const resumeRequestSchema = z.strictObject({
  /** Teléfono del cliente. Se normaliza a dígitos antes de usarse. */
  customer_phone: z.string().min(1).max(32),
});

export interface AgentResumeDeps {
  /** Token interno configurado. Ausente o vacío = no configurado. */
  internalToken?: string | null;
  /** Resume real sobre el store; recibe el teléfono YA normalizado. */
  resume(customerPhone: string): Promise<ResumeAgentResult>;
}

/** Mismo dominio que `agent_conversations.customer_phone` en 0014. */
const PHONE_RE = /^[0-9]{8,15}$/;

function jsonResponse(status: number, body: unknown): Response {
  return Response.json(body, { status });
}

/**
 * `POST /api/internal/agent/resume`.
 *
 * Nunca devuelve el teléfono completo, ni el contenido de los mensajes, ni
 * mensajes técnicos de la base.
 */
export async function handleAgentResume(
  request: Request,
  deps: AgentResumeDeps,
): Promise<Response> {
  // 1. Autenticación. Sin token configurado se responde igual que con un token
  // inválido (401): no se revela el estado de configuración.
  const provided = extractBearer(request.headers.get('authorization'));
  if (!deps.internalToken || !safeCompare(provided, deps.internalToken)) {
    return jsonResponse(401, { error: 'unauthorized' });
  }

  // 2. Cuerpo JSON.
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return jsonResponse(400, { error: 'invalid_json' });
  }

  // 3. Contrato. No se reflejan los valores recibidos: podrían traer un token.
  const parsed = resumeRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return jsonResponse(422, { error: 'validation_error' });
  }

  const phone = normalizePhone(parsed.data.customer_phone);
  if (!PHONE_RE.test(phone)) {
    return jsonResponse(422, { error: 'validation_error' });
  }

  try {
    const result = await deps.resume(phone);
    return respond(phone, result);
  } catch {
    // Sin error.message: nada técnico sale ni al log ni a la respuesta.
    log.error('internal.agent.resume_failed', { phone: maskPhone(phone) });
    return jsonResponse(500, { error: 'internal_error' });
  }
}

/** Respuesta saneada: teléfono enmascarado y solo el desenlace de cada paso. */
function respond(phone: string, result: ResumeAgentResult): Response {
  if (result.result === 'rejected') {
    return jsonResponse(422, { error: 'validation_error' });
  }

  if (result.result === 'not_found') {
    const body = { ok: false, outcome: 'not_found' as const, conversation_id: null };
    log.info('internal.agent.resume', { ...body, phone: maskPhone(phone) });
    return jsonResponse(404, body);
  }

  const body = {
    ok: true,
    outcome: result.transition, // 'resumed' | 'already_active'
    conversation_id: result.conversationId,
    control_event: result.controlEvent, // 'inserted' | 'duplicate'
  };

  log.info('internal.agent.resume', { ...body, phone: maskPhone(phone) });
  return jsonResponse(200, body);
}
