import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import { getKapsoClient } from '@/lib/kapso/client';
import { log } from '@/lib/log';
import { createAgentStore } from '@/lib/agent/memory/repository';
import { notifyDeliveryGroup } from '@/lib/alerts/delivery-notice-service';
import {
  orderCancelledByCustomerText,
  orderConfirmedByCashText,
  orderExpiredWithoutConfirmText,
} from '@/lib/orders/notifications/notify-text';
import type { DeliveryType } from '@/types';

/**
 * "CONFIRMO" / "CANCELAR" del pedido en efectivo — server-only (05-09-2026).
 *
 * ── Qué cambia respecto a ayer ──────────────────────────────────────────────
 *
 * El aviso al grupo de reparto salía al COTIZAR. Pero el cliente ve el precio
 * del envío en ese mismo mensaje y es entonces cuando decide: dos pedidos de la
 * madrugada del 05-09 —"muy caro su moto", "cancelar pedido"— ya estaban en el
 * teléfono de quien reparte cuando el cliente dijo que no.
 *
 * Ahora el pedido en efectivo espera. Aquí vive el instante en que deja de
 * esperar, en los dos sentidos.
 *
 * ── El orden es la garantía ─────────────────────────────────────────────────
 *
 *   1. ESCRIBIR `cash_confirmed_at`  ← lo que mete el pedido en cocina
 *   2. avisar al grupo de reparto
 *   3. contestarle al cliente
 *
 * Si 1 falla, no ocurre nada más: un "listo, ya está en cocina" sobre un pedido
 * que la cocina no ve es la clase de promesa falsa que este proyecto lleva
 * cerrando desde agosto. Y el UPDATE lleva su guarda dentro, así que dos
 * "CONFIRMO" seguidos no producen dos avisos.
 *
 * REQUISITO OPERATIVO: la migración 0036 debe estar aplicada.
 */

interface FilaPedido {
  id: string;
  order_number: string;
  status: string;
  delivery_type: DeliveryType;
  total_amount: number | string | null;
  payment_method: string | null;
  cash_confirmed_at: string | null;
}

/** Estados en los que todavía tiene sentido confirmar o cancelar. */
const ESTADOS_PENDIENTES = ['awaiting_location', 'confirmed'];

export interface CashDecisionInput {
  /** Teléfono del cliente, solo dígitos. */
  toDigits: string;
  phoneNumberId: string | null;
  /** WAMID del mensaje del cliente que trajo la decisión. */
  sourceMessageId: string;
  orderId: string;
}

/** Lee lo justo del pedido. `null` si no se puede decidir sobre él. */
async function pedidoPendiente(
  supabase: SupabaseClient,
  orderId: string,
): Promise<FilaPedido | null> {
  const { data, error } = await supabase
    .from('orders')
    .select(
      'id, order_number, status, delivery_type, total_amount, payment_method, cash_confirmed_at',
    )
    .eq('id', orderId)
    .maybeSingle();

  if (error || !data) return null;

  const fila = data as FilaPedido;
  if (fila.payment_method !== 'cash') return null;
  if (!ESTADOS_PENDIENTES.includes(fila.status)) return null;
  return fila;
}

/** Escribe el saliente en la memoria del agente. Best-effort. */
async function anotarSaliente(
  supabase: SupabaseClient,
  input: CashDecisionInput,
  texto: string,
  wamid: string,
  action: string,
): Promise<void> {
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
    // El efecto que importa —el pedido agendado o cancelado— ya ocurrió, y el
    // cliente ya tiene su respuesta. Esto es historial.
    log.warn('cash_decision_memory_failed');
  }
}

async function contestar(
  supabase: SupabaseClient,
  input: CashDecisionInput,
  texto: string,
  action: string,
): Promise<boolean> {
  try {
    const enviado = await getKapsoClient().sendText(input.toDigits, texto, {
      phoneNumberId: input.phoneNumberId ?? undefined,
    });
    if (!enviado.ok) {
      log.warn('cash_decision_reply_failed', { error: enviado.error });
      return false;
    }
    await anotarSaliente(supabase, input, texto, enviado.wamid, action);
    return true;
  } catch {
    log.warn('cash_decision_reply_failed', { error: 'threw' });
    return false;
  }
}

/**
 * El cliente confirmó: el pedido entra a cocina y sale al reparto. NUNCA lanza.
 *
 * `ok: false` = no se pudo, y entonces al cliente NO se le dice que sí. El
 * webhook lo trata como mensaje sin atender.
 */
export async function confirmCashOrder(
  input: CashDecisionInput,
  supabase: SupabaseClient = getSupabaseAdmin(),
): Promise<{ ok: boolean }> {
  try {
    const pedido = await pedidoPendiente(supabase, input.orderId);
    if (pedido === null) return { ok: false };
    // Ya confirmado: para el cliente el desenlace es el mismo, pero no se
    // vuelve a avisar al grupo ni a contestarle.
    if (pedido.cash_confirmed_at !== null) return { ok: true };

    // La guarda viaja DENTRO del UPDATE: dos "CONFIRMO" seguidos no pueden
    // producir dos avisos al reparto.
    const { data, error } = await supabase
      .from('orders')
      .update({ cash_confirmed_at: new Date().toISOString() })
      .eq('id', pedido.id)
      .is('cash_confirmed_at', null)
      .in('status', ESTADOS_PENDIENTES)
      .select('id');

    if (error) return { ok: false };
    if ((data ?? []).length === 0) return { ok: false };

    // Ahora sí: es el primer instante en que consta que quiere el pedido a ese
    // precio. La función comprueba por su cuenta que sea delivery cotizado.
    await notifyDeliveryGroup(input.orderId, supabase, 'cash_confirmed');

    const texto = orderConfirmedByCashText(
      pedido.order_number,
      Number(pedido.total_amount) || 0,
      pedido.delivery_type,
    );
    const contestado = await contestar(supabase, input, texto, 'cash_confirmed');

    log.info('cash_order_confirmed', { order_number: pedido.order_number });
    return { ok: contestado };
  } catch {
    log.warn('cash_confirm_failed');
    return { ok: false };
  }
}

/**
 * El cliente canceló: el pedido se cierra y no se cocina nada. NUNCA lanza.
 *
 * Se cancela de verdad (`status = 'cancelled'`) y no solo se oculta: quien
 * escribe "cancelar" espera que deje de existir, y un pedido vivo que nadie va
 * a pagar ensucia el panel y las cuentas de la noche.
 */
export async function cancelCashOrder(
  input: CashDecisionInput,
  supabase: SupabaseClient = getSupabaseAdmin(),
): Promise<{ ok: boolean }> {
  try {
    const pedido = await pedidoPendiente(supabase, input.orderId);
    if (pedido === null) return { ok: false };
    // Ya confirmado: ese pedido puede estar en la plancha o en la moto, y
    // cancelarlo por un mensaje sería tirar comida hecha. Lo mira una persona.
    if (pedido.cash_confirmed_at !== null) return { ok: false };

    const { data, error } = await supabase
      .from('orders')
      .update({ status: 'cancelled' })
      .eq('id', pedido.id)
      .is('cash_confirmed_at', null)
      .in('status', ESTADOS_PENDIENTES)
      .select('id');

    if (error) return { ok: false };
    if ((data ?? []).length === 0) return { ok: false };

    const texto = orderCancelledByCustomerText(pedido.order_number);
    const contestado = await contestar(supabase, input, texto, 'cash_cancelled');

    log.info('cash_order_cancelled', { order_number: pedido.order_number });
    return { ok: contestado };
  } catch {
    log.warn('cash_cancel_failed');
    return { ok: false };
  }
}

/**
 * Cuánto se espera un CONFIRMO antes de cancelar el pedido.
 *
 * Veinte minutos: más que los quince de la gracia del comprobante, porque aquí
 * no hay dinero esperando en ninguna parte y el cliente puede estar buscando el
 * efectivo. Menos de eso cancelaría pedidos vivos; mucho más deja el panel
 * lleno de pedidos que nadie va a pagar y ensucia las cuentas de la noche.
 */
export const CASH_CONFIRM_TIMEOUT_MS = 20 * 60 * 1000;

/** Cuántos se cancelan por latido. Techo de seguridad, no una cuota. */
const MAX_POR_BARRIDO = 25;

/**
 * Cancela los pedidos en efectivo que nadie confirmó. NUNCA lanza.
 *
 * ── Por qué se cancelan y no se quedan esperando ────────────────────────────
 *
 * Decisión del negocio: un pedido en efectivo sin confirmar no está en cocina
 * ni en el reparto, pero sí en el panel y en la numeración de la noche. Dejarlo
 * vivo indefinidamente convierte cada "muy caro su moto" en una fila que
 * alguien tendrá que mirar y descartar a mano al cuadrar la caja.
 *
 * Solo toca los que YA vieron su total (`confirmed`): al que todavía no mandó su
 * ubicación no se le ha preguntado nada, así que no se le puede exigir una
 * respuesta — ese caso lo atiende el flujo de la ubicación.
 *
 * El reloj arranca en `confirmed_at` —el instante en que se le mandó el total y
 * la pregunta— y no en `created_at`: entre armar el pedido y cotizarlo pueden
 * pasar minutos buscando el GPS, y no son minutos de silencio suyos.
 */
export async function expireUnconfirmedCashOrders(
  /**
   * El cliente se resuelve DENTRO del try, no en el valor por defecto: esto
   * corre en el latido del cron, donde un entorno a medio configurar haría
   * lanzar a `getSupabaseAdmin()` antes de entrar a la función — y con ello un
   * barrido de limpieza tumbaría un latido que sí recuperó lo importante.
   */
  client?: SupabaseClient,
): Promise<{ cancelled: number }> {
  try {
    const supabase = client ?? getSupabaseAdmin();
    const limite = new Date(Date.now() - CASH_CONFIRM_TIMEOUT_MS).toISOString();

    const { data, error } = await supabase
      .from('orders')
      .select('id, order_number, customer_phone, phone_number_id, confirmed_at, created_at')
      .eq('payment_method', 'cash')
      .eq('status', 'confirmed')
      .is('cash_confirmed_at', null)
      .lt('created_at', limite)
      .limit(MAX_POR_BARRIDO);

    if (error || !data) return { cancelled: 0 };

    let cancelados = 0;
    for (const fila of data as Array<Record<string, unknown>>) {
      const id = String(fila.id ?? '');
      const referencia = String(fila.confirmed_at ?? fila.created_at ?? '');
      // El filtro de arriba usa `created_at` porque es el que tiene índice; el
      // reloj de verdad es `confirmed_at`, y se comprueba aquí. Un pedido que
      // tardó en cotizarse conserva sus veinte minutos completos.
      if (referencia !== '' && Date.parse(referencia) > Date.now() - CASH_CONFIRM_TIMEOUT_MS) {
        continue;
      }

      const { data: cerrado, error: errorUpdate } = await supabase
        .from('orders')
        .update({ status: 'cancelled' })
        .eq('id', id)
        .is('cash_confirmed_at', null)
        .eq('status', 'confirmed')
        .select('id');

      // El guard viaja dentro del UPDATE: si confirmó entre la lectura y la
      // escritura, no se cancela nada.
      if (errorUpdate || (cerrado ?? []).length === 0) continue;
      cancelados += 1;

      const telefono = String(fila.customer_phone ?? '');
      if (telefono !== '') {
        await contestar(
          supabase,
          {
            toDigits: telefono,
            phoneNumberId: (fila.phone_number_id as string | null) ?? null,
            sourceMessageId: '',
            orderId: id,
          },
          orderExpiredWithoutConfirmText(String(fila.order_number ?? '')),
          'cash_expired',
        );
      }
    }

    if (cancelados > 0) log.info('cash_orders_expired', { count: cancelados });
    return { cancelled: cancelados };
  } catch {
    log.warn('cash_expiry_failed');
    return { cancelled: 0 };
  }
}
