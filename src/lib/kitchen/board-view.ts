import type { KitchenTicket } from './ticket-view';
import { isActiveStage } from './kds-status';

/**
 * QUÉ VE CADA PANTALLA DEL KDS — módulo PURO (07-09-2026).
 *
 * ── De qué viene ────────────────────────────────────────────────────────────
 *
 * El local trabajaba con UNA laptop, así que una sola pantalla hacía las dos
 * cosas: verificar comprobantes y cocinar. Con dos pantallas cada una puede
 * hacer una, y el trabajo se separa donde ya estaba separado de hecho — quien
 * mira un comprobante no está en la plancha.
 *
 *   CAJA      el pedido llegó y su pago está sin confirmar. Se mira el
 *             comprobante y se acepta o se rechaza. Al aceptarlo, ese ticket
 *             desaparece de aquí.
 *   PLANCHA   el pedido ya se puede cocinar: o su pago está aceptado, o no
 *             tiene ninguno que aceptar. Es donde vive INICIAR y COMPLETAR.
 *
 * ── La partición es del DATO, no de la pantalla ─────────────────────────────
 *
 * `awaitingPaymentConfirmation` ya viajaba en el ticket y ya decidía si sus
 * unidades contaban en el resumen del planchero. Es exactamente la misma
 * pregunta —"¿este pago ya está confirmado?"— así que se reutiliza en vez de
 * inventar un segundo criterio. Dos formas de decidir lo mismo se separarían el
 * día que una se retoque, y ahí un pedido dejaría de estar en las dos pantallas.
 *
 * ── El efectivo no pasa por caja, y no es un olvido ─────────────────────────
 *
 * `awaitingPaymentConfirmation` es `false` para todo lo que no se paga por QR:
 * en efectivo se cobra en la puerta y no hay ningún comprobante que aceptar.
 * Mandarlo a caja sería poner delante del cajero un ticket sobre el que no
 * puede hacer nada, y retrasar una comida por un paso que no existe.
 *
 * ── Y una pantalla caída no puede esconder pedidos ──────────────────────────
 *
 * Cuando no se pudieron consultar los pagos, `awaitingPaymentConfirmation` vale
 * `false` para todos: el tablero no afirma que falte confirmar lo que no pudo
 * mirar. El efecto aquí es que TODO va a plancha y caja se queda vacía — la
 * dirección segura, porque la comida se sigue viendo. La pantalla lo dice con
 * el mismo aviso ámbar que ya existe. Lo que no puede pasar nunca es lo
 * contrario: un ticket que no salga en ninguna de las dos.
 */
export type BoardView =
  /** Las dos cosas en una pantalla. Es el KDS de siempre, con una sola laptop. */
  | 'full'
  /** Solo lo que espera que alguien mire su comprobante. */
  | 'cashier'
  /** Solo lo que ya se puede cocinar. */
  | 'line';

/**
 * ¿Este ticket le toca a caja?
 *
 * Sin mirar la etapa a propósito. Un pedido que llegó a `in_progress` con el
 * pago aún sin confirmar —la puerta se abre igual cuando no se pudieron
 * consultar los pagos, para no parar la cocina— sigue siendo trabajo del
 * cajero: es justo el que hay que resolver, no el que hay que esconder.
 */
export function isCashierTicket(ticket: KitchenTicket): boolean {
  return ticket.awaitingPaymentConfirmation;
}

/**
 * Los tickets que le corresponden a una pantalla.
 *
 * `full` devuelve la lista entera y sin tocar: la pantalla que hay hoy en
 * producción tiene que seguir comportándose exactamente igual, y la forma de
 * garantizarlo es que su camino no tenga ningún filtro nuevo.
 *
 * Los `done` y los `cancelled` se reparten como los activos —el panel de
 * "Listos" lo lee quien cocina— y por eso el filtro NO mira la etapa: la
 * decisión es del pago, y la etapa ya la resuelven `gridTickets` y
 * `readyTickets` aguas abajo.
 */
export function ticketsForView(tickets: KitchenTicket[], view: BoardView): KitchenTicket[] {
  if (view === 'full') return tickets;
  if (view === 'cashier') return tickets.filter(isCashierTicket);
  return tickets.filter((t) => !isCashierTicket(t));
}

/**
 * ¿Puede esta pantalla mover el pedido por la cocina?
 *
 * En caja NO. Su única acción es sobre el pago: enseñarle además INICIAR y
 * CANCELAR sería darle dos trabajos y la posibilidad de tirar un pedido que
 * todavía no ha mirado nadie en la plancha. Ver `KitchenTicketCard`.
 */
export function canAdvanceStage(view: BoardView): boolean {
  return view !== 'cashier';
}

/**
 * ¿Puede esta pantalla decidir sobre el pago?
 *
 * En plancha SÍ, y es deliberado: mientras haya una sola laptop `full` hace las
 * dos cosas, y el día que el cajero no esté, quien cocina tiene que poder
 * desatascar un pedido sin cambiar de pantalla. Lo que cambia entre vistas es
 * QUÉ tickets llegan a cada una, no lo que se puede hacer con los que llegan.
 */
export function canReviewPayment(): boolean {
  return true;
}

/** Lo que se lee en la barra superior de cada pantalla. */
export const VIEW_LABELS: Record<BoardView, string> = {
  full: 'Cocina',
  cashier: 'Caja',
  line: 'Cocina',
};

/**
 * Qué se dice cuando no hay nada que hacer, que no es lo mismo en cada
 * pantalla: una caja vacía es una buena noticia (nadie espera revisión), y una
 * plancha vacía también, pero por otra razón.
 */
export const EMPTY_MESSAGES: Record<BoardView, { title: string; hint: string }> = {
  full: {
    title: 'No hay pedidos en cocina',
    hint: 'Los pedidos confirmados aparecerán aquí automáticamente.',
  },
  cashier: {
    title: 'No hay pagos por revisar',
    hint: 'Cuando llegue un comprobante, el pedido aparecerá aquí.',
  },
  line: {
    title: 'No hay pedidos en cocina',
    hint: 'Los pedidos aparecerán aquí en cuanto caja acepte su pago.',
  },
};
