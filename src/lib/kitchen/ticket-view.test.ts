import { describe, it, expect } from 'vitest';
import {
  enteredAtOf,
  groupItemsByOrder,
  sortByAge,
  toKitchenTickets,
  type RawKitchenItemRow,
  type RawKitchenOrderRow,
} from './ticket-view';
import type { OrderStatus } from '@/types';

const BASE = Date.parse('2026-08-22T12:00:00Z');
const iso = (min: number) => new Date(BASE + min * 60_000).toISOString();

function row(
  id: string,
  status: OrderStatus,
  overrides: Partial<RawKitchenOrderRow> = {},
): RawKitchenOrderRow {
  return {
    id,
    order_number: `ORD-${id}`,
    status,
    delivery_type: 'delivery',
    notes: null,
    created_at: iso(0),
    confirmed_at: null,
    updated_at: iso(0),
    ...overrides,
  };
}

const item = (orderId: string, name: string, quantity: number): RawKitchenItemRow => ({
  order_id: orderId,
  product_name_snapshot: name,
  quantity,
});

describe('ticket — antigüedad medida en cocina', () => {
  it('usa `confirmed_at` cuando existe, y `created_at` como respaldo', () => {
    expect(enteredAtOf(row('1', 'confirmed', { created_at: iso(0), confirmed_at: iso(20) }))).toBe(
      iso(20),
    );
    expect(enteredAtOf(row('2', 'confirmed', { created_at: iso(0), confirmed_at: null }))).toBe(
      iso(0),
    );
  });

  it('el ticket lleva el instante de entrada a cocina, no el del chat', () => {
    const [ticket] = toKitchenTickets(
      [row('1', 'confirmed', { created_at: iso(0), confirmed_at: iso(35) })],
      [],
    );
    expect(ticket.enteredAt).toBe(iso(35));
  });
});

describe('ticket — orden y contenido', () => {
  it('ordena por antigüedad: lo que más espera va primero', () => {
    const rows = [
      row('a', 'confirmed', { confirmed_at: iso(30) }),
      row('b', 'preparing', { confirmed_at: iso(5) }),
      row('c', 'ready', { confirmed_at: iso(15) }),
    ];
    expect(toKitchenTickets(rows, []).map((t) => t.orderNumber)).toEqual([
      'ORD-b',
      'ORD-c',
      'ORD-a',
    ]);
  });

  it('las fechas ilegibles se van al final sin romper el orden', () => {
    const tickets = sortByAge([
      { orderNumber: 'roto', enteredAt: 'no-fecha', stage: 'new', deliveryType: 'pickup', lines: [], notes: null, completedAt: null },
      { orderNumber: 'ok', enteredAt: iso(1), stage: 'new', deliveryType: 'pickup', lines: [], notes: null, completedAt: null },
    ]);
    expect(tickets.map((t) => t.orderNumber)).toEqual(['ok', 'roto']);
  });

  it('agrupa los ítems por pedido y los adjunta al ticket correcto', () => {
    const items = [item('a', 'Trancapecho', 2), item('b', 'Gaseosa 2 L', 1), item('a', 'Api', 3)];
    expect(groupItemsByOrder(items).a).toEqual([
      { name: 'Trancapecho', quantity: 2, modifiers: [] },
      { name: 'Api', quantity: 3, modifiers: [] },
    ]);

    const tickets = toKitchenTickets([row('a', 'confirmed'), row('b', 'preparing')], items);
    expect(tickets.find((t) => t.orderNumber === 'ORD-a')?.lines).toHaveLength(2);
    expect(tickets.find((t) => t.orderNumber === 'ORD-b')?.lines).toHaveLength(1);
  });

  it('un pedido sin ítems no rompe el tablero', () => {
    expect(toKitchenTickets([row('a', 'confirmed')], [])[0].lines).toEqual([]);
  });

  it('los modificadores llegan vacíos pero el campo existe, listo para pintarlos', () => {
    const [ticket] = toKitchenTickets([row('a', 'confirmed')], [item('a', 'Trancapecho', 1)]);
    expect(ticket.lines[0].modifiers).toEqual([]);
  });
});

describe('ticket — qué entra y qué no', () => {
  it('solo entran los estados cocinables; draft y despachados quedan fuera', () => {
    const rows: RawKitchenOrderRow[] = [
      row('1', 'draft'),
      row('2', 'awaiting_location'),
      row('3', 'confirmed'),
      row('4', 'preparing'),
      row('5', 'ready'),
      row('6', 'on_the_way'),
      row('7', 'delivered'),
    ];
    expect(toKitchenTickets(rows, []).map((t) => t.stage)).toEqual([
      'new',
      'in_progress',
      'done',
    ]);
  });

  it('la hora de completado solo viaja en los tickets listos', () => {
    const rows = [
      row('1', 'ready', { updated_at: iso(40) }),
      row('2', 'preparing', { updated_at: iso(40) }),
    ];
    const tickets = toKitchenTickets(rows, []);
    expect(tickets.find((t) => t.stage === 'done')?.completedAt).toBe(iso(40));
    expect(tickets.find((t) => t.stage === 'in_progress')?.completedAt).toBeNull();
  });

  it('las notas del pedido viajan tal cual (texto libre a nivel de pedido)', () => {
    const [ticket] = toKitchenTickets([row('1', 'confirmed', { notes: 'Tocar el timbre' })], []);
    expect(ticket.notes).toBe('Tocar el timbre');
  });
});
