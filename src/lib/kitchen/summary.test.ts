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
    // Categoría por defecto para los fixtures que no la declaran: casi todos
    // estos tests miden CUÁNTO se suma, no en qué bloque cae.
    lines: lines.map(([name, quantity]) => ({
      name,
      quantity,
      modifiers: [],
      category: 'plato' as const,
    })),
    notes: null,
    completedAt: stage === 'done' ? iso(minutes + 10) : null,
    amountDueByQr: 0,
    // Por defecto el pago ya está confirmado: así los tests de etapas miden
    // etapas, y los del pago activan la espera explícitamente.
    awaitingPaymentConfirmation: false,
    payment: null,
    // Puerta abierta: estos tests no van del pago (0028).
    gate: { state: 'not_required' as const, canStart: true, graceEndsAtMs: null },
    amountLabel: null,
    deliveryCollect: null,
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
    expect(s.countedOrders).toBe(2);
  });

  it('COMPLETAR resta los productos y el pedido; DEVOLVER A COCINA los vuelve a sumar', () => {
    const activo = [ticket('A', 'in_progress', [['Trancaburguer', 4]])];
    expect(summarizeProducts(activo).totalUnits).toBe(4);
    expect(summarizeProducts(activo).countedOrders).toBe(1);

    // COMPLETAR: el mismo ticket pasa a `done`.
    const completado = [{ ...activo[0], stage: 'done' as KdsStage }];
    expect(summarizeProducts(completado).totalUnits).toBe(0);
    expect(summarizeProducts(completado).countedOrders).toBe(0);

    // DEVOLVER A COCINA: vuelve a `in_progress` y el resumen recupera todo.
    const devuelto = [{ ...completado[0], stage: 'in_progress' as KdsStage }];
    expect(summarizeProducts(devuelto).totalUnits).toBe(4);
    expect(summarizeProducts(devuelto).countedOrders).toBe(1);
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
    expect(summarizeProducts(cancelado).countedOrders).toBe(0);
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
          { name: 'Trancapecho', quantity: 2, modifiers: ['sin cebolla'], category: 'plato' as const },
          { name: 'Trancapecho', quantity: 1, modifiers: ['extra tocino'], category: 'plato' as const },
        ],
      },
    ];
    expect(summarizeProducts(tickets).rows).toEqual([{ name: 'Trancapecho', quantity: 3 }]);
  });

  it('sin tickets activos el resumen queda vacío', () => {
    expect(summarizeProducts([])).toEqual({
      rows: [],
      groups: [],
      totalUnits: 0,
      countedOrders: 0,
      awaitingOrders: 0,
      awaitingUnits: 0,
    });
  });
});

describe('resumen — el total espera a que el pago se confirme', () => {
  /**
   * Quien mira la barra derecha es el planchero, y lo que lee ahí es cuánto
   * poner a la plancha AHORA. Desde que cocina revisa los comprobantes, un
   * pedido puede llegar al tablero con un pago que después se rechaza; hasta
   * entonces sus unidades inflaban el total y se cocinaba de más.
   */
  const sinConfirmar = (t: KitchenTicket): KitchenTicket => ({
    ...t,
    awaitingPaymentConfirmation: true,
  });

  it('un pedido nuevo con el pago sin confirmar NO suma al total', () => {
    const tickets = [
      ticket('A', 'new', [['Trancapecho', 3]]),
      sinConfirmar(ticket('B', 'new', [['Trancapecho', 2]])),
    ];
    const s = summarizeProducts(tickets);
    expect(s.rows).toEqual([{ name: 'Trancapecho', quantity: 3 }]);
    expect(s.totalUnits).toBe(3);
    expect(s.countedOrders).toBe(1);
  });

  it('lo retenido se declara aparte: ni se suma ni se esconde', () => {
    const s = summarizeProducts([
      sinConfirmar(ticket('A', 'new', [['Trancapecho', 2], ['Api con pastel', 1]])),
      sinConfirmar(ticket('B', 'new', [['Trancaburguer', 4]])),
    ]);
    expect(s.rows).toEqual([]);
    expect(s.totalUnits).toBe(0);
    expect(s.awaitingOrders).toBe(2);
    expect(s.awaitingUnits).toBe(7);
  });

  it('al confirmar el pago, sus productos entran al total de golpe', () => {
    const esperando = [sinConfirmar(ticket('A', 'new', [['Trancapecho', 3]]))];
    expect(summarizeProducts(esperando).totalUnits).toBe(0);

    const confirmado = [{ ...esperando[0], awaitingPaymentConfirmation: false }];
    const s = summarizeProducts(confirmado);
    expect(s.totalUnits).toBe(3);
    expect(s.countedOrders).toBe(1);
    expect(s.awaitingOrders).toBe(0);
    expect(s.awaitingUnits).toBe(0);
  });

  it('ya en la plancha, cuenta aunque el pago siga sin confirmar', () => {
    // INICIAR es una decisión de cocinar: el total que no la incluye le miente
    // al planchero en la dirección contraria, diciéndole que le queda menos
    // trabajo del que ya tiene en la mano.
    const s = summarizeProducts([
      sinConfirmar(ticket('A', 'in_progress', [['Trancapecho', 2]])),
    ]);
    expect(s.totalUnits).toBe(2);
    expect(s.countedOrders).toBe(1);
    expect(s.awaitingOrders).toBe(0);
  });

  it('un pedido completado o cancelado no cuenta como pendiente de pago', () => {
    // La espera solo describe trabajo por llegar. Un `done` ya se cocinó y un
    // `cancelled` no se cocinará: contarlos ahí sería inventar trabajo futuro.
    const s = summarizeProducts([
      sinConfirmar(ticket('A', 'done', [['Trancapecho', 5]])),
      sinConfirmar(ticket('B', 'cancelled', [['Trancapecho', 9]])),
    ]);
    expect(s.awaitingOrders).toBe(0);
    expect(s.awaitingUnits).toBe(0);
    expect(s.totalUnits).toBe(0);
  });

  it('los contadores de la barra superior NO cambian: siguen contando pedidos', () => {
    // La barra de arriba responde "cuántos pedidos hay", no "cuánto cocinar".
    // Un pedido esperando comprobante es un pedido pendiente de verdad, y
    // ocultarlo ahí dejaría a cocina sin saber que tiene algo que revisar.
    const tickets = [
      sinConfirmar(ticket('A', 'new', [['Trancapecho', 1]])),
      ticket('B', 'new', [['Trancapecho', 1]]),
    ];
    expect(countersFrom(tickets)).toEqual({ today: 2, pending: 2, inProgress: 0, done: 0 });
  });

  it('el grid sigue pintando el ticket: lo que espera es el conteo, no la comanda', () => {
    const tickets = [sinConfirmar(ticket('A', 'new', [['Trancapecho', 1]]))];
    expect(gridTickets(tickets).map((t) => t.orderNumber)).toEqual(['A']);
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

// ── El reparto del planchero ────────────────────────────────────────────────

/** Ticket con la categoría declarada por línea. */
function ticketCat(
  orderNumber: string,
  lines: Array<[string, number, 'plato' | 'bebida' | 'extra' | null]>,
): KitchenTicket {
  const base = ticket(orderNumber, 'new', []);
  return {
    ...base,
    lines: lines.map(([name, quantity, category]) => ({
      name,
      quantity,
      modifiers: [],
      category,
    })),
  };
}

describe('resumen — dividido para empaque y plancha', () => {
  const MIXTO = ticketCat('A', [
    ['Trancaburguer', 2, 'plato'],
    ['Soda Peque', 3, 'bebida'],
    ['Porción de papa', 1, 'extra'],
    ['Lomito', 1, 'plato'],
  ]);

  it('separa comidas, extras y refrescos', () => {
    const { groups } = summarizeProducts([MIXTO]);
    expect(groups.map((g) => g.label)).toEqual(['Comidas', 'Extras', 'Refrescos']);
  });

  it('primero lo que va al fuego y al final lo que solo se sirve', () => {
    // El orden NO es el del menú del cliente —allí las bebidas van antes que
    // los extras—: aquí manda el trabajo de cocina.
    const { groups } = summarizeProducts([MIXTO]);
    expect(groups.map((g) => g.key)).toEqual(['plato', 'extra', 'bebida']);
  });

  it('cada bloque lleva su propio total de unidades', () => {
    const { groups } = summarizeProducts([MIXTO]);
    expect(groups.find((g) => g.key === 'plato')?.units).toBe(3);
    expect(groups.find((g) => g.key === 'bebida')?.units).toBe(3);
    expect(groups.find((g) => g.key === 'extra')?.units).toBe(1);
  });

  it('los bloques suman exactamente lo mismo que la lista plana', () => {
    const resumen = summarizeProducts([MIXTO]);
    const enBloques = resumen.groups.reduce((s, g) => s + g.units, 0);
    expect(enBloques).toBe(resumen.totalUnits);
    expect(resumen.groups.flatMap((g) => g.rows).length).toBe(resumen.rows.length);
  });

  it('un bloque sin nada dentro no se pinta', () => {
    const soloComida = ticketCat('B', [['Lomito', 2, 'plato']]);
    const { groups } = summarizeProducts([soloComida]);
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe('Comidas');
  });

  it('lo que no tiene categoría cae en Otros, nunca en Comidas', () => {
    // Poner un producto desconocido entre las comidas mandaría a la plancha
    // algo que quizá es un refresco.
    const raro = ticketCat('C', [
      ['Lomito', 1, 'plato'],
      ['Producto borrado', 2, null],
    ]);
    const { groups } = summarizeProducts([raro]);
    expect(groups.map((g) => g.key)).toEqual(['plato', 'otros']);
    expect(groups.find((g) => g.key === 'otros')?.rows).toEqual([
      { name: 'Producto borrado', quantity: 2 },
    ]);
  });

  it('dentro de cada bloque manda la cantidad', () => {
    const varios = ticketCat('D', [
      ['Hamburguesa', 1, 'plato'],
      ['Trancapecho', 5, 'plato'],
      ['Lomito', 3, 'plato'],
    ]);
    const comidas = summarizeProducts([varios]).groups[0];
    expect(comidas.rows.map((r) => r.name)).toEqual(['Trancapecho', 'Lomito', 'Hamburguesa']);
  });

  it('el mismo producto en dos pedidos suma en un solo renglón', () => {
    const uno = ticketCat('E', [['Lomito', 2, 'plato']]);
    const dos = ticketCat('F', [['Lomito', 3, 'plato']]);
    const comidas = summarizeProducts([uno, dos]).groups[0];
    expect(comidas.rows).toEqual([{ name: 'Lomito', quantity: 5 }]);
  });

  it('una categoría que esta pantalla no conoce cae en Otros, no se pierde', () => {
    // La categoría se lee de la base como texto. El día que el catálogo estrene
    // una —postres— antes de que los bloques la contemplen, el producto tiene
    // que seguir viéndose: si desapareciera del reparto mientras suma en el
    // total, alguien pediría algo que nadie prepara.
    const futuro = ticketCat('G', [
      ['Lomito', 1, 'plato'],
      ['Flan', 2, 'postre' as unknown as 'plato'],
    ]);
    const resumen = summarizeProducts([futuro]);
    expect(resumen.groups.find((g) => g.key === 'otros')?.rows).toEqual([
      { name: 'Flan', quantity: 2 },
    ]);
    // Y la promesa de siempre se mantiene: los bloques suman lo mismo que la
    // lista plana, pase lo que pase con el catálogo.
    expect(resumen.groups.reduce((s, g) => s + g.units, 0)).toBe(resumen.totalUnits);
  });
});
