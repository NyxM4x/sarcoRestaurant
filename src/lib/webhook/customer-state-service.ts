import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import { log } from '@/lib/log';
import type { OrderStatus, PaymentMethod, PaymentReviewStatus } from '@/types';
import { paymentGateOf } from '@/lib/payment-proof/payment-gate';
import { isPauseActive } from '@/lib/agent/control/pause-gate';
import { createAgentStore } from '@/lib/agent/memory/repository';
import {
  OPEN_ORDER_STATUSES,
  OPEN_ORDER_WINDOW_MS,
  ORDER_CHANGE_STATUSES,
  PROOF_REMINDER_COOLDOWN_MS,
  type CustomerStateSnapshot,
  type OpenOrderSnapshot,
} from './default-reply';
import { catalogTermsFromNames } from './order-change-intent';
import { createMenuRepository } from '@/lib/menu/repository';
import { PROOF_REMINDER_ACTION } from '@/lib/kapso/send-proof-reminder';
import { ORDER_REVIEW_ACTION } from '@/lib/kapso/send-order-review';

/**
 * En qué situación está el cliente que acaba de escribir — wiring server-only.
 *
 * Lo consume la respuesta POR DEFECTO del webhook (`default-reply.ts`), que
 * desde el 03-09-2026 manda el botón del menú a todo el que escribe salvo
 * excepciones. Este archivo resuelve exactamente esas excepciones, y ninguna
 * otra cosa: no envía nada, no decide nada y no interpreta el mensaje.
 *
 * ── `null` es una respuesta, no un error ────────────────────────────────────
 *
 * Ante CUALQUIER fallo de consulta devuelve `null`, y `null` significa "no lo
 * sabemos". El llamador no manda nada por defecto en ese caso, y esa es la
 * dirección segura: lo que no se puede descartar a ciegas es que haya una
 * persona del equipo escribiéndole al cliente en este momento.
 *
 * ── Por qué las tres consultas y no menos ───────────────────────────────────
 *
 *   1. PAUSA     → ¿hay un humano al mando? Es la que más importa.
 *   2. PEDIDO    → ¿tiene uno abierto, y en qué punto está su pago?
 *   3. RECUERDO  → ¿ya le pedimos el comprobante hace un momento?
 *   4. CARTA     → ¿qué se vende? Solo para distinguir "sin cebolla" de
 *                  "mándame 2 sodas" (`order-change-intent.ts`).
 *
 * Las tres últimas solo se hacen cuando la 2 encontró algo, así que el cliente
 * normal —el que escribe sin tener nada abierto— cuesta dos consultas cortas
 * por teléfono, ambas por índice.
 */

/** Lo que se lee de `orders`. Nada de ubicación, notas ni datos del cliente. */
interface FilaPedido {
  id: string;
  order_number: string;
  status: OrderStatus;
  total_amount: number;
  payment_method: PaymentMethod | null;
}

/**
 * El pedido abierto MÁS RECIENTE del teléfono, dentro de la ventana.
 *
 * `undefined` = no se pudo consultar (se propaga como estado desconocido);
 * `null` = no tiene ninguno, que es el caso normal y el que recibe el botón.
 */
async function pedidoAbierto(
  supabase: SupabaseClient,
  customerPhone: string,
): Promise<FilaPedido | null | undefined> {
  const desde = new Date(Date.now() - OPEN_ORDER_WINDOW_MS).toISOString();

  const { data, error } = await supabase
    .from('orders')
    .select('id, order_number, status, total_amount, payment_method')
    .eq('customer_phone', customerPhone)
    .in('status', [...OPEN_ORDER_STATUSES])
    .gte('created_at', desde)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) return undefined;
  return (data as FilaPedido | null) ?? null;
}

/**
 * En qué quedó cada intento de pago del pedido. `null` si no se pudo consultar.
 *
 * Un `null` NO es "no ha pagado": `paymentGateOf` lo traduce a `unknown`, que no
 * es `no_proof` y por tanto no dispara ningún recordatorio. Preguntarle por el
 * comprobante a alguien cuyo pago no pudimos mirar es el error que esa
 * distinción evita.
 */
async function intentosDePago(
  supabase: SupabaseClient,
  orderId: string,
): Promise<{ attempts: { status: PaymentReviewStatus; reviewedAt: string | null }[] } | null> {
  const { data, error } = await supabase
    .from('payment_attempts')
    .select('review_status, reviewed_at')
    .eq('order_id', orderId);

  if (error || !data) return null;

  return {
    attempts: (data as Array<{ review_status: PaymentReviewStatus; reviewed_at: string | null }>)
      .map((row) => ({ status: row.review_status, reviewedAt: row.reviewed_at })),
  };
}

/**
 * ¿Ya le recordamos el comprobante hace poco?
 *
 * Se cruza por la MEMORIA CONVERSACIONAL, no por una tabla nueva: el
 * recordatorio se persiste en `agent_messages` como saliente de `automation` con
 * `metadata.action`, igual que el menú. Esa fila hace dos trabajos a la vez —es
 * lo que el cliente vio, y es el reloj de este cooldown—, y por eso no hay dos
 * verdades que puedan discrepar.
 *
 * Ante un fallo de consulta devuelve `true`: se asume que sí, y no se manda. Un
 * recordatorio de menos lo arregla el siguiente mensaje del cliente; uno de más
 * es un mensaje repetido a alguien que está buscando la foto de su pago.
 */
async function recordadoHacePoco(
  supabase: SupabaseClient,
  conversationId: string | null,
): Promise<boolean> {
  // Sin conversación no hay historial: nunca se le recordó nada.
  if (conversationId === null) return false;

  const desde = new Date(Date.now() - PROOF_REMINDER_COOLDOWN_MS).toISOString();

  const { data, error } = await supabase
    .from('agent_messages')
    .select('id')
    .eq('agent_conversation_id', conversationId)
    .eq('actor', 'automation')
    .eq('metadata->>action', PROOF_REMINDER_ACTION)
    .gte('message_timestamp', desde)
    .limit(1);

  if (error) return true;
  return (data ?? []).length > 0;
}

/**
 * ¿Hay una pregunta "¿querés agregar algo más?" sin contestar? (05-09-2026)
 *
 * Misma técnica que el cooldown del comprobante y por la misma razón: el
 * saliente ya se anota en `agent_messages`, así que la fila que prueba que se
 * preguntó es también el reloj que dice hasta cuándo vale la respuesta. Una
 * columna nueva sería un segundo sitio donde guardar lo mismo — y una migración
 * a mano en la parte más caliente del flujo.
 *
 * Ante un error se responde `false`: sin poder confirmar que se preguntó, un
 * "no" del cliente vuelve a ser un texto cualquiera y sigue su camino de hoy.
 * Tratarlo como respuesta a una pregunta que quizá no se hizo es lo único que
 * podría tocarle el pedido por error.
 */
async function preguntadoHacePoco(
  supabase: SupabaseClient,
  conversationId: string | null,
): Promise<boolean> {
  if (conversationId === null) return false;

  const desde = new Date(Date.now() - PROOF_REMINDER_COOLDOWN_MS).toISOString();

  const { data, error } = await supabase
    .from('agent_messages')
    .select('id')
    .eq('agent_conversation_id', conversationId)
    .eq('actor', 'automation')
    .eq('metadata->>action', ORDER_REVIEW_ACTION)
    .gte('message_timestamp', desde)
    .limit(1);

  if (error) return false;
  return (data ?? []).length > 0;
}

/**
 * Palabras de los productos ACTIVOS. `undefined` si no se pudo leer la carta.
 *
 * Se lee de `menu_items` por el mismo repositorio que usa el resto del sistema:
 * el detector de preferencias no puede tener una carta propia que se
 * desincronice de la que se vende.
 */
async function terminosDeLaCarta(
  supabase: SupabaseClient,
): Promise<readonly string[] | undefined> {
  try {
    const items = await createMenuRepository(supabase).listActive();
    return catalogTermsFromNames(items.map((item) => item.name));
  } catch {
    return undefined;
  }
}

/**
 * ¿Llegó alguna foto para este pedido? `true` ante la duda.
 *
 * Mira `payment_proofs` y no `payment_attempts`: la fila del comprobante se
 * escribe en cuanto el mensaje entra, aunque después falle la descarga del
 * archivo. Cualquier estado de captura cuenta —`stored`, `capturing` o
 * `failed`—, porque lo que responde esta pregunta no es si el archivo está
 * guardado, sino si el cliente ya mandó algo.
 *
 * Un fallo de consulta devuelve `true`: callar de más a quien quizá pagó es
 * molesto; ofrecerle rehacer un pedido pagado le cuesta el pedido.
 */
async function llegoComprobante(
  supabase: SupabaseClient,
  orderId: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('payment_proofs')
    .select('id')
    .eq('order_id', orderId)
    .limit(1);

  if (error) return true;
  return (data ?? []).length > 0;
}

/**
 * Estado del cliente para la respuesta por defecto. NUNCA lanza.
 *
 * @param customerPhone Dígitos ya normalizados por el webhook.
 */
export async function lookupCustomerState(
  customerPhone: string,
  supabase: SupabaseClient = getSupabaseAdmin(),
): Promise<CustomerStateSnapshot | null> {
  if (customerPhone === '') return null;

  try {
    // 1. ¿Hay un humano al mando? Se pregunta si la pausa RIGE ahora, no si la
    //    fila dice `paused`: una pausa vencida y sin normalizar no calla a nadie.
    const pausa = await createAgentStore(supabase).findPauseStateByPhone(customerPhone);
    const paused = isPauseActive(pausa, new Date().toISOString());

    // Con un humano dentro no hace falta nada más: la decisión ya está tomada y
    // las otras consultas no cambiarían el desenlace.
    if (paused) return { paused: true, openOrder: null, proofRemindedRecently: false };

    // 2. ¿Tiene un pedido abierto?
    const pedido = await pedidoAbierto(supabase, customerPhone);
    if (pedido === undefined) return null;
    if (pedido === null) {
      return { paused: false, openOrder: null, proofRemindedRecently: false };
    }

    const pago = await intentosDePago(supabase, pedido.id);
    const gate = paymentGateOf(pedido.payment_method, pago, Date.now());
    const proofReceived = await llegoComprobante(supabase, pedido.id);

    const openOrder: OpenOrderSnapshot = {
      orderId: pedido.id,
      orderNumber: pedido.order_number,
      status: pedido.status,
      totalAmount: Number(pedido.total_amount),
      payment: gate.state,
      proofReceived,
      paymentMethod: pedido.payment_method ?? null,
    };

    // 3. El cooldown solo interesa cuando de verdad se va a recordar algo.
    const proofRemindedRecently =
      gate.state === 'no_proof'
        ? await recordadoHacePoco(supabase, pausa?.conversationId ?? null)
        : false;

    // 4. La carta, mientras el pedido admita notas o todavía se pueda rearmar.
    //    Sin ella ninguna frase se anota: no poder descartar que el cliente
    //    nombró un producto es razón suficiente para no tocar el pedido.
    //
    //    `awaiting_location` entró el 05-09-2026. Solo se cargaba en
    //    `confirmed`, y eso dejaba ciegos a los detectores del cambio justo en
    //    el estado MÁS seguro para rehacer un pedido —sin ubicación, sin total,
    //    sin nada en la plancha—: quien escribía "me aumentas 2 papas" antes de
    //    mandar su pin no recibía nada, porque la lista llegaba vacía y las dos
    //    puertas devuelven `false` de entrada sin catálogo.
    const necesitaCarta =
      pedido.status === 'confirmed' || ORDER_CHANGE_STATUSES.includes(pedido.status);
    const catalogTerms = necesitaCarta ? await terminosDeLaCarta(supabase) : undefined;

    // 5. ¿Se le preguntó si le falta algo y todavía no ha contestado? Solo se
    //    consulta para el pedido que aún se puede rearmar: fuera de ahí la
    //    pregunta no se hizo y su respuesta no cambiaría nada.
    const awaitingReviewReply = ORDER_CHANGE_STATUSES.includes(pedido.status)
      ? await preguntadoHacePoco(supabase, pausa?.conversationId ?? null)
      : false;

    return {
      paused: false,
      openOrder,
      proofRemindedRecently,
      catalogTerms,
      awaitingReviewReply,
    };
  } catch {
    // Sin `error.message`: puede traer detalle técnico de Supabase.
    log.warn('webhook_customer_state_lookup_failed');
    return null;
  }
}
