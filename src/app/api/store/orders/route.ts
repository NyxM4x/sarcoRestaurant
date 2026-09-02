import { after } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import { createMenuSessionRepository } from '@/lib/menu/session-repository';
import {
  createNotificationScheduler,
  handleCreateWebOrder,
  type CreateOrderWebOutcome,
  type CreateOrderWebParams,
  type CreateOrderWebRow,
  type WebCheckoutDeps,
} from '@/lib/orders/web-checkout';
import {
  dispatchExistingWebOrderWhatsApp,
  initializeAndDispatchWebOrderWhatsApp,
} from '@/lib/orders/notifications/service';

// Requiere APIs de Node (crypto, service_role) — no Edge. Siempre dinámico.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// El envío por WhatsApp corre en `after()`, ya enviada la respuesta: se da
// margen para que la función siga viva mientras termina.
export const maxDuration = 60;

/**
 * POST /api/store/orders
 *
 * Checkout web: convierte el carrito del navegador en un pedido real.
 *
 * La ruta solo cablea dependencias. La lógica vive en
 * `@/lib/orders/web-checkout` (testeable sin base de datos) y la escritura
 * completa ocurre dentro de la RPC `public.create_order_web_v4`, que corre en
 * una sola transacción. Aquí no hay ningún INSERT ni UPDATE directo.
 */
function buildDeps(): WebCheckoutDeps {
  const supabase = getSupabaseAdmin();

  return {
    /**
     * `findValidIdByHash` filtra por `expires_at > now()` y proyecta solo `id`:
     * el teléfono, el `phone_number_id` y el `token_hash` no llegan a esta capa
     * ni siquiera en memoria. La RPC lee el teléfono desde `menu_sessions`.
     */
    async findSessionIdByTokenHash(tokenHash: string): Promise<string | null> {
      return createMenuSessionRepository(supabase).findValidIdByHash(tokenHash);
    },

    async callCreateOrderWeb(params: CreateOrderWebParams): Promise<CreateOrderWebOutcome> {
      // 0032 — create_order_web_v4: la firma de v3 más `p_promotions_json`. El
      // servidor deriva delivery_pricing='dynamic' para delivery y relee el
      // precio de cada combo; el cliente NO envía ninguno de los dos. v3 y las
      // anteriores siguen existiendo (rollout sin downtime), pero este código ya
      // no las invoca.
      const { data, error } = await supabase.rpc('create_order_web_v4', params);

      // `error.code` es el SQLSTATE de la RPC (P1001/P1002/P1003/P1004/22023).
      if (error) {
        return { data: null, errorCode: error.code ?? null, errorMessage: error.message ?? null };
      }
      if (!data) return { data: null, errorCode: null };

      return { data: data as CreateOrderWebRow, errorCode: null };
    },

    /**
     * Notificación por WhatsApp DESPUÉS de la respuesta, vía `after()`.
     *
     * `created:true` inicializa y despacha; `created:false` solo despacha lo ya
     * existente, de modo que un reintento nunca crea notificaciones para pedidos
     * previos a esta función.
     */
    scheduleNotificationDispatch: createNotificationScheduler(after, {
      initializeAndDispatch: initializeAndDispatchWebOrderWhatsApp,
      dispatchExisting: dispatchExistingWebOrderWhatsApp,
    }),
  };
}

export async function POST(request: Request): Promise<Response> {
  return handleCreateWebOrder(request, buildDeps());
}
