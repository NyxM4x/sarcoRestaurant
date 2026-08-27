/**
 * Sanitizacion del ticket de cocina — modulo PURO.
 *
 * El cocinero ve lo justo para cocinar: numero de pedido, cuando entro a
 * cocina, etapa, tipo de entrega, los platos y las notas. NUNCA telefono,
 * direccion ni coordenadas. No es solo que la pantalla no los pinte: es que no
 * viajan en la respuesta.
 *
 * ── Por que el TOTAL si viaja ahora ─────────────────────────────────────────
 *
 * Desde que cocina revisa los comprobantes, el total dejo de ser un dato
 * administrativo y paso a ser una herramienta de trabajo: sin el, mirar un
 * comprobante no es validarlo. Se puede aceptar un pago de Bs 20 para un pedido
 * de Bs 64 y nadie lo nota hasta el cierre de caja.
 *
 * Viaja el TOTAL y nada mas. Ni subtotal, ni costo de envio, ni desglose: lo
 * unico que hace falta para contrastar el monto del comprobante. La lista sigue
 * siendo corta a proposito — se amplio por una razon concreta, no se abrio.
 */
import type { OrderStatus, DeliveryType } from '@/types';
import type { PaymentView } from '@/lib/dashboard/attempt-review';
import { stageFromOrderStatus, type KdsStage } from './kds-status';

/** Fila cruda minima de `orders` (mas `id`, solo para unir los items server-side). */
export interface RawKitchenOrderRow {
  id: string;
  order_number: string;
  status: OrderStatus;
  delivery_type: DeliveryType;
  notes: string | null;
  created_at: string;
  /** Instante en que el pedido quedo confirmado; base de la antiguedad en cocina. */
  confirmed_at: string | null;
  /** Ultimo cambio de estado: sirve como hora de completado en el historial. */
  updated_at: string;
  /**
   * Total a cobrar. Lo necesita quien contrasta el comprobante.
   *
   * Opcional porque `numeric` puede no venir en una fila antigua o en un
   * adaptador que no lo pida; ausente se trata como 0, nunca como `NaN`.
   */
  total_amount?: number | string | null;
}

/** Fila cruda minima de `order_items`: producto y cantidad, nada de precios. */
export interface RawKitchenItemRow {
  order_id: string;
  product_name_snapshot: string;
  quantity: number;
}

/**
 * Linea del ticket. `modifiers` queda preparado para pintar "– sin cebolla" o
 * "– extra tocino", pero HOY llega siempre vacio: `order_items` no guarda
 * modificadores y `orders.notes` es texto libre a nivel de pedido. No se
 * inventa ningun parseo heuristico para adivinar a que plato pertenece cada
 * indicacion; capturarlos de verdad pide una columna nueva y tocar el checkout.
 */
export interface KitchenTicketLine {
  name: string;
  quantity: number;
  modifiers: string[];
}

export interface KitchenTicket {
  orderNumber: string;
  /** Instante de entrada A COCINA: `confirmed_at ?? created_at`. */
  enteredAt: string;
  stage: KdsStage;
  deliveryType: DeliveryType;
  lines: KitchenTicketLine[];
  notes: string | null;
  /** Hora en que se marco listo (solo etapa `done`); alimenta el historial. */
  completedAt: string | null;
  /** Total a cobrar, para contrastar el comprobante. */
  total: number;
  /**
   * Pago del pedido: intentos y comprobantes, ya en forma de vista.
   *
   * `null` cuando no hay nada que revisar. Es la MISMA estructura que usa el
   * panel del encargado —`toPaymentView`— y no una version reducida: dos vistas
   * distintas del mismo pago acabarian discrepando, y quien decide desde cocina
   * tiene que ver exactamente lo que veria desde el panel.
   */
  payment: PaymentView | null;
}

/**
 * Antiguedad del pedido EN COCINA. Lo que le importa al cocinero es cuanto
 * lleva el pedido esperando plancha, no cuanto lleva el cliente en el chat.
 */
export function enteredAtOf(row: RawKitchenOrderRow): string {
  return row.confirmed_at ?? row.created_at;
}

/** Agrupa las filas de items por `order_id` (una sola consulta las trae todas). */
export function groupItemsByOrder(
  items: RawKitchenItemRow[],
): Record<string, KitchenTicketLine[]> {
  const grouped: Record<string, KitchenTicketLine[]> = {};
  for (const it of items) {
    (grouped[it.order_id] ??= []).push({
      name: it.product_name_snapshot,
      quantity: it.quantity,
      modifiers: [],
    });
  }
  return grouped;
}

/**
 * Convierte filas crudas en tickets ordenados por antiguedad (lo que mas
 * espera, primero). Las filas cuyo estado no pertenece al tablero se descartan.
 */
export function toKitchenTickets(
  rows: RawKitchenOrderRow[],
  items: RawKitchenItemRow[],
  /** Pago por `order_id`. Ausente = el tablero se pinta sin seccion de pago. */
  payments: Record<string, PaymentView> = {},
): KitchenTicket[] {
  const lines = groupItemsByOrder(items);
  const tickets: KitchenTicket[] = [];
  for (const row of rows) {
    const stage = stageFromOrderStatus(row.status);
    if (stage === null) continue;
    tickets.push({
      orderNumber: row.order_number,
      enteredAt: enteredAtOf(row),
      stage,
      deliveryType: row.delivery_type,
      lines: lines[row.id] ?? [],
      notes: row.notes,
      completedAt: stage === 'done' ? row.updated_at : null,
      // `numeric` de Postgres puede llegar como cadena segun el driver. Un total
      // ilegible cae a 0 y no a NaN: la tarjeta muestra "Bs 0,00", que es
      // visiblemente raro, en vez de un "NaN" que parece un fallo de la pantalla.
      total: Number(row.total_amount) || 0,
      payment: payments[row.id] ?? null,
    });
  }
  return sortByAge(tickets);
}

/** Orden del grid: lo mas antiguo primero. Fechas ilegibles van al final. */
export function sortByAge(tickets: KitchenTicket[]): KitchenTicket[] {
  const key = (t: KitchenTicket): number => {
    const ms = Date.parse(t.enteredAt);
    return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms;
  };
  return [...tickets].sort((a, b) => key(a) - key(b));
}
