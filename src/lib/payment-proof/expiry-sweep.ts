/**
 * El barrido de pedidos vencidos — módulo PURO.
 *
 * Decide QUÉ pedidos han agotado su ventana de gracia y deben cancelarse. No
 * escribe nada: quien lo hace es la Server Action del panel, y el barrido solo
 * responde a la pregunta.
 *
 * ── Por qué no hay cron ─────────────────────────────────────────────────────
 *
 * La expiración se DERIVA al leer: la puerta del KDS, el enrutado del intake y
 * este barrido aplican la misma regla sobre los mismos datos, así que nadie ve
 * un pedido vivo que ya venció aunque su `orders.status` todavía diga
 * `confirmed`. Materializar la cancelación es un acto aparte y explícito, y lo
 * pulsa una persona.
 *
 * Eso evita que un proceso automático cancele pedidos a las tres de la mañana
 * sin nadie mirando, y evita también depender de un servicio externo más.
 *
 * ── Y por qué NO toca lo que ya está en la plancha ──────────────────────────
 *
 * Solo se cancela lo que no ha entrado en cocina. Si alguien pulsó INICIAR
 * —cosa que hoy exige el pago aceptado, salvo con la base caída— la comida ya
 * está hecha, y cancelar el pedido no la devuelve al refrigerador: solo deja a
 * quien cocina sin saber qué estaba haciendo y sin poder cerrar el ticket.
 *
 * Es la misma regla que ya gobierna la entrada al tablero: frenar antes de
 * empezar sí, sacar algo empezado no.
 */
import type { OrderStatus, PaymentMethod } from '@/types';
import type { PaymentView } from '@/lib/dashboard/attempt-review';
import { shouldCancelForExpiry } from './payment-gate';

/**
 * Estados que el barrido puede cancelar.
 *
 * `confirmed` es el pedido esperando cocina; `awaiting_location` no llegó ni a
 * cotizarse. `preparing` y `ready` quedan fuera a propósito —ver la cabecera— y
 * `on_the_way`, `delivered` y `cancelled` ni se plantean.
 */
export const SWEEPABLE_STATUSES: readonly OrderStatus[] = ['confirmed', 'awaiting_location'];

/** Un pedido candidato, con lo justo para decidir. */
export interface ExpiryCandidate {
  orderId: string;
  orderNumber: string;
  status: OrderStatus;
  paymentMethod: PaymentMethod | null;
  /** Su pago. `null` = no se pudo leer, y entonces NO se cancela. */
  payment: PaymentView | null;
}

/**
 * Los pedidos que deben cancelarse ahora mismo.
 *
 * Un pago que no se pudo consultar NUNCA cancela: `shouldCancelForExpiry`
 * devuelve `false` ante `unknown`. Abrir la puerta ante la duda y cancelar ante
 * la duda son cosas opuestas, y solo la primera es segura.
 */
export function selectExpiredOrders(
  candidates: readonly ExpiryCandidate[],
  nowMs: number,
): ExpiryCandidate[] {
  return candidates.filter(
    (c) =>
      SWEEPABLE_STATUSES.includes(c.status) &&
      shouldCancelForExpiry(c.paymentMethod, c.payment, nowMs),
  );
}
