import 'server-only';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import { notifyHandoff } from '@/lib/alerts/handoff-notice-service';
import { createAgentStore } from '../memory/repository';
import { pauseAgentForHandoff } from '../control/handoff-pause';
import { PAUSE_REASON_HANDOFF_REQUESTED } from '../core/types';
import type { HandoffPort } from '../tools/request-human';

/**
 * Derivar una conversación a una persona — cableado server-only.
 *
 * Son dos cosas, en este orden y por este motivo:
 *
 *   1. PAUSAR — primero, para que nadie más hable encima.
 *   2. AVISAR — al equipo, best-effort.
 *
 * La pausa va antes que el aviso. Si fuera al revés y algo fallara por el
 * camino, el agente seguiría contestando a un cliente que ya pidió hablar con
 * una persona — que es exactamente el daño que esto evita.
 *
 * ── Por qué el cliente NO recibe nada ───────────────────────────────────────
 *
 * Hasta esta entrega salía un acuse ("Esto lo tiene que ver una persona del
 * equipo"). Se quitó, y no por ahorrar un mensaje: ese acuse es una promesa
 * implícita de atención que puede no cumplirse esa noche. Un cliente al que
 * nadie contesta después de habérselo anunciado se siente ignorado; uno al que
 * simplemente deja de responderle un bot vuelve a escribir, o llama.
 *
 * Es además lo que ya hacía el detector de menús (`menu-loop-service.ts`), que
 * pausa y avisa sin decirle nada a nadie. Los dos caminos de derivación se
 * comportan igual, y no hay que recordar cuál de ellos habla.
 *
 * Lo que sí sale, siempre, es la alerta a Telegram. La derivación es un aviso
 * AL EQUIPO, no un mensaje al cliente.
 */

/** Minutos que calla el agente tras derivar. */
export const HANDOFF_PAUSE_MINUTES = 120;

export function createHandoffPort(): HandoffPort {
  return {
    async escalate({ customerPhone, sourceMessageId, inboundText }) {
      const store = createAgentStore(getSupabaseAdmin());

      const pausa = await pauseAgentForHandoff(
        {
          customerPhone,
          reason: PAUSE_REASON_HANDOFF_REQUESTED,
          source: 'system',
          sourceMessageId,
          minutes: HANDOFF_PAUSE_MINUTES,
          trigger: 'agent_action',
        },
        store,
      );

      // La pausa no se pudo escribir: la conversación NO quedó derivada. Se
      // dice tal cual, y el turno sigue hasta la ronda de redacción — es el
      // único caso en que el cliente recibe algo, y es el correcto.
      if (pausa.result !== 'ok') return { handed: false };

      // Este mismo mensaje ya derivó: no se avisa dos veces al equipo. Para el
      // cliente la derivación ya ocurrió, así que el turno cierra igual.
      if (pausa.pause === 'already_applied') return { handed: true };

      // Best-effort y nunca lanza: la conversación ya está pausada, con aviso o
      // sin él. Un fallo de Telegram no puede devolverle la voz al agente.
      await notifyHandoff({
        customerPhone,
        reason: PAUSE_REASON_HANDOFF_REQUESTED,
        lastMessage: inboundText,
      });

      return { handed: true };
    },
  };
}
