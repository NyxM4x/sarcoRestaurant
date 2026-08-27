import { describe, it, expect } from 'vitest';
import { countersFrom, gridTickets, readyTickets, summarizeProducts } from './summary';
import type { KitchenTicket } from './ticket-view';
import type { KdsStage } from './kds-status';

const BASE = Date.parse('2026-08-22T12:00:00Z');
const iso = (min: number) => new Date(BASE + min * 60_000).toISOString();

function ticket(
  orderNumber: string,
  stage: KdsStage,
  lines: Array<[string, number]>,
  minutes = 0,
): KitchenTicket {
  return {
    orderNumber,
    enteredAt: iso(minutes),
    stage,
    deliveryType: 'delivery',
    lines: lines.map(([name, quantity]) => ({ name, quantity, modifiers: [] })),
    notes: null,
    completedAt: stage === 'done' ? iso(minutes + 10) : null,
    total: 0,
    payment: null,
  };
}

describe('resumen — solo suma los tickets activos', () => {
  it('un pedido en `done` o `cancelled` NO suma al panel derecho', () => {
    const tickets = [
      ticket('A', 'new', [['Trancapecho', 3]]),
      ticket('B', 'in_progress', [['Trancapecho', 2]]),
      ticket('C', 'done', [['Trancapecho', 5]]),
      ticket('D', 'cancelled', [['Trancapecho', 9]]),
    ];
    const s = summarizeProducts(tickets);
    expect(s.rows).toEqual([{ name: 'Trancapecho', quantity: 5 }]);
    expect(s.totalUnits).toBe(5);
    expect(s.activeOrders).toBe(2);
  });

  it('COMPLETAR resta los productos y el pedido; DEVOLVER A COCINA los vuelve a sumar', () => {
    const activo = [ticket('A', 'in_progress', [['Trancaburguer', 4]])];
    expect(summarizeProducts(activo).totalUnits).toBe(4);
    expect(summarizeProducts(activo).activeOrders).toBe(1);

    // COMPLETAR: el mismo ticket pasa a `done`.
    const completado = [{ ...activo[0], stage: 'done' as KdsStage }];
    expect(summarizeProducts(completado).totalUnits).toBe(0);
    expect(summarizeProducts(completado).activeOrders).toBe(0);

    // DEVOLVER A COCINA: vuelve a `in_progress` y el resumen recupera todo.
    const devuelto = [{ ...completado[0], stage: 'in_progress' as KdsStage }];
    expect(summarizeProducts(devuelto).totalUnits).toBe(4);
    expect(summarizeProducts(devuelto).activeOrders).toBe(1);
  });

  it('INICIAR y RETORNAR no cambian el resumen: el pedido sigue activo', () => {
    const nuevo = [ticket('A', 'new', [['Gaseosa 2 L', 2]])];
    const iniciado = [{ ...nuevo[0], stage: 'in_progress' as KdsStage }];
    expect(summarizeProducts(iniciado)).toEqual(summarizeProducts(nuevo));
    const retornado = [{ ...iniciado[0], stage: 'new' as KdsStage }];
    expect(summarizeProducts(retornado)).toEqual(summarizeProducts(nuevo));
  });

  it('CANCELAR resta los productos y el pedido del resumen', () => {
    const nuevo = [ticket('A', 'new', [['Trancapecho', 3]])];
    const cancelado = [{ ...nuevo[0], stage: 'cancelled' as KdsStage }];
    expect(summarizeProducts(cancelado).totalUnits).toBe(0);
    expect(summarizeProducts(cancelado).activeOrders).toBe(0);
  });
});

describe('resumen — orden y agrupación', () => {
  it('ordena por cantidad descendente y, a igual cantidad, alfabético', () => {
    const tickets = [
      ticket('A', 'new', [
        ['Trancapecho', 5],
        ['Gaseosa 2 L', 4],
      ]),
      ticket('B', 'in_progress', [
        ['Trancapecho', 3],
        ['Trancaburguer', 5],
        ['Api con pastel', 4],
      ]),
    ];
    expect(summarizeProducts(tickets).rows).toEqual([
      { name: 'Trancapecho', quantity: 8 },
      { name: 'Trancaburguer', quantity: 5 },
      { name: 'Api con pastel', quantity: 4 },
      { name: 'Gaseosa 2 L', quantity: 4 },
    ]);
  });

  it('los modificadores no separan filas: el mismo producto suma junto', () => {
    const tickets = [
      {
        ...ticket('A', 'new', []),
        lines: [
          { name: 'Trancapecho', quantity: 2, modifiers: ['sin cebolla'] },
          { name: 'Trancapecho', quantity: 1, modifiers: ['extra tocino'] },
        ],
      },
    ];
    expect(summarizeProducts(tickets).rows).toEqual([{ name: 'Trancapecho', quantity: 3 }]);
  });

  it('sin tickets activos el resumen queda vacío', () => {
    expect(summarizeProducts([])).toEqual({ rows: [], totalUnits: 0, activeOrders: 0 });
  });
});

describe('contadores de la barra superior', () => {
  const tablero = [
    ticket('A', 'new', [['Trancapecho', 1]]),
    ticket('B', 'new', [['Trancapecho', 1]]),
    ticket('C', 'in_progress', [['Trancapecho', 1]]),
    ticket('D', 'done', [['Trancapecho', 1]]),
  ];

  it('reparte los tickets entre pendientes, en preparación y listos', () => {
    expect(countersFrom(tablero)).toEqual({ today: 4, pending: 2, inProgress: 1, done: 1 });
  });

  it('INICIAR: pendientes −1, en preparación +1; pedidos de hoy no cambia', () => {
    const antes = countersFrom(tablero);
    const despues = countersFrom(
      tablero.map((t) => (t.orderNumber === 'A' ? { ...t, stage: 'in_progress' as KdsStage } : t)),
    );
    expect(despues.pending).toBe(antes.pending - 1);
    expect(despues.inProgress).toBe(antes.inProgress + 1);
    expect(despues.today).toBe(antes.today);
  });

  it('COMPLETAR: en preparación −1, listos +1; pedidos de hoy NO baja al despachar', () => {
    const antes = countersFrom(tablero);
    const despues = countersFrom(
      tablero.map((t) => (t.orderNumber === 'C' ? { ...t, stage: 'done' as KdsStage } : t)),
    );
    expect(despues.inProgress).toBe(antes.inProgress - 1);
    expect(despues.done).toBe(antes.done + 1);
    expect(despues.today).toBe(antes.today);
  });

  it('RETORNAR: en preparación −1, pendientes +1', () => {
    const antes = countersFrom(tablero);
    const despues = countersFrom(
      tablero.map((t) => (t.orderNumber === 'C' ? { ...t, stage: 'new' as KdsStage } : t)),
    );
    expect(despues.inProgress).toBe(antes.inProgress - 1);
    expect(despues.pending).toBe(antes.pending + 1);
    expect(despues.today).toBe(antes.today);
  });

  it('DEVOLVER A COCINA: listos −1, en preparación +1', () => {
    const antes = countersFrom(tablero);
    const despues = countersFrom(
      tablero.map((t) => (t.orderNumber === 'D' ? { ...t, stage: 'in_progress' as KdsStage } : t)),
    );
    expect(despues.done).toBe(antes.done - 1);
    expect(despues.inProgress).toBe(antes.inProgress + 1);
    expect(despues.today).toBe(antes.today);
  });

  it('CANCELAR: pendientes −1 y pedidos de hoy −1 (los cancelados no cuentan)', () => {
    const antes = countersFrom(tablero);
    const despues = countersFrom(
      tablero.map((t) => (t.orderNumber === 'A' ? { ...t, stage: 'cancelled' as KdsStage } : t)),
    );
    expect(despues.pending).toBe(antes.pending - 1);
    expect(despues.today).toBe(antes.today - 1);
  });
});

describe('reparto entre grid e historial', () => {
  it('el grid solo pinta activos; los listos viven en el historial', () => {
    const tickets = [
      ticket('A', 'new', [['X', 1]], 0),
      ticket('B', 'in_progress', [['X', 1]], 5),
      ticket('C', 'done', [['X', 1]], 10),
      ticket('D', 'cancelled', [['X', 1]], 15),
    ];
    expect(gridTickets(tickets).map((t) => t.orderNumber)).toEqual(['A', 'B']);
    expect(readyTickets(tickets).map((t) => t.orderNumber)).toEqual(['C']);
  });

  it('el historial ordena lo último completado primero', () => {
    const viejo = { ...ticket('A', 'done', [['X', 1]], 0), completedAt: iso(5) };
    const nuevo = { ...ticket('B', 'done', [['X', 1]], 0), completedAt: iso(30) };
    expect(readyTickets([viejo, nuevo]).map((t) => t.orderNumber)).toEqual(['B', 'A']);
  });
});
