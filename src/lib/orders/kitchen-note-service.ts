import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import { getKapsoClient } from '@/lib/kapso/client';
import { KITCHEN_NOTE_ACK_TEXT } from '@/lib/kapso/messages';
import { log } from '@/lib/log';
import { createAgentStore } from '@/lib/agent/memory/repository';
import { KITCHEN_NOTE_MAX_LENGTH } from '@/lib/webhook/order-change-intent';

/**
 * "Sin cebolla" → a la comanda — wiring server-only (04-09-2026).
 *
 * ── El orden es la garantía ────────────────────────────────────────────────
 *
 *   1. ESCRIBIR la nota en `orders.notes`   ← lo que la cocina imprime
 *   2. solo entonces, CONTESTAR al cliente
 *   3. anotar el saliente en la memoria
 *
 * Si el paso 1 falla, el paso 2 no ocurre. Un "claro que sí, ya lo anotamos"
 * sin nota escrita es una promesa falsa, y este proyecto lleva desde agosto
 * cerrando exactamente esa clase de agujero: el cliente se quedaría tranquilo y
 * su hamburguesa saldría con cebolla.
 *
 * ── Solo mientras el pedido no esté en la plancha ──────────────────────────
 *
 * El guard `status = 'confirmed'` viaja DENTRO del UPDATE, no en una lectura
 * previa: entre mirar y escribir cabe que la cocina acepte el pago y arranque.
 * Si el UPDATE no toca ninguna fila, no se contesta que sí — porque ya no es
 * verdad.
 */

/** Separador entre notas. Una por línea: la comanda se lee de un vistazo. */
const SEPARADOR = '\n';

/**
 * Tope del campo entero. `orders.notes` es texto libre y nadie lo limita en la
 * base, pero una comanda con veinte líneas de notas no la lee nadie — y quien
 * escribe veinte notas necesita una persona, no otra línea.
 */
const NOTES_MAX_LENGTH = 600;

export interface AppendKitchenNoteInput {
  /** Teléfono del cliente, solo dígitos. */
  toDigits: string;
  phoneNumberId: string | null;
  /** WAMID del mensaje del cliente que trajo la preferencia. */
  sourceMessageId: string;
  orderId: string;
  /** Texto del cliente, ya saneado (`kitchenNoteFrom`). */
  note: string;
}

/** ¿La nota ya está escrita en el pedido? Comparación laxa de espacios y caja. */
function yaContiene(notes: string | null, note: string): boolean {
  if (!notes) return false;
  const plano = (t: string) => t.toLowerCase().replace(/\s+/g, ' ').trim();
  return plano(notes).includes(plano(note));
}

/**
 * Escribe la nota en el pedido. Devuelve `false` si no se pudo (o si el pedido
 * ya no la admite), y `true` también cuando la nota ya estaba: para el cliente
 * el desenlace es el mismo —su preferencia consta— y repetirla en la comanda no
 * ayudaría a nadie.
 */
async function escribirNota(
  supabase: SupabaseClient,
  orderId: string,
  note: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('orders')
    .select('notes, status')
    .eq('id', orderId)
    .maybeSingle();

  if (error || !data) return false;

  const fila = data as { notes: string | null; status: string };
  // Ya entró a cocina entre la decisión y ahora: no se toca ni se promete nada.
  if (fila.status !== 'confirmed') return false;
  if (yaContiene(fila.notes, note)) return true;

  const actualizadas = (fila.notes ? `${fila.notes}${SEPARADOR}` : '') + note;
  if (actualizadas.length > NOTES_MAX_LENGTH) return false;

  // COMPARE-AND-SWAP sobre el valor leído: dos mensajes del mismo cliente
  // entregados a la vez no pueden pisarse una nota al otro. `null` necesita su
  // propio operador — en SQL nada es igual a `null`, ni siquiera `null`.
  const query = supabase
    .from('orders')
    .update({ notes: actualizadas })
    .eq('id', orderId)
    .eq('status', 'confirmed');

  const { data: escrita, error: errorUpdate } = await (
    fila.notes === null ? query.is('notes', null) : query.eq('notes', fila.notes)
  ).select('id');

  if (errorUpdate) return false;
  return (escrita ?? []).length > 0;
}

/**
 * Anota la preferencia y se lo confirma al cliente. NUNCA lanza.
 *
 * `ok: false` significa que NO se anotó, y el webhook lo trata como un mensaje
 * sin atender: seguirá su camino en vez de darle por buena una preferencia que
 * la cocina nunca vería.
 */
export async function appendKitchenNote(
  input: AppendKitchenNoteInput,
  supabase: SupabaseClient = getSupabaseAdmin(),
): Promise<{ ok: boolean }> {
  const note = input.note.trim().slice(0, KITCHEN_NOTE_MAX_LENGTH);
  if (note === '') return { ok: false };

  let anotada: boolean;
  try {
    anotada = await escribirNota(supabase, input.orderId, note);
  } catch {
    // Sin `error.message`: puede traer detalle técnico de Supabase.
    log.warn('kitchen_note_write_failed');
    return { ok: false };
  }
  if (!anotada) return { ok: false };

  let wamid: string;
  try {
    const enviado = await getKapsoClient().sendText(input.toDigits, KITCHEN_NOTE_ACK_TEXT, {
      phoneNumberId: input.phoneNumberId ?? undefined,
    });
    if (!enviado.ok) {
      // La nota YA está escrita, que es lo que protege al pedido. Lo que falta
      // es el acuse, y eso lo arregla el siguiente mensaje del cliente.
      log.warn('kitchen_note_ack_failed', { error: enviado.error });
      return { ok: false };
    }
    wamid = enviado.wamid;
  } catch {
    log.warn('kitchen_note_ack_failed', { error: 'threw' });
    return { ok: false };
  }

  try {
    const store = createAgentStore(supabase);
    const conversation = await store.upsertConversation({
      customerPhone: input.toDigits,
      providerConversationId: null,
      providerPhoneNumberId: input.phoneNumberId,
    });
    await store.insertMessage({
      agentConversationId: conversation.id,
      providerMessageId: wamid,
      providerConversationId: null,
      direction: 'outbound',
      role: 'assistant',
      actor: 'automation',
      content: KITCHEN_NOTE_ACK_TEXT,
      contentType: 'text',
      metadata: { action: 'kitchen_note', resource_type: 'order' },
      messageTimestamp: new Date().toISOString(),
    });
  } catch {
    // El cliente ya tiene su confirmación y la cocina su nota. Que no hayamos
    // podido anotar el saliente no des-hace ninguna de las dos cosas.
    log.warn('kitchen_note_memory_failed');
  }

  return { ok: true };
}
