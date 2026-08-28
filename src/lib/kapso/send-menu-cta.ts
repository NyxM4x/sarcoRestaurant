import 'server-only';
import { getKapsoClient } from './client';
import { menuCtaBodyText } from './messages';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import { createMenuSessionWithUrl } from '@/lib/menu/session-service';
import { createMenuDeliveryStore } from '@/lib/menu/delivery-repository';
import { dispatchMenu, type MenuDispatchDeps } from '@/lib/menu/dispatch';
import { createMenuAutomationMemory } from '@/lib/agent/service';
import type { SendMenuCta } from '@/lib/webhook/kapso';

/**
 * Cableado real del envío del CTA "Ver menú" (server-only).
 *
 * Desde 6D.2F.5A este archivo ya no orquesta nada: solo conecta las piezas al
 * Shared Menu Dispatch, que es la única autoridad sobre el efecto. La secuencia
 * —política, sesión, claim, envío, cierre, memoria— vive en `menu/dispatch`,
 * probada sin red y sin Supabase.
 *
 * Cuando en 6D.2F.5B exista `send_menu()`, entrará por esta misma función de
 * despacho con `reason: 'agent_suggestion'`. No habrá un segundo camino.
 *
 * REQUISITO OPERATIVO: la migración 0015 debe estar aplicada. Sin la tabla
 * `menu_send_deliveries` el claim lanza y el evento queda `failed`
 * (reintentable): se prefiere no enviar el menú antes que enviarlo sin control
 * de idempotencia.
 */
/**
 * Dependencias reales del despacho, en un solo sitio.
 *
 * Lo usan las DOS puertas: la ruta determinística de aquí abajo y la tool
 * `send_menu()` del agente (6D.2F.5B). Si cada una construyera las suyas,
 * "una sola autoridad sobre el efecto" duraría hasta el primer despiste.
 */
export function createMenuDispatchDeps(): MenuDispatchDeps {
  return {
    deliveries: createMenuDeliveryStore(getSupabaseAdmin()),

    session: {
      async createUrl({ sourceMessageId: id, customerPhone, phoneNumberIdFromEvent }) {
        // Comportamiento intacto (6D.2E): reutiliza la sesión vigente no
        // consumida y, si no la hay, crea una con token reproducible.
        const created = await createMenuSessionWithUrl({
          source_message_id: id,
          customer_phone: customerPhone,
          phone_number_id_from_event: phoneNumberIdFromEvent,
        });
        return {
          sessionUrl: created.session_url,
          effectivePhoneNumberId: created.effective_phone_number_id,
        };
      },
    },

    send: {
      // El phone_number_id resuelto es el mismo que se persistió en
      // `menu_sessions`: se envía por el número por el que llegó.
      // El copy se resuelve AQUÍ, en el borde: `dispatchMenu` decide que hay que
      // mandar el menú y por qué; qué palabras acompañan al botón es del canal.
      sendCta: ({ customerPhone, menuUrl, phoneNumberId: from, reason }) =>
        getKapsoClient().sendMenuCtaUrl(customerPhone, {
          phoneNumberId: from,
          menuUrl,
          bodyText: menuCtaBodyText(reason),
        }),
    },

    memory: createMenuAutomationMemory(),
  };
}

export const sendMenuCtaMessage: SendMenuCta = async ({
  toDigits,
  phoneNumberId,
  sourceMessageId,
  reason,
}) => {
  if (!sourceMessageId) {
    throw new Error('sendMenuCta: sourceMessageId required for idempotence');
  }

  return dispatchMenu(
    { customerPhone: toDigits, sourceMessageId, phoneNumberId, reason },
    createMenuDispatchDeps(),
  );
};
