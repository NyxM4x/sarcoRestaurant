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
  /** Unidades totales por cocinar. */
  totalUnits: number;
  /** Pedidos activos (nuevos + en preparacion) que alimentan el resumen. */
  activeOrders: number;
}

/**
 * Suma las cantidades de cada producto de los pedidos ACTIVOS del tablero
 * (nuevos + en preparacion) para cocinar por lotes. Un ticket completado o
 * cancelado NO suma: por eso el panel baja al completar y vuelve a subir al
 * devolver a cocina.
 *
 * Los modificadores no separan filas a proposito: el resumen responde "cuantas
 * hamburguesas van a la plancha", no como va cada una.
 *
 * Orden: cantidad descendente y, a igual cantidad, alfabetico.
 */
export function summarizeProducts(tickets: KitchenTicket[]): KitchenSummary {
  const totals = new Map<string, number>();
  let activeOrders = 0;
  let totalUnits = 0;

  for (const ticket of tickets) {
    if (!isActiveStage(ticket.stage)) continue;
    activeOrders += 1;
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

  return { rows, totalUnits, activeOrders };
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
