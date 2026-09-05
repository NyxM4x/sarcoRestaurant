import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getKapsoClient } from './client';
import { orderReviewKeptText, orderReviewText, type OrderReviewLine } from './messages';
import { log } from '@/lib/log';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import { createAgentStore } from '@/lib/agent/memory/repository';

/**
 * "¿Querés agregar algo más?" — envío y memoria (server-only, 05-09-2026).
 *
 * Antes de mandarle el botón que reabre su pedido, al cliente se le enseña lo
 * que armó y se le pregunta. Según lo que conteste sale el enlace de modificar
 * o la confirmación de que queda así. Ver `webhook/default-reply.ts` para
 * cuándo se elige esta rama.
 *
 * ── La fila de memoria es el estado de espera ───────────────────────────────
 *
 * Igual que el recordatorio del comprobante: el saliente se anota en
 * `agent_messages` y esa MISMA fila es la que después dice que hay una pregunta
 * pendiente. No hay tabla nueva, ni columna, ni migración a mano — y sobre todo
 * no hay dos verdades que puedan discrepar sobre si se preguntó.
 *
 * Por eso un fallo al persistir SÍ se reporta: una pregunta enviada y no
 * anotada deja al cliente contestando "2" a algo que para el sistema no existe.
 */

/**
 * Valor de `metadata.action` de la fila. Es la clave con la que
 * `customer-state-service` encuentra la pregunta pendiente, así que vive en un
 * solo sitio y se importa.
 */
export const ORDER_REVIEW_ACTION = 'order_review';

/** Lo que hace falta para escribirle. Los importes salen de la base, no del chat. */
export interface SendOrderReviewInput {
  /** Teléfono del cliente, solo dígitos. */
  toDigits: string;
  phoneNumberId: string | null;
  /** WAMID del mensaje del cliente que provocó la pregunta. */
  sourceMessageId: string;
  /** Identificador interno: con él se leen las líneas del pedido. */
  orderId: string;
  /** Número interno (`ORD-260904-026`); el copy lo acorta a `#26`. */
  orderNumber: string;
  totalAmount: number;
  isCash: boolean;
}

/**
 * Las líneas del pedido, para poder enseñárselas.
 *
 * `product_name_snapshot` y no el nombre del catálogo: es lo que el cliente
 * eligió, aunque la carta haya cambiado desde entonces. La misma fuente que usa
 * el aviso al grupo de reparto.
 *
 * Devuelve `[]` ante cualquier fallo, y quien llama lo trata como "no hay nada
 * que enseñar": un pedido sin líneas no se le muestra a nadie.
 */
async function lineasDelPedido(
  supabase: SupabaseClient,
  orderId: string,
): Promise<OrderReviewLine[]> {
  try {
    const { data, error } = await supabase
      .from('order_items')
      .select('product_name_snapshot, quantity, subtotal')
      .eq('order_id', orderId)
      .order('product_name_snapshot', { ascending: true });

    if (error || !data) return [];

    return (data as Array<Record<string, unknown>>).map((row) => ({
      name: String(row.product_name_snapshot ?? 'producto'),
      quantity: Number(row.quantity) || 1,
      subtotal: Number(row.subtotal) || 0,
    }));
  } catch {
    return [];
  }
}

/**
 * El envío del que cuelgan las dos variantes. Anota el saliente y NUNCA lanza.
 *
 * `action` distingue la pregunta de su cierre: solo la PREGUNTA abre la espera,
 * porque solo ella espera respuesta. Anotar el cierre con la misma etiqueta
 * dejaría al cliente en estado de "pendiente de contestar" justo después de
 * haber contestado.
 */
async function mandarYAnotar(
  input: { toDigits: string; phoneNumberId: string | null },
  texto: string,
  action: string,
  supabase: SupabaseClient,
): Promise<{ ok: boolean }> {
  let wamid: string;
  try {
    const enviado = await getKapsoClient().sendText(input.toDigits, texto, {
      phoneNumberId: input.phoneNumberId ?? undefined,
    });
    if (!enviado.ok) {
      log.warn('order_review_send_failed', { error: enviado.error });
      return { ok: false };
    }
    wamid = enviado.wamid;
  } catch {
    log.warn('order_review_send_failed', { error: 'threw' });
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
      content: texto,
      contentType: 'text',
      metadata: { action, resource_type: 'order' },
      messageTimestamp: new Date().toISOString(),
    });
  } catch {
    // El cliente YA tiene la pregunta delante. Que no se haya podido anotar
    // significa que su respuesta no se leerá como tal: se reporta para que el
    // webhook no dé el turno por atendido.
    log.warn('order_review_memory_failed');
    return { ok: false };
  }

  return { ok: true };
}

/**
 * Le enseña su pedido y le pregunta si le falta algo. NUNCA lanza.
 *
 * `ok: false` = puede no haberla recibido, o no quedó anotada. El webhook lo
 * trata como mensaje sin atender y el turno sigue su camino, que es mejor que
 * dar por hecha una pregunta que el cliente quizá no vio.
 */
export async function sendOrderReview(
  input: SendOrderReviewInput,
  supabase: SupabaseClient = getSupabaseAdmin(),
): Promise<{ ok: boolean }> {
  const lines = await lineasDelPedido(supabase, input.orderId);

  // Sin líneas no hay nada que enseñar, y una pregunta sobre un pedido vacío no
  // se entiende. Ese cliente sigue el camino de hoy.
  if (lines.length === 0) {
    log.warn('order_review_without_items', { order_number: input.orderNumber });
    return { ok: false };
  }

  // El envío es lo que falta entre la comida y el total. Se calcula y no se
  // recibe: dos cifras que ya están en la base no pueden dar una tercera.
  const comida = lines.reduce((suma, l) => suma + l.subtotal, 0);
  const envio = input.totalAmount > comida ? input.totalAmount - comida : 0;

  const texto = orderReviewText({
    orderNumber: input.orderNumber,
    lines,
    deliveryAmount: envio,
    totalAmount: input.totalAmount,
    isCash: input.isCash,
  });

  return mandarYAnotar(input, texto, ORDER_REVIEW_ACTION, supabase);
}

/**
 * "Listo, queda así." Cierra la pregunta sin tocar el pedido. NUNCA lanza.
 *
 * Se anota con OTRA etiqueta a propósito: este mensaje no espera respuesta, y
 * marcarlo como la pregunta dejaría al cliente pendiente de contestar algo que
 * acaba de contestar.
 */
export async function sendOrderReviewKept(
  input: Omit<SendOrderReviewInput, 'orderId'>,
  supabase: SupabaseClient = getSupabaseAdmin(),
): Promise<{ ok: boolean }> {
  const texto = orderReviewKeptText(input.orderNumber, input.totalAmount, input.isCash);
  return mandarYAnotar(input, texto, 'order_review_kept', supabase);
}
