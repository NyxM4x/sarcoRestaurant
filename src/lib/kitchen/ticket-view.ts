/**
 * Sanitizacion del ticket de cocina — modulo PURO.
 *
 * El cocinero ve lo justo para cocinar: numero de pedido, cuando entro a
 * cocina, etapa, tipo de entrega, los platos y las notas. NUNCA telefono,
 * direccion ni coordenadas. No es solo que la pantalla no los pinte: es que no
 * viajan en la respuesta.
 *
 * ── Por que viaja un IMPORTE, y por que solo uno ────────────────────────────
 *
 * Desde que cocina revisa los comprobantes, el monto dejo de ser un dato
 * administrativo y paso a ser una herramienta de trabajo: sin el, mirar un
 * comprobante no es validarlo. Se puede aceptar un pago de Bs 20 para un pedido
 * de Bs 64 y nadie lo nota hasta el cierre de caja.
 *
 * Viaja UNA sola cifra: lo que el cliente debia transferir por QR. Ni total, ni
 * subtotal, ni envio por separado. Dos cifras en un ticket que se mira a un
 * metro y con prisa es una invitacion a comparar el comprobante contra la
 * equivocada — que es justo el error que este dato viene a evitar.
 *
 * ── Y por que ese importe NO es el total ────────────────────────────────────
 *
 * En delivery, por QR se cobra solo la comida: el envio lo paga el cliente al
 * recibir el pedido, y el mensaje del QR se lo advierte. Asi que el comprobante
 * correcto vale el SUBTOTAL, y comparar contra el total haria rechazar pagos
 * buenos — con el cliente esperando y la comida sin empezar.
 *
 * En recojo no hay envio que cobrar aparte, asi que se paga todo por QR y el
 * importe a validar es el total. La cifra correcta depende del tipo de entrega,
 * y por eso se calcula aqui una vez y no en cada pantalla que la use.
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
   * Importes del pedido. Opcionales porque `numeric` puede no venir en una fila
   * antigua o en un adaptador que no los pida; ausentes se tratan como 0, nunca
   * como `NaN`.
   */
  total_amount?: number | string | null;
  subtotal_amount?: number | string | null;
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
  /**
   * Lo que el cliente debia transferir por QR: la cifra contra la que se
   * contrasta el comprobante. En delivery es la comida (el envio se paga al
   * recibir); en recojo, el total.
   */
  amountDueByQr: number;
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

/**
 * Importe que el cliente debia transferir por QR.
 *
 * `numeric` de Postgres puede llegar como cadena segun el driver, y un valor
 * ilegible cae a 0 en vez de a `NaN`: la tarjeta muestra "Bs 0,00", que es
 * visiblemente raro y hace mirar dos veces, en lugar de un "NaN" que parece un
 * fallo de la pantalla y se ignora.
 */
export function amountDueByQrOf(row: RawKitchenOrderRow): number {
  // Recojo: no hay envio que cobrar aparte, se paga todo por QR.
  if (row.delivery_type === 'pickup') return Number(row.total_amount) || 0;
  // Delivery: solo la comida. El envio lo paga al recibir el pedido.
  return Number(row.subtotal_amount) || 0;
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
      amountDueByQr: amountDueByQrOf(row),
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
