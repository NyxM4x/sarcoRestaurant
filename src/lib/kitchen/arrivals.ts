/**
 * Deteccion de tickets recien llegados — modulo PURO.
 *
 * El tablero se refresca por polling: cada ciclo trae la lista completa, sin
 * decir que cambio. Para avisar con un sonido hace falta responder a una
 * pregunta muy concreta —¿hay algun pedido que no estuviera en el ciclo
 * anterior?— y esa comparacion es aritmetica de conjuntos, no un efecto: vive
 * aqui, se prueba sola y el componente solo la usa.
 *
 * ── Por que solo cuentan los `new` ──────────────────────────────────────────
 *
 * La campana significa "hay comida que empezar". Un ticket puede aparecer por
 * primera vez en esta pantalla ya en preparacion —lo inicio otra tablet, o esta
 * pantalla estuvo oculta y volvio— y eso no es un pedido nuevo que atender:
 * sonar ahi entrena al cocinero a ignorar la campana, que es la peor manera de
 * perder un pedido de verdad.
 *
 * ── Y por que el conjunto conocido son TODOS los presentes ──────────────────
 *
 * Lo conocido se reemplaza en cada ciclo por los pedidos que hay ahora, no se
 * acumula para siempre. Asi el conjunto no crece sin limite en una tablet que
 * pasa el dia encendida, y un pedido que desaparecio del tablero y vuelve
 * suena otra vez — que es lo correcto: vuelve a ser algo que atender.
 */
import type { KitchenTicket } from './ticket-view';

export interface ArrivalCheck {
  /** Pedidos en etapa `new` que no estaban en el ciclo anterior. */
  arrivals: string[];
  /** Conjunto conocido para el siguiente ciclo: todos los presentes ahora. */
  known: Set<string>;
}

/**
 * Compara la lista recien traida contra lo que ya se conocia.
 *
 * Con `known` vacio —primera carga— TODO ticket `new` sale como llegada. Quien
 * llama decide que hacer con eso: al abrir la pantalla no debe sonar, porque
 * los pedidos que ya estaban no acaban de llegar.
 */
export function detectArrivals(
  known: ReadonlySet<string>,
  tickets: readonly KitchenTicket[],
): ArrivalCheck {
  const arrivals: string[] = [];
  const next = new Set<string>();
  for (const ticket of tickets) {
    next.add(ticket.orderNumber);
    if (ticket.stage !== 'new') continue;
    if (known.has(ticket.orderNumber)) continue;
    arrivals.push(ticket.orderNumber);
  }
  return { arrivals, known: next };
}
