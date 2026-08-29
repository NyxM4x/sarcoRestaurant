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

    // ¿Alguno de esos mensajes acabó en un pedido? El cruce va por WAMID
    // porque `orders.customer_phone` no está normalizado y compararlo daría
    // falsos negativos — diría que no pidió nunca alguien que pidió tres veces.
    let hasOrder = false;
    if (wamids.length > 0) {
      const { data: pedidos, error: errorPedidos } = await supabase
        .from('orders')
        .select('id')
        .in('source_message_id', wamids)
        .limit(1);
      if (errorPedidos) return;
      hasOrder = (pedidos ?? []).length > 0;
    }

    if (!isStuckCustomer({ messages: mensajes.length, hasOrder })) return;

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
