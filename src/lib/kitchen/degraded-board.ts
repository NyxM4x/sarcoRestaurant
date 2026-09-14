import type { KitchenTicket } from './ticket-view';
import type { KitchenBoard } from './tickets-repository';

/**
 * Qué pinta la tablet cuando el servidor no pudo leer los pagos (13-09-2026).
 *
 * ── El parpadeo ─────────────────────────────────────────────────────────────
 *
 * Un pedido por QR entra al tablero cuando llega su comprobante. Si una
 * respuesta viene sin pagos (`paymentsAvailable: false`), el servidor no puede
 * saber quién pagó y deja entrar a todos: ante la duda, entran. El ciclo
 * siguiente sí consulta y los vuelve a sacar. En la pantalla eso eran comandas
 * sin pagar apareciendo y desapareciendo cada diez segundos —`ORD-260913-017` y
 * `-021`—, con el aviso amarillo encendiéndose y apagándose detrás.
 *
 * ── La regla ────────────────────────────────────────────────────────────────
 *
 * Una respuesta degradada no borra lo que se sabía hace un momento. Mientras la
 * última respuesta buena sea reciente:
 *
 *   - lo que ya estaba a la vista sigue, con la etapa de ahora y el pago que se
 *     le conocía;
 *   - lo que no estaba solo entra si no depende de un comprobante: en efectivo
 *     (el servidor ya filtra el que no tiene CONFIRMO, sin mirar pagos) o ya
 *     empezado en otra tablet;
 *   - un pedido por QR nuevo espera al siguiente ciclo bueno.
 *
 * Pasado `DEGRADED_GRACE_MS` sin ninguna respuesta buena vuelve la regla de
 * siempre, con el aviso: una caída larga no puede dejar a la cocina sin
 * comandas.
 */
export const DEGRADED_GRACE_MS = 2 * 60_000;

/** La última respuesta con los pagos leídos, y cuándo llegó (reloj del navegador). */
export interface LastGoodBoard {
  tickets: KitchenTicket[];
  atMs: number;
}

export interface BoardToShow {
  tickets: KitchenTicket[];
  /** `false` enciende el aviso de pagos sin verificar. */
  paymentsAvailable: boolean;
}

export function boardToShow(
  board: Pick<KitchenBoard, 'tickets' | 'paymentsAvailable'>,
  lastGood: LastGoodBoard | null,
  nowMs: number,
): BoardToShow {
  if (board.paymentsAvailable) return { tickets: board.tickets, paymentsAvailable: true };

  const reciente = lastGood !== null && nowMs - lastGood.atMs <= DEGRADED_GRACE_MS;
  if (!reciente) return { tickets: board.tickets, paymentsAvailable: false };

  const conocidos = new Map(lastGood.tickets.map((t) => [t.orderNumber, t]));
  const tickets: KitchenTicket[] = [];
  for (const t of board.tickets) {
    const antes = conocidos.get(t.orderNumber);
    if (antes) {
      // Etapa, líneas y notas no dependen del pago: son las de ahora. Lo que sale
      // del pago viene de la última lectura buena, no del "no lo sé" de esta.
      tickets.push({
        ...t,
        payment: antes.payment,
        gate: antes.gate,
        amountLabel: antes.amountLabel,
        awaitingPaymentConfirmation: antes.awaitingPaymentConfirmation,
        deliveryCollect: antes.deliveryCollect,
      });
      continue;
    }
    if (t.paysCash || t.stage !== 'new') tickets.push(t);
  }
  // Lo pintado es la lectura buena de hace menos de dos minutos: no hay nada sin
  // verificar que avisar.
  return { tickets, paymentsAvailable: true };
}
