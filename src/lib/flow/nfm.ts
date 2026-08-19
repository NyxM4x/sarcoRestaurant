import { z } from 'zod';
import { FLOW_TOKEN_RE } from './schema';

/**
 * Parseo y validación de la respuesta final del Flow (`nfm_reply`) — puro.
 *
 * El Flow solo envía datos de correlación confiables (IDEA.md §4): NO se confía
 * en precios, totales, resúmenes ni delivery_type que vengan aquí.
 */

/** Campos confiables que valida el nfm_reply. */
export const nfmReplySchema = z.object({
  order_draft_id: z.uuid(),
  flow_token: z.string().regex(FLOW_TOKEN_RE, 'flow_token con formato inválido'),
});

export type NfmReplyData = z.infer<typeof nfmReplySchema>;

// ── Helpers de acceso seguro sobre `unknown` ──────────────────────────────

function rec(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined;
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/** Contexto extraído del evento whatsapp.message.received. */
export interface MessageContext {
  message: Record<string, unknown> | undefined;
  messageId: string | null;
  messageType: string | null;
  interactiveType: string | null;
  from: string | null;
  conversationPhone: string | null;
  phoneNumberId: string | null;
}

/**
 * Extrae `message`, `conversation` y `phone_number_id` del sobre **canónico V2**
 * (todo en la raíz):
 *
 *     { "message": {}, "conversation": {}, "phone_number_id": "..." }
 *
 * No hay ningún fallback a `payload.data.*`, y eso sigue siendo correcto desde
 * que existen los lotes (5C.2): cada elemento de `data[]` es un sobre de ESTA
 * misma forma, así que quien recorre el lote llama aquí una vez por elemento.
 * El desdoblamiento vive en `webhook/envelopes.ts`, que es su único sitio.
 *
 * Nota: `context.phone_number` pertenece al contexto de los Workflows de Kapso y
 * NO existe como campo del webhook. En el webhook, `message.context` es el
 * contexto de respuesta y contiene típicamente `message.context.from` y
 * `message.context.id`.
 */
export function extractMessageContext(payload: unknown): MessageContext {
  const root = rec(payload) ?? {};
  const message = rec(root.message);
  const conversation = rec(root.conversation);
  const interactive = rec(message?.interactive);

  return {
    message,
    messageId: str(message?.id),
    messageType: str(message?.type),
    interactiveType: str(interactive?.type),
    from: str(message?.from),
    conversationPhone: str(conversation?.phone_number),
    phoneNumberId: str(root.phone_number_id),
  };
}

export type NfmParseResult =
  | { ok: true; source: 'kapso' | 'response_json'; data: NfmReplyData }
  | { ok: false; reason: 'not_nfm' | 'missing' | 'invalid_json' | 'invalid_shape' };

/**
 * Detecta y valida el `nfm_reply` de un mensaje.
 *
 * Fuente preferida: `message.kapso.flow_response`. Fallback:
 * `JSON.parse(message.interactive.nfm_reply.response_json)`.
 */
export function parseNfmReply(message: Record<string, unknown> | undefined): NfmParseResult {
  if (!message) return { ok: false, reason: 'not_nfm' };

  const interactive = rec(message.interactive);
  const isNfm = str(message.type) === 'interactive' && str(interactive?.type) === 'nfm_reply';
  if (!isNfm) return { ok: false, reason: 'not_nfm' };

  // 1. Fuente preferida: message.kapso.flow_response
  const kapso = rec(message.kapso);
  let raw: unknown;
  let source: 'kapso' | 'response_json';

  if (kapso && 'flow_response' in kapso && kapso.flow_response != null) {
    raw = kapso.flow_response;
    source = 'kapso';
  } else {
    // 2. Fallback: interactive.nfm_reply.response_json (string JSON)
    const nfm = rec(interactive?.nfm_reply);
    const responseJson = str(nfm?.response_json);
    if (responseJson == null) return { ok: false, reason: 'missing' };
    source = 'response_json';
    try {
      raw = JSON.parse(responseJson);
    } catch {
      return { ok: false, reason: 'invalid_json' };
    }
  }

  const parsed = nfmReplySchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: 'invalid_shape' };

  return { ok: true, source, data: parsed.data };
}
