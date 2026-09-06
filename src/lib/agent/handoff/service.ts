import 'server-only';
import { log } from '@/lib/log';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import { notifyHandoff } from '@/lib/alerts/handoff-notice-service';
import { createAgentStore } from '../memory/repository';
import { pauseAgentForHandoff } from '../control/handoff-pause';
import { PAUSE_REASON_HANDOFF_REQUESTED, PAUSE_REASON_HANDOFF_SPOKEN } from '../core/types';
import type { HandoffPort } from '../tools/request-human';
import { canHandOff } from './handoff-gate';
import { isExplicitHumanRequest } from './explicit-request';
import { hasProblemSignal } from './problem-signal';

/**
 * Derivar una conversación a una persona — cableado server-only.
 *
 * Son tres cosas, en este orden y por este motivo:
 *
 *   0. COMPROBAR — ¿hay un motivo en el mensaje para derivar?
 *   1. PAUSAR    — primero que el aviso, para que nadie hable encima.
 *   2. AVISAR    — al equipo, best-effort.
 *
 * El paso 0 va antes de escribir NADA. Ver `handoff-gate.ts` para los cuatro
 * falsos positivos que lo motivaron; aquí basta con saber que si no pasa, no se
 * pausa, no se avisa y no queda rastro en la base — solo un log.
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
 * Es además lo que ya hacía el detector de atasco (`stuck-customer-service.ts`),
 * que pausa y avisa sin decirle nada a nadie. Los dos caminos de derivación se
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
      const supabase = getSupabaseAdmin();

      // 0. LA PUERTA. Se decide con el mensaje delante y sin consultar nada: o
      // pide una persona con todas las letras, o trae un problema que solo una
      // persona arregla. Ver `handoff-gate.ts` para por qué dejó de contar
      // mensajes el 04-09-2026.
      const explicitRequest = isExplicitHumanRequest(inboundText);
      const problemSignal = explicitRequest ? false : hasProblemSignal(inboundText);

      if (!canHandOff({ explicitRequest, problemSignal })) {
        // El cliente NO se queda sin respuesta: `handed: false` deja el turno
        // vivo y el modelo redacta. Lo que no ocurre es la derivación.
        //
        // Sin el texto ni el teléfono: solo por qué no se derivó.
        log.info('agent.handoff_no_reason');
        return { handed: false };
      }

      const store = createAgentStore(supabase);

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

/**
 * Minutos que calla el agente después de HABER DICHO que hace falta una persona.
 *
 * 30 y no los 120 de la derivación de verdad, y la diferencia es la confianza
 * que merece cada una. La derivación real cruzó `handoff-gate`: hay una queja o
 * una petición explícita. Esto ocurre justo cuando la puerta dijo que NO, así
 * que su origen es el mismo material que produjo los falsos positivos del 04-09
 * ("😓", "?", "Okay", "Efectivo").
 *
 * El propio `handoff-gate.ts` deja escrito lo que cuesta equivocarse en esa
 * dirección: callar dos horas a quien preguntaba un precio cuesta el cliente.
 * Media hora corta el bucle —que era la queja— sin convertir un falso positivo
 * en una noche perdida, y es el mismo plazo del takeover humano: "hay una
 * persona en esto".
 */
export const HANDOFF_SPOKEN_PAUSE_MINUTES = 30;

/**
 * El agente dijo que hace falta una persona. Se calla, y se avisa.
 *
 * Corre DESPUÉS del envío, no antes: ver el hook de `core/run.ts`. Para cuando
 * esto se ejecuta, la frase ya está en el teléfono del cliente y no se puede
 * recoger.
 *
 * ── Por qué SÍ se avisa a Telegram ─────────────────────────────────────────
 *
 * Porque si no, la frase es una promesa vacía. La derivación de verdad no le
 * dice nada al cliente precisamente para no prometer nada (ver la cabecera de
 * este archivo); aquí la promesa ya salió. Un silencio sin aviso deja al
 * cliente esperando a alguien a quien nadie llamó — y en este negocio nadie
 * entra a los chats por su cuenta, así que ese alguien no aparece solo.
 *
 * Tampoco lo rescata el detector de atasco: `isStuckCustomer` devuelve `false`
 * en cuanto hay progreso, y cualquier cliente con un pedido creado lo tiene.
 *
 * El aviso se deduplica por teléfono en el outbox —la clave única es
 * `(kind, target_ref)`— así que un cliente que dispare esto tres veces produce
 * UNA alerta. Con su propio motivo, para que quien la lea sepa que puede venir
 * de una frase del modelo y no de una queja comprobada.
 *
 * NUNCA lanza: el mensaje ya salió y ningún fallo de aquí puede deshacerlo.
 */
export async function silenceAfterSpokenHandoff(input: {
  customerPhone: string;
  sourceMessageId: string;
  inboundText: string;
}): Promise<void> {
  const store = createAgentStore(getSupabaseAdmin());

  const pausa = await pauseAgentForHandoff(
    {
      customerPhone: input.customerPhone,
      reason: PAUSE_REASON_HANDOFF_SPOKEN,
      source: 'system',
      sourceMessageId: input.sourceMessageId,
      minutes: HANDOFF_SPOKEN_PAUSE_MINUTES,
      trigger: 'agent_action',
    },
    store,
  );

  // Sin pausa no se avisa: no hay nada que atender que el agente no vaya a
  // seguir atendiendo él mismo. Y si este mismo mensaje ya la puso, el aviso
  // ya salió con él.
  if (pausa.result !== 'ok' || pausa.pause === 'already_applied') return;

  await notifyHandoff({
    customerPhone: input.customerPhone,
    reason: PAUSE_REASON_HANDOFF_SPOKEN,
    lastMessage: input.inboundText,
  });
}
