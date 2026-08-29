import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import { log } from '@/lib/log';
import { notifyHandoff } from '@/lib/alerts/handoff-notice-service';
import { createAgentStore } from '../memory/repository';
import { pauseAgentForHandoff } from '../control/handoff-pause';
import { PAUSE_REASON_HANDOFF_STUCK } from '../core/types';
import { isStuckCustomer, STUCK_WINDOW_MINUTES } from './stuck-customer';
import { HANDOFF_PAUSE_MINUTES } from './service';

/**
 * Detección del cliente atascado — wiring server-only.
 *
 * Corre una vez por entrega del webhook, DESPUÉS de que los mensajes estén
 * persistidos y con independencia de quién los atendió. Eso es deliberado: la
 * versión anterior colgaba del despacho del menú, así que solo veía a los
 * clientes que pedían el menú una y otra vez — y el que se traba preguntando
 * por el envío, o mandando un link de Google Maps en vez del pin, era
 * invisible. Justo el que más ayuda necesita.
 *
 * Best-effort en todo: si una consulta falla, no pasa nada. La conversación
 * siguió su curso y perder una alerta es recuperable; tumbar la entrega de un
 * webhook por una consulta de contabilidad no lo sería.
 */

/** Cuánto atrás cuenta un avance. Más ancho que la ventana de mensajes. */
const AVANCE_WINDOW_HOURS = 24;

/**
 * ¿Consta algún AVANCE de este cliente? `null` = no se pudo averiguar.
 *
 * Tres caminos, y hacen falta los tres porque un pedido puede nacer de dos
 * sitios distintos y un pago deja su propia huella:
 *
 *   1. Pedido desde el MENÚ WEB → `orders.menu_session_id` apunta a una sesión
 *      cuyo `customer_phone` sí está normalizado. Es el camino que faltaba: la
 *      RPC del checkout inserta `source_message_id` en NULL, así que cruzarlo
 *      por ahí no encontraba nunca nada.
 *   2. Pedido por el FLOW → ese sí lleva el WAMID del mensaje del cliente.
 *   3. COMPROBANTE recibido → se cruza por el WAMID de la imagen. Quien mandó
 *      un comprobante llegó hasta el final; llamarlo atascado es absurdo.
 *
 * Se mira 24 h atrás y no los 30 minutos de la ventana de mensajes: un pedido
 * hecho hace una hora sigue siendo prueba de que el sistema le funciona.
 */
async function tieneAvance(
  supabase: SupabaseClient,
  customerPhone: string,
  wamids: readonly string[],
): Promise<boolean | null> {
  const desde = new Date(Date.now() - AVANCE_WINDOW_HOURS * 60 * 60 * 1000).toISOString();

  // 1. Pedidos nacidos de una sesión de menú de este teléfono.
  const { data: sesiones, error: errorSesiones } = await supabase
    .from('menu_sessions')
    .select('id')
    .eq('customer_phone', customerPhone)
    .gte('created_at', desde)
    .limit(20);
  if (errorSesiones) return null;

  const sessionIds = (sesiones ?? []).map((s) => (s as { id: string }).id);
  if (sessionIds.length > 0) {
    const { data: pedidos, error } = await supabase
      .from('orders')
      .select('id')
      .in('menu_session_id', sessionIds)
      .limit(1);
    if (error) return null;
    if ((pedidos ?? []).length > 0) return true;
  }

  if (wamids.length === 0) return false;

  // 2. Pedidos que sí llevan el WAMID (los que entran por el Flow).
  const { data: porWamid, error: errorWamid } = await supabase
    .from('orders')
    .select('id')
    .in('source_message_id', wamids)
    .limit(1);
  if (errorWamid) return null;
  if ((porWamid ?? []).length > 0) return true;

  // 3. Comprobantes de pago.
  const { data: comprobantes, error: errorProof } = await supabase
    .from('payment_proofs')
    .select('id')
    .in('source_message_id', wamids)
    .limit(1);
  if (errorProof) return null;

  return (comprobantes ?? []).length > 0;
}

/**
 * ¿Hay que avisar al equipo por este cliente? Nunca lanza.
 *
 * No manda ningún mensaje al cliente, igual que la derivación del modelo: ver
 * `service.ts` para por qué el silencio es preferible a un acuse que promete
 * una atención que puede no llegar.
 */
export async function escalateIfStuck(
  customerPhone: string,
  supabase: SupabaseClient = getSupabaseAdmin(),
): Promise<void> {
  try {
    const desde = new Date(Date.now() - STUCK_WINDOW_MINUTES * 60_000).toISOString();

    const { data: conv, error: errConv } = await supabase
      .from('agent_conversations')
      .select('id, state')
      .eq('customer_phone', customerPhone)
      .maybeSingle();
    if (errConv || !conv) return;

    const conversacion = conv as { id: string; state: string };
    // Ya pausada: alguien está a cargo, o esta misma detección ya avisó. Se
    // corta aquí para no volver a escribir por lo mismo en cada mensaje nuevo.
    if (conversacion.state !== 'active') return;

    // Los mensajes que ESCRIBIÓ el cliente. Su WAMID viaja también, porque es
    // la única clave con la que se puede preguntar si alguno acabó en pedido.
    const { data: mensajes, error } = await supabase
      .from('agent_messages')
      .select('provider_message_id')
      .eq('agent_conversation_id', conversacion.id)
      .eq('actor', 'customer')
      .gte('message_timestamp', desde)
      .order('message_timestamp', { ascending: true })
      .limit(40);
    if (error || !mensajes) return;

    const wamids = mensajes
      .map((m) => (m as { provider_message_id: string | null }).provider_message_id)
      .filter((w): w is string => typeof w === 'string' && w !== '');

    // ── ¿Consta algún AVANCE? ────────────────────────────────────────────
    //
    // El cruce iba SOLO por `orders.source_message_id`, y el checkout web lo
    // inserta NULL (ver la RPC de 0003): ningún pedido hecho desde el menú
    // contaba como progreso, así que la puerta nunca cerraba. El 29-08-2026
    // eso disparó una alerta sobre un pedido que acabó pagado.
    //
    // El camino bueno es `menu_sessions`, cuyo `customer_phone` SÍ está
    // normalizado —lo escribe el webhook con los mismos dígitos— y al que el
    // pedido apunta por `menu_session_id`. El cruce por WAMID se conserva
    // además, porque un pedido que entra por el Flow sí lo lleva.
    const hasProgress = await tieneAvance(supabase, customerPhone, wamids);
    if (hasProgress === null) return;

    // Menús que le llegaron. Sin ninguno no está atascado: está empezando.
    const { count: menusSent, error: errorMenus } = await supabase
      .from('menu_send_deliveries')
      .select('id', { count: 'exact', head: true })
      .eq('customer_phone', customerPhone)
      .eq('status', 'sent')
      .gte('completed_at', desde);
    if (errorMenus) return;

    if (
      !isStuckCustomer({
        messages: mensajes.length,
        menusSent: menusSent ?? 0,
        hasProgress,
      })
    ) {
      return;
    }

    const store = createAgentStore(supabase);
    const pausa = await pauseAgentForHandoff(
      {
        customerPhone,
        reason: PAUSE_REASON_HANDOFF_STUCK,
        source: 'system',
        // El último mensaje del cliente es la clave de idempotencia. La guarda
        // de arriba (`state !== 'active'`) ya evita el aviso repetido; esta es
        // la red por si dos entregas del webhook corren a la vez.
        sourceMessageId: wamids[wamids.length - 1] ?? null,
        minutes: HANDOFF_PAUSE_MINUTES,
        trigger: 'stuck_customer',
      },
      store,
    );
    // Solo se avisa cuando la pausa la puso ESTA ejecución. `already_paused` y
    // `already_applied` significan que el equipo ya se enteró.
    if (pausa.result !== 'ok' || pausa.pause !== 'paused') return;

    await notifyHandoff({
      customerPhone,
      reason: PAUSE_REASON_HANDOFF_STUCK,
      // Aquí no hay una queja que citar: el problema es lo que NO pasó.
      lastMessage: null,
    });
    log.info('agent.stuck_customer_escalated', { messages: mensajes.length });
  } catch {
    // Contabilidad: no puede tumbar una entrega que ya se atendió.
    log.warn('agent.stuck_customer_check_failed');
  }
}
