import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import { getKapsoClient } from '@/lib/kapso/client';
import { pickupSwitchText, pickupUnavailableText } from '@/lib/kapso/messages';
import { readCurrentPromoMode } from '@/lib/promotions/current-mode';
import { createAgentStore } from '@/lib/agent/memory/repository';
import { log } from '@/lib/log';
import { deliveryNoticeAlreadySent } from '@/lib/alerts/outbox-store';

/**
 * "PASO YO A RECOGERLO" — el pedido deja de ser delivery (04-09-2026).
 *
 * ── Por qué esto se puede hacer sin tocar el dinero ─────────────────────────
 *
 * Porque el QR de este negocio cobra SOLO la comida: el envío se paga en la
 * puerta al recibir. Así que pasar un pedido a recojo no cambia ni un centavo
 * de lo que el cliente ya pagó o va a pagar por QR — solo deja de haber una
 * puerta donde cobrar el envío. Ese detalle es lo que convierte un cambio que
 * parecía delicado en tres columnas de una fila.
 *
 * Si algún día el QR cobrara el total, esto deja de ser cierto y habría que
 * devolver dinero: entonces este servicio ya no vale.
 *
 * ── Por qué se ESCRIBE aquí y no se rearma el pedido ────────────────────────
 *
 * El botón "Cambiar mi pedido" (0035) existe para cuando cambia lo que se
 * COCINA: ahí hay que releer precios, revalidar combos y recalcular, y eso solo
 * lo sabe hacer `create_order_web_v4`. Aquí no cambia ni una línea del pedido:
 * cambia por dónde sale. Mandar a rearmar el carrito entero por eso sería
 * cobrarle al cliente el trabajo de nuestra arquitectura.
 *
 * ── Las guardas, y por qué son estas ────────────────────────────────────────
 *
 *   YA ES RECOJO      no hay nada que cambiar.
 *   PEDIDO EN CAMINO  `on_the_way` o con el aviso de reparto ya enviado: el
 *                     repartidor tiene ese pedido asignado y puede estar en la
 *                     moto. Convertirlo lo dejaría saliendo hacia una puerta
 *                     donde ya no lo esperan.
 *   ENVÍO YA PAGADO   si consta que el envío está cobrado, ponerlo a cero deja
 *                     dinero de más sin nadie que lo mire. Eso lo ve una
 *                     persona.
 *
 * Si alguna no se cumple, no se toca NADA y se devuelve `ok: false`: el webhook
 * lo trata como un mensaje sin atender y sigue su camino, igual que con la nota
 * de cocina. Un "listo, lo dejamos para recoger" sin haberlo dejado para
 * recoger es la promesa falsa que este proyecto no hace.
 */

/** Estados en los que el pedido todavía no salió hacia ninguna puerta. */
const ESTADOS_CONVERTIBLES = ['confirmed', 'preparing', 'ready'];

export interface SwitchToPickupInput {
  toDigits: string;
  phoneNumberId: string | null;
  /** WAMID del mensaje del cliente. Solo para trazar. */
  sourceMessageId: string;
  orderId: string;
}

interface FilaPedido {
  order_number: string;
  delivery_type: string;
  status: string;
  subtotal_amount: number;
  delivery_fee_paid: boolean | null;
}

/**
 * Pasa el pedido a recojo y se lo confirma al cliente. NUNCA lanza.
 *
 * `ok: false` significa que NO se atendió —por guarda o por fallo—, y en ese
 * caso el cliente no recibe nada de aquí.
 *
 * `declined: true` (14-09-2026): en noche de promoción no hay recojo. El pedido
 * NO se toca y al cliente se le dice que sale igual con delivery; el mensaje
 * queda atendido, porque callarse lo dejaría esperando para ir a buscarlo.
 */
export async function switchOrderToPickup(
  input: SwitchToPickupInput,
  supabase: SupabaseClient = getSupabaseAdmin(),
): Promise<{ ok: boolean; declined?: boolean }> {
  let fila: FilaPedido;
  try {
    const { data, error } = await supabase
      .from('orders')
      .select(
        'order_number, delivery_type, status, subtotal_amount, delivery_fee_paid',
      )
      .eq('id', input.orderId)
      .maybeSingle();
    if (error || !data) return { ok: false };
    fila = data as FilaPedido;
  } catch {
    log.warn('pickup_switch_read_failed');
    return { ok: false };
  }

  if (fila.delivery_type !== 'delivery') return { ok: false };
  if (!ESTADOS_CONVERTIBLES.includes(fila.status)) return { ok: false };

  // Noche de promoción: todo sale con delivery. Va después de las dos guardas
  // de arriba —a un pedido que ya es de recojo o que ya salió no hay nada que
  // negarle— y antes de todo lo que escribe.
  if (!(await readCurrentPromoMode(supabase)).pickupAllowed) {
    log.info('pickup_switch_skipped', { reason: 'promo_night' });
    const avisado = await avisarAlCliente(
      input,
      pickupUnavailableText(fila.order_number),
      'pickup_declined',
      supabase,
    );
    return avisado ? { ok: true, declined: true } : { ok: false };
  }
  // El repartidor ya tiene este pedido: lo mira una persona.
  //
  // 05-09-2026: esto miraba `orders.delivery_notice_sent_at`, una columna que
  // dejó de escribirse en 0028 —el aviso vive en el outbox— así que la guarda
  // respondía "no se avisó" siempre y no impedía nada. Ver
  // `deliveryNoticeAlreadySent`.
  if (await deliveryNoticeAlreadySent(input.orderId, supabase)) {
    log.info('pickup_switch_skipped', { reason: 'notice_sent' });
    return { ok: false };
  }
  if (fila.delivery_fee_paid === true) {
    log.info('pickup_switch_skipped', { reason: 'fee_paid' });
    return { ok: false };
  }

  const comida = Number(fila.subtotal_amount) || 0;

  let convertido: boolean;
  try {
    // Las guardas de carrera viajan DENTRO del UPDATE: entre la lectura y la
    // escritura cabe que la cocina despache el pedido y avise al repartidor.
    //
    // La del AVISO se quedó fuera desde el 05-09-2026, y no por descuido: vive
    // en otra tabla (`telegram_alerts`) y no cabe en este `update`. Tampoco se
    // pierde nada, porque la que había —`delivery_notice_sent_at is null`— era
    // cierta siempre: esa columna no se escribe desde 0028. La comprobación
    // real se hace arriba, contra el outbox.
    const { data, error } = await supabase
      .from('orders')
      .update({ delivery_type: 'pickup', delivery_amount: 0, total_amount: comida })
      .eq('id', input.orderId)
      .eq('delivery_type', 'delivery')
      .in('status', ESTADOS_CONVERTIBLES)
      .select('id');
    if (error) return { ok: false };
    convertido = (data ?? []).length > 0;
  } catch {
    log.warn('pickup_switch_write_failed');
    return { ok: false };
  }
  if (!convertido) return { ok: false };

  // El pedido YA es de recojo, que es lo que protege al repartidor de un viaje
  // inútil. Si el aviso no sale, lo que falta es el aviso, y eso se ve en el panel.
  const avisado = await avisarAlCliente(
    input,
    pickupSwitchText(fila.order_number, comida),
    'pickup_switch',
    supabase,
  );
  if (!avisado) return { ok: false };

  log.info('pickup_switch_done');
  return { ok: true };
}

/**
 * Manda el texto y lo anota en la memoria del agente. `false` si no salió.
 *
 * La anotación es para que el modelo sepa qué se le dijo; si falla, el cliente
 * ya tiene su mensaje y eso no se deshace.
 */
async function avisarAlCliente(
  input: SwitchToPickupInput,
  texto: string,
  action: 'pickup_switch' | 'pickup_declined',
  supabase: SupabaseClient,
): Promise<boolean> {
  let wamid: string;
  try {
    const enviado = await getKapsoClient().sendText(input.toDigits, texto, {
      phoneNumberId: input.phoneNumberId ?? undefined,
    });
    if (!enviado.ok) {
      log.warn('pickup_switch_ack_failed', { action, error: enviado.error });
      return false;
    }
    wamid = enviado.wamid;
  } catch {
    log.warn('pickup_switch_ack_failed', { action, error: 'threw' });
    return false;
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
    log.warn('pickup_switch_memory_failed', { action });
  }

  return true;
}
