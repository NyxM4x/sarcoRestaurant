import 'server-only';
import { log } from '@/lib/log';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import { getKapsoClient } from '@/lib/kapso/client';
import { notifyHandoff } from '@/lib/alerts/handoff-notice-service';
import { createAgentStore } from '../memory/repository';
import { pauseAgentForHandoff } from '../control/handoff-pause';
import { PAUSE_REASON_HANDOFF_REQUESTED } from '../core/types';
import type { HandoffPort } from '../tools/request-human';

/**
 * Derivar una conversación a una persona — cableado server-only.
 *
 * Une las tres cosas que tienen que pasar, en este orden y por este motivo:
 *
 *   1. PAUSAR   — primero, para que nadie más hable encima.
 *   2. AVISAR   — al equipo, best-effort.
 *   3. RESPONDER— al cliente, con un texto fijo y verdadero.
 *
 * ── Por qué el orden importa ────────────────────────────────────────────────
 *
 * La pausa va antes que el aviso y que la respuesta. Si fuera al final y algo
 * fallara por el camino, el agente seguiría contestando a un cliente que ya
 * pidió hablar con una persona — que es exactamente el daño que esto evita.
 *
 * Y el mensaje al cliente sale por el transporte directo, no por el puerto de
 * envío del core: ese lo frenaría la pausa que acabamos de poner. No es una
 * trampa, es la regla ya escrita en `pause-gate.ts` — las comunicaciones
 * determinísticas del sistema siguen saliendo aunque haya un humano al mando.
 */

/**
 * Lo que se le dice al cliente. Constante y deliberadamente MODESTA.
 *
 * No dice "ya avisé", no promete un plazo y no da a nadie por enterado. Así es
 * verdad aunque Telegram esté caído, aunque nadie mire el grupo esa noche y
 * aunque el equipo esté cerrando caja. Prometer una respuesta que no llega hace
 * más daño que no prometer nada.
 */
export const HANDOFF_ACK_TEXT = 'Esto lo tiene que ver una persona del equipo 🙌';

/** Minutos que calla el agente tras derivar. */
export const HANDOFF_PAUSE_MINUTES = 120;

export function createHandoffPort(): HandoffPort {
  return {
    async escalate({ customerPhone, sourceMessageId, phoneNumberId, inboundText }) {
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

      // Este mismo mensaje ya derivó: no se avisa dos veces ni se le repite al
      // cliente que lo verá una persona. Se cierra el turno igual, porque para
      // él la derivación ya ocurrió.
      if (pausa.result === 'ok' && pausa.pause === 'already_applied') {
        return { handed: true };
      }

      // Best-effort y nunca lanza: el cliente ya está a la espera de una
      // persona, con aviso o sin él.
      await notifyHandoff({
        customerPhone,
        reason: PAUSE_REASON_HANDOFF_REQUESTED,
        lastMessage: inboundText,
      });

      try {
        const enviado = await getKapsoClient().sendText(customerPhone, HANDOFF_ACK_TEXT, {
          phoneNumberId: phoneNumberId ?? undefined,
        });
        return { handed: enviado.ok };
      } catch {
        // Sin `error.message`: el transporte puede traer detalle del proveedor.
        log.warn('agent.handoff_ack_failed');
        return { handed: false };
      }
    },
  };
}
