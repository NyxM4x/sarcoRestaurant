import { describe, it, expect } from 'vitest';
import type { KitchenTicket } from './ticket-view';
import { isActiveStage, type KdsStage } from './kds-status';
import {
  EMPTY_MESSAGES,
  canAdvanceStage,
  isCashierTicket,
  ticketsForView,
  type BoardView,
} from './board-view';

/**
 * DOS PANTALLAS, UN SOLO TABLERO (07-09-2026).
 *
 * Lo que se prueba aquí no es tanto que cada pantalla vea lo suyo como que
 * ENTRE LAS DOS no se pierda nada: un ticket que no salga en ninguna es una
 * comanda que nadie cocina, y en una cocina eso no se descubre hasta que el
 * cliente llama preguntando.
 */
function ticket(over: Partial<KitchenTicket> = {}): KitchenTicket {
  return {
    orderNumber: 'ORD-260907-001',
    enteredAt: '2026-09-07T20:00:00.000Z',
    stage: 'new',
    deliveryType: 'delivery',
    lines: [],
    notes: null,
    completedAt: null,
    paysCash: false,
    amountDueByQr: 18,
    awaitingPaymentConfirmation: false,
    payment: null,
    gate: { canStart: true, reason: null },
    amountLabel: null,
    deliveryCollect: null,
    ...over,
  } as KitchenTicket;
}

const esperandoPago = ticket({ orderNumber: 'A', awaitingPaymentConfirmation: true });
const pagoAceptado = ticket({ orderNumber: 'B', awaitingPaymentConfirmation: false });
const enEfectivo = ticket({
  orderNumber: 'C',
  paysCash: true,
  awaitingPaymentConfirmation: false,
});

describe('el reparto entre las dos pantallas', () => {
  it('caja ve lo que espera comprobante; plancha, lo demás', () => {
    const todos = [esperandoPago, pagoAceptado, enEfectivo];

    expect(ticketsForView(todos, 'cashier').map((t) => t.orderNumber)).toEqual(['A']);
    expect(ticketsForView(todos, 'line').map((t) => t.orderNumber)).toEqual(['B', 'C']);
  });

  it('el efectivo NO pasa por caja: no hay comprobante que aceptar', () => {
    // Mandarlo a caja sería poner delante del cajero un ticket sobre el que no
    // puede hacer nada, y retrasar una comida por un paso que no existe.
    expect(isCashierTicket(enEfectivo)).toBe(false);
    expect(ticketsForView([enEfectivo], 'cashier')).toEqual([]);
    expect(ticketsForView([enEfectivo], 'line')).toEqual([enEfectivo]);
  });

  /**
   * EL INVARIANTE. Todo ticket sale en exactamente UNA de las dos pantallas.
   *
   * Si alguna vez las dos vistas dejaran de ser complementarias —porque una
   * empezara a mirar la etapa, o el pago, o cualquier otra cosa por su cuenta—
   * habría comandas invisibles. Por eso el filtro es un único booleano negado y
   * no dos listas de condiciones.
   */
  it('ningún ticket se pierde, y ninguno sale dos veces', () => {
    const etapas: KdsStage[] = ['new', 'in_progress', 'done', 'cancelled'];
    const todos: KitchenTicket[] = [];
    for (const stage of etapas) {
      for (const esperando of [true, false]) {
        todos.push(
          ticket({
            orderNumber: `${stage}-${esperando}`,
            stage,
            awaitingPaymentConfirmation: esperando,
          }),
        );
      }
    }

    const caja = ticketsForView(todos, 'cashier').map((t) => t.orderNumber);
    const plancha = ticketsForView(todos, 'line').map((t) => t.orderNumber);

    expect([...caja, ...plancha].sort()).toEqual(todos.map((t) => t.orderNumber).sort());
    expect(caja.filter((n) => plancha.includes(n))).toEqual([]);
  });

  it('la pantalla completa no filtra NADA: es el KDS de siempre', () => {
    // El default de `KitchenBoardScreen`. Mientras haya una sola laptop, este
    // camino tiene que comportarse exactamente igual que antes de existir las
    // otras dos vistas — y la forma de garantizarlo es que no toque la lista.
    const todos = [esperandoPago, pagoAceptado, enEfectivo];
    expect(ticketsForView(todos, 'full')).toBe(todos);
  });
});

describe('un pago sin confirmar sigue siendo de caja aunque ya se cocine', () => {
  it('la etapa no decide el reparto', () => {
    // La puerta de INICIAR se abre igual cuando no se pudieron consultar los
    // pagos, para no parar la cocina. Un pedido que llegó así a la plancha con
    // el pago sin confirmar es justo el que el cajero tiene que resolver.
    const enPlancha = ticket({ stage: 'in_progress', awaitingPaymentConfirmation: true });
    expect(ticketsForView([enPlancha], 'cashier')).toEqual([enPlancha]);
    expect(isActiveStage(enPlancha.stage)).toBe(true);
  });
});

describe('lo que puede hacer cada pantalla', () => {
  it('caja no mueve el pedido por la cocina', () => {
    // Su trabajo empieza y acaba en el pago. Con INICIAR y CANCELAR delante
    // tendría dos trabajos y podría tirar un pedido que nadie ha visto.
    expect(canAdvanceStage('cashier')).toBe(false);
  });

  it('plancha y la pantalla completa sí', () => {
    expect(canAdvanceStage('line')).toBe(true);
    expect(canAdvanceStage('full')).toBe(true);
  });

  it('cada pantalla dice lo suyo cuando está vacía', () => {
    // Una caja vacía es una buena noticia y no puede leerse como una avería.
    for (const view of ['full', 'cashier', 'line'] as BoardView[]) {
      expect(EMPTY_MESSAGES[view].title, view).not.toBe('');
      expect(EMPTY_MESSAGES[view].hint, view).not.toBe('');
    }
    expect(EMPTY_MESSAGES.cashier.title).toContain('pagos');
    expect(EMPTY_MESSAGES.line.hint).toContain('caja');
  });
});
