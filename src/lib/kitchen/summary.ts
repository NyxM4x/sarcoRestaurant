/**
 * Contadores y resumen de cocina — modulo PURO.
 *
 * TODOS los numeros de la pantalla salen de aqui, derivados de una unica fuente
 * de verdad: la lista de tickets. No hay contadores guardados aparte que haya
 * que sincronizar a mano — que es justo donde aparecen los numeros "estaticos"
 * que nunca se restan.
 */
import { isActiveStage } from './kds-status';
import type { KitchenTicket } from './ticket-view';

export interface KitchenCounters {
  /**
   * Pedidos de la jornada. Los cancelados NO cuentan, y no baja al completar:
   * un pedido listo sigue siendo un pedido del dia.
   */
  today: number;
  /** Nuevos, aun sin empezar. */
  pending: number;
  inProgress: number;
  done: number;
}

/** Contadores de la barra superior, derivados de los tickets. */
export function countersFrom(tickets: KitchenTicket[]): KitchenCounters {
  let pending = 0;
  let inProgress = 0;
  let done = 0;
  let today = 0;
  for (const t of tickets) {
    if (t.stage === 'cancelled') continue; // un cancelado no cuenta en ninguna cifra
    today += 1;
    if (t.stage === 'new') pending += 1;
    else if (t.stage === 'in_progress') inProgress += 1;
    else if (t.stage === 'done') done += 1;
  }
  return { today, pending, inProgress, done };
}

export interface KitchenSummaryRow {
  name: string;
  quantity: number;
}

export interface KitchenSummary {
  rows: KitchenSummaryRow[];
  /** Unidades totales por cocinar, ya en firme. */
  totalUnits: number;
  /** Pedidos que alimentan el resumen. */
  countedOrders: number;
  /** Pedidos activos retenidos por un pago que nadie ha confirmado todavía. */
  awaitingOrders: number;
  /** Unidades que entrarán al total en cuanto se confirmen esos pagos. */
  awaitingUnits: number;
}

/**
 * ¿Las unidades de este ticket son trabajo EN FIRME para la plancha?
 *
 * Dos condiciones, y la segunda es la que trajo esta regla:
 *
 *   1. Sigue ocupando cocina (nuevo o en preparación). Un completado o un
 *      cancelado no se cocina.
 *   2. Su pago ya está confirmado.
 *
 * ── Por qué el pago decide el total ────────────────────────────────────────
 *
 * Quien mira la barra derecha es el planchero, y lo que lee ahí es cuánto poner
 * a la plancha AHORA. Desde que cocina revisa los comprobantes, un pedido puede
 * llegar al tablero con un pago que después se rechaza —comprobantes retocados
 * son cosa corriente aquí—, y hasta ese momento sus hamburguesas inflaban el
 * total. El planchero cocinaba de más, y lo de más se tira.
 *
 * El ticket se sigue viendo entero, con su comprobante y sus botones: lo que
 * espera es el CONTEO, no la comanda.
 *
 * ── Excepto si ya está en la plancha ───────────────────────────────────────
 *
 * Un ticket en preparación cuenta SIEMPRE, con el pago confirmado o sin él.
 * Alguien pulsó INICIAR: la comida se está haciendo, y un total que no la
 * incluye le miente al planchero en la dirección contraria —le diría que le
 * queda menos trabajo del que ya tiene en la mano—. Es la misma regla que ya
 * gobierna la entrada al tablero: el pago frena lo que aún no ha empezado, y
 * nunca retira lo que ya está andando.
 */
export function isFirmWork(ticket: KitchenTicket): boolean {
  if (!isActiveStage(ticket.stage)) return false;
  if (ticket.stage === 'in_progress') return true;
  return !ticket.awaitingPaymentConfirmation;
}

/**
 * Suma las cantidades de cada producto de los pedidos que ya son trabajo en
 * firme (ver `isFirmWork`) para cocinar por lotes. Un ticket completado,
 * cancelado o con el pago sin confirmar NO suma: por eso el panel baja al
 * completar, vuelve a subir al devolver a cocina, y no se adelanta a la
 * decisión del comprobante.
 *
 * Lo retenido no se esconde: viaja aparte en `awaitingOrders`/`awaitingUnits`,
 * para que el panel pueda decir cuánto hay a la espera. Un total que baja sin
 * explicación se lee como un fallo de la pantalla, y entonces se deja de creer
 * también cuando acierta.
 *
 * Los modificadores no separan filas a proposito: el resumen responde "cuantas
 * hamburguesas van a la plancha", no como va cada una.
 *
 * Orden: cantidad descendente y, a igual cantidad, alfabetico.
 */
export function summarizeProducts(tickets: KitchenTicket[]): KitchenSummary {
  const totals = new Map<string, number>();
  let countedOrders = 0;
  let totalUnits = 0;
  let awaitingOrders = 0;
  let awaitingUnits = 0;

  for (const ticket of tickets) {
    if (!isActiveStage(ticket.stage)) continue;

    const unidades = ticket.lines.reduce(
      (acc, line) => acc + (Number.isFinite(line.quantity) && line.quantity > 0 ? line.quantity : 0),
      0,
    );

    if (!isFirmWork(ticket)) {
      awaitingOrders += 1;
      awaitingUnits += unidades;
      continue;
    }

    countedOrders += 1;
    for (const line of ticket.lines) {
      const qty = Number.isFinite(line.quantity) ? line.quantity : 0;
      if (qty <= 0) continue;
      totals.set(line.name, (totals.get(line.name) ?? 0) + qty);
      totalUnits += qty;
    }
  }

  const rows = [...totals.entries()]
    .map(([name, quantity]) => ({ name, quantity }))
    .sort((a, b) => b.quantity - a.quantity || a.name.localeCompare(b.name, 'es'));

  return { rows, totalUnits, countedOrders, awaitingOrders, awaitingUnits };
}

/** Tickets que se pintan en el grid central (los listos viven en el historial). */
export function gridTickets(tickets: KitchenTicket[]): KitchenTicket[] {
  return tickets.filter((t) => isActiveStage(t.stage));
}

/** Historial de "Listos": lo ultimo completado primero. */
export function readyTickets(tickets: KitchenTicket[]): KitchenTicket[] {
  const key = (t: KitchenTicket): number => {
    const ms = Date.parse(t.completedAt ?? t.enteredAt);
    return Number.isNaN(ms) ? 0 : ms;
  };
  return tickets.filter((t) => t.stage === 'done').sort((a, b) => key(b) - key(a));
}
