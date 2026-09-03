import { describe, it, expect } from 'vitest';
import { detectArrivals } from './arrivals';
import type { KitchenTicket } from './ticket-view';
import type { KdsStage } from './kds-status';

const BASE = Date.parse('2026-08-27T12:00:00Z');
const iso = (min: number) => new Date(BASE + min * 60_000).toISOString();

function ticket(orderNumber: string, stage: KdsStage, minutes = 0): KitchenTicket {
  return {
    orderNumber,
    enteredAt: iso(minutes),
    stage,
    deliveryType: 'delivery',
    lines: [{ name: 'Trancapecho', quantity: 1, modifiers: [], category: 'plato' as const }],
    notes: null,
    completedAt: stage === 'done' ? iso(minutes + 10) : null,
    amountDueByQr: 0,
    awaitingPaymentConfirmation: false,
    payment: null,
    // Puerta abierta: estos tests no van del pago (0028).
    gate: { state: 'not_required' as const, canStart: true, graceEndsAtMs: null },
    amountLabel: null,
    deliveryCollect: null,
  };
}

describe('llegadas — que hace sonar la campana', () => {
  it('un pedido `new` que no estaba en el ciclo anterior es una llegada', () => {
    const antes = detectArrivals(new Set(), [ticket('A', 'new')]);
    const ahora = detectArrivals(antes.known, [ticket('A', 'new'), ticket('B', 'new', 1)]);
    expect(ahora.arrivals).toEqual(['B']);
  });

  it('el mismo pedido no vuelve a sonar en los ciclos siguientes', () => {
    const tickets = [ticket('A', 'new')];
    const primero = detectArrivals(new Set(), tickets);
    expect(primero.arrivals).toEqual(['A']); // la siembra la descarta quien llama
    const segundo = detectArrivals(primero.known, tickets);
    const tercero = detectArrivals(segundo.known, tickets);
    expect(segundo.arrivals).toEqual([]);
    expect(tercero.arrivals).toEqual([]);
  });

  it('un pedido que aparece ya empezado, listo o cancelado NO suena', () => {
    const previo = detectArrivals(new Set(), [ticket('A', 'new')]);
    const check = detectArrivals(previo.known, [
      ticket('A', 'new'),
      ticket('B', 'in_progress', 1),
      ticket('C', 'done', 2),
      ticket('D', 'cancelled', 3),
    ]);
    expect(check.arrivals).toEqual([]);
  });

  it('empezar un pedido conocido no lo convierte en llegada', () => {
    const previo = detectArrivals(new Set(), [ticket('A', 'new')]);
    const check = detectArrivals(previo.known, [ticket('A', 'in_progress')]);
    expect(check.arrivals).toEqual([]);
  });

  it('varias llegadas en el mismo ciclo se devuelven todas', () => {
    const previo = detectArrivals(new Set(), [ticket('A', 'new')]);
    const check = detectArrivals(previo.known, [
      ticket('A', 'new'),
      ticket('B', 'new', 1),
      ticket('C', 'new', 2),
    ]);
    expect(check.arrivals).toEqual(['B', 'C']);
  });

  it('lo conocido son TODOS los presentes, no solo los nuevos', () => {
    const check = detectArrivals(new Set(), [
      ticket('A', 'new'),
      ticket('B', 'in_progress', 1),
      ticket('C', 'done', 2),
    ]);
    expect([...check.known].sort()).toEqual(['A', 'B', 'C']);
  });

  it('un pedido que sale del tablero y vuelve suena otra vez', () => {
    const primero = detectArrivals(new Set(), [ticket('A', 'new')]);
    // Ciclo sin ese pedido: deja de ser conocido.
    const vacio = detectArrivals(primero.known, []);
    expect(vacio.known.size).toBe(0);
    const vuelve = detectArrivals(vacio.known, [ticket('A', 'new')]);
    expect(vuelve.arrivals).toEqual(['A']);
  });

  it('un tablero vacio no inventa llegadas', () => {
    expect(detectArrivals(new Set(), []).arrivals).toEqual([]);
  });
});
