import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import { log } from '@/lib/log';
import { notifyHandoff } from '@/lib/alerts/handoff-notice-service';
import { createAgentStore } from '../memory/repository';
import { pauseAgentForHandoff } from '../control/handoff-pause';
import { PAUSE_REASON_HANDOFF_MENU_LOOP } from '../core/types';
import { isMenuLoop, MENU_LOOP_WINDOW_MINUTES } from './menu-loop';

/**
 * Detección del cliente atascado — wiring server-only.
 *
 * Corre DESPUÉS de que el menú haya salido, nunca antes: a quien pide el menú
 * no se le niega jamás. Lo que se decide aquí es si además hay que despertar a
 * una persona, porque a la tercera vez el problema ya no lo arregla otro botón.
 *
 * Best-effort en todo: si la consulta falla, no pasa nada. El cliente tiene su
 * menú y el turno terminó bien; perder una alerta es recuperable, tumbar el
 * envío del menú por una consulta de contabilidad no lo sería.
 */
export async function escalateIfMenuLoop(
  customerPhone: string,
  supabase: SupabaseClient = getSupabaseAdmin(),
): Promise<void> {
  try {
    const desde = new Date(Date.now() - MENU_LOOP_WINDOW_MINUTES * 60_000).toISOString();

    // Los menús que de verdad llegaron. `status='sent'` importa: un envío
    // fallido no es un intento del cliente que haya quedado sin fruto.
    const { data: envios, error } = await supabase
      .from('menu_send_deliveries')
      .select('source_message_id')
      .eq('customer_phone', customerPhone)
      .eq('status', 'sent')
      .gte('completed_at', desde)
      .limit(20);
    if (error || !envios) return;

    const wamids = envios
      .map((e) => (e as { source_message_id: string | null }).source_message_id)
      .filter((w): w is string => typeof w === 'string' && w !== '');
    if (wamids.length === 0) return;

    // ¿Alguno de esos mensajes acabó en un pedido? El cruce va por WAMID
    // porque `orders.customer_phone` no está normalizado y compararlo daría
    // falsos negativos — diría que no pidió nunca alguien que pidió tres veces.
    const { data: pedidos, error: errorPedidos } = await supabase
      .from('orders')
      .select('id')
      .in('source_message_id', wamids)
      .limit(1);
    if (errorPedidos) return;

    if (!isMenuLoop({ sends: wamids.length, hasOrder: (pedidos ?? []).length > 0 })) return;

    const store = createAgentStore(getSupabaseAdmin());
    const pausa = await pauseAgentForHandoff(
      {
        customerPhone,
        reason: PAUSE_REASON_HANDOFF_MENU_LOOP,
        source: 'system',
        // El último menú enviado es la clave de idempotencia: mientras no salga
        // otro, esta detección no vuelve a avisar por lo mismo.
        sourceMessageId: wamids[wamids.length - 1],
        minutes: 120,
        trigger: 'menu_loop',
      },
      store,
    );
    if (pausa.result !== 'ok' || pausa.pause === 'already_applied') return;

    await notifyHandoff({
      customerPhone,
      reason: PAUSE_REASON_HANDOFF_MENU_LOOP,
      // Aquí no hay una queja que citar: el problema es lo que NO pasó.
      lastMessage: null,
    });
    log.info('agent.menu_loop_escalated', { sends: wamids.length });
  } catch {
    // Contabilidad: no puede tumbar un turno que ya entregó el menú.
    log.warn('agent.menu_loop_check_failed');
  }
}
