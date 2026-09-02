/**
 * Contadores y resumen de cocina — modulo PURO.
 *
 * TODOS los numeros de la pantalla salen de aqui, derivados de una unica fuente
 * de verdad: la lista de tickets. No hay contadores guardados aparte que haya
 * que sincronizar a mano — que es justo donde aparecen los numeros "estaticos"
 * que nunca se restan.
 */
import type { MenuCategory } from '@/types';
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
  /** Todo junto, por cantidad. Se conserva para quien ya lo leía así. */
  rows: KitchenSummaryRow[];
  /**
   * Lo mismo, repartido en Comidas / Extras / Refrescos.
   *
   * Es lo que pinta el panel del planchero: quien empaca necesita ver de un
   * golpe cuántas hamburguesas van al fuego sin tener que separarlas
   * mentalmente de los refrescos que solo hay que sacar de la heladera.
   *
   * Solo aparecen los bloques con algo dentro: un rótulo "Refrescos" sobre una
   * lista vacía ocupa sitio en una pantalla que ya va justa de ancho.
   */
  groups: KitchenSummaryGroup[];
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
/**
 * Los tres bloques del resumen, en el orden en que se trabaja.
 *
 * Primero lo que va a la PLANCHA, después lo que va a la FREIDORA, y al final
 * lo que solo se sirve. No es el orden del menú del cliente —allí las bebidas
 * van antes que los extras— porque esta pantalla no la lee un cliente: la lee
 * quien tiene que decidir qué pone al fuego ahora.
 *
 * Se nombran como se nombran en la cocina, no como en la carta: "Comidas" y
 * "Refrescos" en vez de "Platos" y "Bebidas".
 */
export const SUMMARY_GROUPS: ReadonlyArray<{ key: MenuCategory; label: string }> = [
  { key: 'plato', label: 'Comidas' },
  { key: 'extra', label: 'Extras' },
  { key: 'bebida', label: 'Refrescos' },
];

/** Un bloque del resumen. Solo se devuelven los que tienen algo dentro. */
export interface KitchenSummaryGroup {
  key: MenuCategory | 'otros';
  label: string;
  rows: KitchenSummaryRow[];
  /** Unidades del bloque: lo que se lee de un vistazo desde la plancha. */
  units: number;
}

/**
 * Reparte las filas ya sumadas en sus bloques.
 *
 * Lo que no tiene categoría —un producto borrado del catálogo, o un combo con
 * un código que ya no existe— NO se reparte en "Comidas" por defecto: cae en
 * "Otros". Meterlo en comidas pondría un refresco en la plancha, y esconderlo
 * sería peor: alguien tiene que preparar eso igual.
 */
function agruparPorCategoria(
  filas: ReadonlyArray<KitchenSummaryRow & { category: MenuCategory | null }>,
): KitchenSummaryGroup[] {
  const grupos: KitchenSummaryGroup[] = [];

  for (const { key, label } of SUMMARY_GROUPS) {
    const rows = filas.filter((f) => f.category === key).map(({ name, quantity }) => ({ name, quantity }));
    if (rows.length > 0) {
      grupos.push({ key, label, rows, units: rows.reduce((s, r) => s + r.quantity, 0) });
    }
  }

  const sueltos = filas.filter((f) => f.category === null).map(({ name, quantity }) => ({ name, quantity }));
  if (sueltos.length > 0) {
    grupos.push({
      key: 'otros',
      label: 'Otros',
      rows: sueltos,
      units: sueltos.reduce((s, r) => s + r.quantity, 0),
    });
  }

  return grupos;
}

export function summarizeProducts(tickets: KitchenTicket[]): KitchenSummary {
  // Se agrupa por NOMBRE, como siempre, pero se recuerda la categoría de la
  // primera aparición: dos productos con el mismo nombre en categorías
  // distintas no existen en esta carta, y si algún día existieran seguirían
  // sumando juntos como hasta ahora.
  const totals = new Map<string, { quantity: number; category: MenuCategory | null }>();
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
      const previo = totals.get(line.name);
      totals.set(line.name, {
        quantity: (previo?.quantity ?? 0) + qty,
        category: previo?.category ?? line.category ?? null,
      });
      totalUnits += qty;
    }
  }

  const conCategoria = [...totals.entries()]
    .map(([name, { quantity, category }]) => ({ name, quantity, category }))
    .sort((a, b) => b.quantity - a.quantity || a.name.localeCompare(b.name, 'es'));

  // `rows` se mantiene plano y con el mismo orden de siempre: hay pantallas y
  // pruebas que lo leen así, y los bloques son una VISTA de lo mismo, no otro
  // cálculo que pudiera discrepar.
  const rows = conCategoria.map(({ name, quantity }) => ({ name, quantity }));

  return {
    rows,
    groups: agruparPorCategoria(conCategoria),
    totalUnits,
    countedOrders,
    awaitingOrders,
    awaitingUnits,
  };
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
