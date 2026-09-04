import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import { log } from '@/lib/log';

/**
 * El pedido corregido sustituye al anterior — server-only (0035).
 *
 * Cuando el cliente entra por el botón "Cambiar mi pedido", su enlace lleva
 * escrito a qué pedido viene a sustituir (`menu_sessions.replaces_order_id`).
 * El checkout crea el pedido nuevo por el camino de siempre —la RPC no cambia
 * ni una línea— y esto se ocupa de lo único que falta: que el viejo deje de
 * existir para la cocina, el repartidor y el panel.
 *
 * ── Por qué CANCELAR y no editar el pedido en su sitio ──────────────────────
 *
 * Editar significaría reescribir líneas, promociones y totales fuera de
 * `create_order_web_v4`, que es la única función que sabe releer precios,
 * revalidar combos y recalcular importes dentro de una transacción. Tener un
 * segundo camino de escritura sobre `orders` es exactamente lo que este
 * proyecto no tiene, y no compensa estrenarlo para esto: el resultado visible
 * para el cliente —una comanda con lo que quería y un total correcto— es el
 * mismo, y el rastro queda más claro (se ve qué pidió antes y qué cambió).
 *
 * Lo que sí cambia es el número: el pedido corregido es #12 y no #7. Por eso el
 * mensaje del botón avisa de que le llegará el total actualizado.
 *
 * ── Las guardas, y por qué son estas ────────────────────────────────────────
 *
 *   MISMO TELÉFONO   el enlace lo emitimos nosotros, pero se comprueba igual:
 *                    es lo único que impide que un enlace filtrado cancele el
 *                    pedido de otra persona.
 *   ESTADO           un pedido que ya está en la plancha o en camino no se
 *                    cancela por un enlace: eso es comida hecha. Sí se cancela
 *                    el que espera ubicación, que es solo un carrito con número.
 *   SIN PAGO VIVO    si hay un intento aceptado o esperando revisión, hay
 *                    dinero contra ese total. Se deja como está y lo mira una
 *                    persona; cancelar dejaría un pago huérfano.
 *
 * Si alguna guarda no se cumple, el pedido nuevo queda igualmente creado. Eso
 * es deliberado: el cliente pidió, y quedarse sin pedido sería peor que quedar
 * con dos. El caso queda en el log y en el panel, que es donde se ve.
 */

/** Motivo que queda escrito en las notas del pedido anulado. */
const NOTA_DE_REEMPLAZO = 'Reemplazado por un pedido corregido del cliente.';

/**
 * Estados en los que el pedido anterior todavía se puede anular.
 *
 * Los mismos que dejan pedir el cambio (`ORDER_CHANGE_STATUSES`), y por la
 * misma razón: si el botón se ofrece con el pedido esperando ubicación, el
 * viejo tiene que poder cancelarse ahí. Cuando solo estaba `confirmed`, el
 * cliente que rehacía su pedido antes de mandar el GPS acababa con dos.
 */
const ESTADOS_ANULABLES = ['awaiting_location', 'confirmed'];

interface FilaPedidoViejo {
  id: string;
  status: string;
  customer_phone: string;
  notes: string | null;
}

/**
 * ¿Este pedido tiene un pago vivo? `null` = no se pudo consultar.
 *
 * Vivo es `accepted` o `pending_review`: en los dos casos hay dinero apuntando
 * a ese total concreto. Un intento `rejected` no cuenta — ese pago ya se
 * descartó y el cliente sigue debiendo.
 */
async function tienePagoVivo(
  supabase: SupabaseClient,
  orderId: string,
): Promise<boolean | null> {
  const { data, error } = await supabase
    .from('payment_attempts')
    .select('review_status')
    .eq('order_id', orderId)
    .in('review_status', ['accepted', 'pending_review'])
    .limit(1);

  if (error) return null;
  return (data ?? []).length > 0;
}

export interface ReplaceOrderInput {
  /** Pedido recién creado desde el enlace de cambio. */
  newOrderId: string;
  /** Sesión por la que entró: es quien sabe a qué pedido sustituye. */
  menuSessionId: string;
}

export type ReplaceOrderResult =
  /** Se canceló el anterior. */
  | { result: 'replaced'; replacedOrderId: string }
  /** La sesión no venía de un botón de cambio: el caso normal. */
  | { result: 'not_a_replacement' }
  /** Había un pedido que sustituir, pero ya no se podía tocar. */
  | { result: 'skipped'; reason: 'phone_mismatch' | 'not_confirmed' | 'payment_in_flight' }
  | { result: 'failed' };

/**
 * Cancela el pedido al que sustituye el recién creado. NUNCA lanza.
 *
 * Corre DESPUÉS de responderle al navegador (dentro de `after()`), como el
 * despacho de notificaciones: el cliente ya tiene su pedido y esto es
 * consecuencia, no requisito.
 */
export async function replaceSupersededOrder(
  input: ReplaceOrderInput,
  supabase: SupabaseClient = getSupabaseAdmin(),
): Promise<ReplaceOrderResult> {
  try {
    const { data: sesion, error: errorSesion } = await supabase
      .from('menu_sessions')
      .select('replaces_order_id, customer_phone')
      .eq('id', input.menuSessionId)
      .maybeSingle();

    if (errorSesion) return { result: 'failed' };
    const fila = sesion as { replaces_order_id: string | null; customer_phone: string } | null;
    const viejoId = fila?.replaces_order_id ?? null;

    // El caso de todos los días: una sesión normal no sustituye a nadie.
    if (!fila || viejoId === null) return { result: 'not_a_replacement' };
    // Un enlace que apunte al pedido que acaba de crear no cancela nada.
    if (viejoId === input.newOrderId) return { result: 'not_a_replacement' };

    const { data: pedido, error: errorPedido } = await supabase
      .from('orders')
      .select('id, status, customer_phone, notes')
      .eq('id', viejoId)
      .maybeSingle();

    if (errorPedido) return { result: 'failed' };
    if (!pedido) return { result: 'failed' };

    const viejo = pedido as FilaPedidoViejo;

    if (viejo.customer_phone !== fila.customer_phone) {
      log.warn('order_replacement_phone_mismatch');
      return { result: 'skipped', reason: 'phone_mismatch' };
    }
    if (!ESTADOS_ANULABLES.includes(viejo.status)) {
      return { result: 'skipped', reason: 'not_confirmed' };
    }

    const pagoVivo = await tienePagoVivo(supabase, viejo.id);
    // `null` es "no lo sabemos", y con dinero de por medio eso se trata como un
    // sí: no se cancela nada que pudiera tener un pago detrás.
    if (pagoVivo === null || pagoVivo) {
      log.warn('order_replacement_payment_in_flight', { order_id: viejo.id });
      return { result: 'skipped', reason: 'payment_in_flight' };
    }

    // El guard de estado viaja DENTRO del UPDATE: entre la lectura y la
    // escritura cabe que la cocina acepte el pago y lo arranque.
    const { data: cancelado, error: errorUpdate } = await supabase
      .from('orders')
      .update({
        status: 'cancelled',
        notes: viejo.notes ? `${viejo.notes}\n${NOTA_DE_REEMPLAZO}` : NOTA_DE_REEMPLAZO,
      })
      .eq('id', viejo.id)
      .in('status', ESTADOS_ANULABLES)
      .select('id');

    if (errorUpdate) return { result: 'failed' };
    if ((cancelado ?? []).length === 0) return { result: 'skipped', reason: 'not_confirmed' };

    log.info('order_replaced', { replaced_order_id: viejo.id, new_order_id: input.newOrderId });
    return { result: 'replaced', replacedOrderId: viejo.id };
  } catch {
    // Sin `error.message`: puede traer detalle técnico de Supabase.
    log.warn('order_replacement_failed');
    return { result: 'failed' };
  }
}
