/**
 * Frontera entre el TRANSPORTE de Kapso y el negocio (Fase 6D.2F.5C.2).
 *
 * Kapso entrega de dos formas: un webhook individual, o —con buffering
 * activado— un lote. Este módulo convierte las dos en la MISMA cosa: una lista
 * de sobres individuales. A partir de aquí el resto del sistema no sabe ni
 * necesita saber por cuál de las dos llegó el mensaje.
 *
 *   individual  → [ sobre ]
 *   lote        → data[0], data[1], ... en el ORDEN RECIBIDO
 *
 * ── Por qué el orden es la posición y no el timestamp ───────────────────────
 *
 * Porque el timestamp de WhatsApp viene en SEGUNDOS, y el buffering existe
 * justamente para agrupar mensajes escritos en la misma ráfaga: tres mensajes
 * dentro de una ventana de cinco segundos comparten segundo con muchísima
 * frecuencia. Ordenar por timestamp dejaría indeterminado precisamente el caso
 * para el que se activa el lote, y un empate resuelto al azar ancla el turno en
 * "hola" en vez de en la pregunta.
 *
 * Kapso garantiza el orden por conversación dentro de `data[]`. Ese orden ES el
 * dato. No se reordena, no se ordena por reloj y no se inventa una secuencia por
 * elemento que la documentación no expone. Cada sobre conserva su `index`
 * original para que el orden siga siendo afirmable después de clasificar.
 *
 * ── Por qué un lote malformado no cae a individual ──────────────────────────
 *
 * Un `batch: true` con `data` roto es una entrega que no entendemos. Tratarla
 * como si fuera un mensaje individual sería inventar un mensaje a partir del
 * sobre exterior — que ni siquiera tiene `message`. Fail closed: se rechaza con
 * 422 para que la entrega falle VISIBLEMENTE en Kapso, igual que hacía el
 * rechazo de lotes antes de esta fase.
 */

import { normalizePhone } from '@/lib/phone';
import { extractMessageContext } from '@/lib/flow/nfm';

/** Un sobre individual con su posición original. */
export interface WebhookEnvelope {
  /** Posición en `data[]`. Única fuente de orden dentro del lote. */
  index: number;
  /** Sobre con la MISMA forma que un webhook individual. */
  payload: unknown;
}

/** `batch_info`, solo para diagnóstico. Nunca decide nada. */
export interface BatchInfo {
  size: number | null;
  windowMs: number | null;
  firstSequence: number | null;
  lastSequence: number | null;
  conversationId: string | null;
}

export type BatchRejection =
  /** `batch: true` sin `data` array. */
  | 'batch_data_not_array'
  /** `batch: true` con `data` vacío: no hay nada que procesar. */
  | 'batch_data_empty'
  /** Falta `batch_info`, o no es un objeto. */
  | 'batch_missing_batch_info'
  /** Algún elemento no tiene la forma de un sobre individual. */
  | 'batch_element_invalid'
  /** Los elementos no son todos del mismo cliente. */
  | 'batch_mixed_conversations'
  /** Los elementos declaran `conversation.id` distintos. */
  | 'batch_mixed_conversation_ids'
  /** Los elementos declaran `phone_number_id` distintos. */
  | 'batch_mixed_phone_number_ids';

export type EnvelopesResult =
  | {
      ok: true;
      batched: boolean;
      envelopes: readonly WebhookEnvelope[];
      /** Solo en lotes. */
      batchInfo: BatchInfo | null;
    }
  | { ok: false; reason: BatchRejection };

function rec(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/**
 * ¿El payload es un lote? Autoridad: `batch === true`, que es lo que Kapso
 * confirmó.
 *
 * Se comprueba `batch === true` A SOLAS, sin exigir además que `data` sea un
 * array. La diferencia importa: exigir las dos cosas haría que un lote con
 * `data` roto dejara de parecer un lote y se colara por el camino individual,
 * que es exactamente el fallback silencioso que esta fase prohíbe. Aquí lo que
 * declara ser un lote se juzga como lote, y se rechaza si está mal formado.
 */
export function isBatchEnvelope(payload: unknown): boolean {
  return rec(payload)?.batch === true;
}

function readBatchInfo(raw: unknown): BatchInfo {
  const info = rec(raw) ?? {};
  return {
    size: num(info.size),
    windowMs: num(info.window_ms),
    firstSequence: num(info.first_sequence),
    lastSequence: num(info.last_sequence),
    conversationId: str(info.conversation_id),
  };
}

/** Valores DECLARADOS (no nulos) de un campo a lo largo del lote. */
function declaredValues(
  envelopes: readonly WebhookEnvelope[],
  read: (envelope: Record<string, unknown>) => string | null,
): Set<string> {
  const valores = new Set<string>();
  for (const envelope of envelopes) {
    const valor = read(rec(envelope.payload) ?? {});
    if (valor !== null) valores.add(valor);
  }
  return valores;
}

/** Identidad durable de un sobre: la misma fuente que usa el resto del webhook. */
export function envelopePhone(payload: unknown): string {
  const ctx = extractMessageContext(payload);
  return normalizePhone(ctx.conversationPhone ?? ctx.from ?? '');
}

/**
 * Normaliza una entrega a lista de sobres.
 *
 * Un payload individual pasa tal cual, en una lista de uno: el camino
 * individual no cambia ni una coma, y esa es la mitad más importante del
 * contrato de esta fase.
 */
export function toEnvelopes(payload: unknown): EnvelopesResult {
  if (!isBatchEnvelope(payload)) {
    return { ok: true, batched: false, envelopes: [{ index: 0, payload }], batchInfo: null };
  }

  const root = rec(payload)!;

  if (!Array.isArray(root.data)) return { ok: false, reason: 'batch_data_not_array' };
  if (root.data.length === 0) return { ok: false, reason: 'batch_data_empty' };
  // Se exige presente porque es el único diagnóstico del lote: sin él no se
  // puede afirmar después qué llegó ni con qué ventana.
  if (rec(root.batch_info) === null) return { ok: false, reason: 'batch_missing_batch_info' };

  const envelopes: WebhookEnvelope[] = [];
  for (const [index, element] of root.data.entries()) {
    // Cada elemento tiene que ser un sobre individual de verdad. `message` es lo
    // mínimo: sin él no hay mensaje que procesar y `extractMessageContext`
    // devolvería un hueco silencioso.
    const envelope = rec(element);
    if (envelope === null || rec(envelope.message) === null) {
      return { ok: false, reason: 'batch_element_invalid' };
    }
    envelopes.push({ index, payload: element });
  }

  // Kapso agrupa POR CONVERSACIÓN. Se comprueba porque si esa garantía fallara,
  // el daño no sería un error visible sino un turno del agente que mezcla dos
  // clientes: contexto de uno respondido al otro. Preferimos no procesar.
  //
  // Las tres señales de identidad se miran por separado porque fallan distinto:
  // el teléfono decide a QUIÉN se le responde, `conversation.id` es la
  // referencia del proveedor, y `phone_number_id` decide POR QUÉ NÚMERO sale la
  // respuesta. Un lote incoherente en la última contestaría desde un número que
  // el cliente no reconoce.
  const phones = new Set(envelopes.map((e) => envelopePhone(e.payload)));
  if (phones.size > 1) return { ok: false, reason: 'batch_mixed_conversations' };

  // Solo los valores PRESENTES: que un elemento no traiga el campo no es una
  // contradicción, es una ausencia, y el resto del pipeline ya sabe convivir
  // con ella. Se rechaza cuando dos elementos afirman cosas distintas.
  const conversationIds = declaredValues(envelopes, (env) => str(rec(env.conversation)?.id));
  if (conversationIds.size > 1) return { ok: false, reason: 'batch_mixed_conversation_ids' };

  const phoneNumberIds = declaredValues(envelopes, (env) => str(env.phone_number_id));
  if (phoneNumberIds.size > 1) return { ok: false, reason: 'batch_mixed_phone_number_ids' };

  return {
    ok: true,
    batched: true,
    envelopes,
    batchInfo: readBatchInfo(root.batch_info),
  };
}
