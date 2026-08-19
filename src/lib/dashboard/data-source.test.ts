import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createSupabaseOrdersDataSource, DASHBOARD_HIDDEN_STATUSES } from './data-source';
import type { ListSpec } from './orders-repository';

/**
 * Verifica que la EXCLUSIÓN de `draft` vive en la capa de lectura (la consulta),
 * no solo en la presentación. Se inyecta un cliente Supabase falso que graba las
 * llamadas encadenadas (select/order/range/neq/in/eq/gte/lt/or) y resuelve al
 * hacer `await`. Así se comprueba qué filtros construye el adaptador sin tocar la
 * base real.
 */
type Call = [string, ...unknown[]];

class FakeQuery {
  calls: Call[] = [];
  constructor(private result: { data: unknown; error: unknown }) {}
  private rec(name: string, args: unknown[]): this {
    this.calls.push([name, ...args]);
    return this;
  }
  select(...a: unknown[]) { return this.rec('select', a); }
  order(...a: unknown[]) { return this.rec('order', a); }
  range(...a: unknown[]) { return this.rec('range', a); }
  eq(...a: unknown[]) { return this.rec('eq', a); }
  neq(...a: unknown[]) { return this.rec('neq', a); }
  in(...a: unknown[]) { return this.rec('in', a); }
  gte(...a: unknown[]) { return this.rec('gte', a); }
  lt(...a: unknown[]) { return this.rec('lt', a); }
  or(...a: unknown[]) { return this.rec('or', a); }
  limit(...a: unknown[]) { return this.rec('limit', a); }
  then(resolve: (v: { data: unknown; error: unknown }) => void) { resolve(this.result); }
}

function fakeClient(result: { data: unknown; error: unknown }) {
  const queries: FakeQuery[] = [];
  const client = {
    from() {
      const q = new FakeQuery(result);
      queries.push(q);
      return q;
    },
  } as unknown as SupabaseClient;
  return { client, queries };
}

const baseSpec: ListSpec = {
  statuses: null,
  deliveryType: null,
  since: null,
  until: null,
  search: null,
  limit: 20,
  offset: 0,
};

describe('data-source — draft excluido en la capa de lectura', () => {
  it('la constante declara draft como estado oculto del dashboard', () => {
    expect(DASHBOARD_HIDDEN_STATUSES).toContain('draft');
  });

  it('listOrders excluye draft con .neq incluso SIN filtro (garantía central)', async () => {
    const { client, queries } = fakeClient({ data: [], error: null });
    const ds = createSupabaseOrdersDataSource(client);
    await ds.listOrders(baseSpec);
    const q = queries[0];
    expect(q.calls).toContainEqual(['neq', 'status', 'draft']);
    // No rompe orden ni paginación.
    expect(q.calls).toContainEqual(['order', 'created_at', { ascending: false }]);
    expect(q.calls).toContainEqual(['range', 0, 19]);
    // 6D.1: la lectura incluye payment_method para el chip del dashboard.
    const select = q.calls.find((c) => c[0] === 'select');
    expect(String(select?.[1])).toContain('payment_method');
  });

  it('15. listOrders selecciona los campos de cotización dinámica (6D.2D)', async () => {
    const { client, queries } = fakeClient({ data: [], error: null });
    const ds = createSupabaseOrdersDataSource(client);
    await ds.listOrders(baseSpec);
    const cols = String(queries[0].calls.find((c) => c[0] === 'select')?.[1]);
    expect(cols).toContain('delivery_pricing');
    expect(cols).toContain('delivery_quote_status');
    expect(cols).toContain('delivery_distance_meters');
  });

  it('getDetail también selecciona los campos de cotización dinámica (6D.2D)', async () => {
    const { client, queries } = fakeClient({ data: [], error: null });
    const ds = createSupabaseOrdersDataSource(client);
    await ds.getDetail('ORD-000027');
    const cols = String(queries[0].calls.find((c) => c[0] === 'select')?.[1]);
    expect(cols).toContain('delivery_pricing');
    expect(cols).toContain('delivery_quote_status');
    expect(cols).toContain('delivery_distance_meters');
  });

  it('listOrders combina grupo (.in) + búsqueda (.or) + tipo (.eq) SIN dejar de excluir draft', async () => {
    const { client, queries } = fakeClient({ data: [], error: null });
    const ds = createSupabaseOrdersDataSource(client);
    await ds.listOrders({
      ...baseSpec,
      statuses: ['confirmed', 'preparing'],
      deliveryType: 'delivery',
      search: 'ORD-1',
      offset: 40,
      limit: 20,
    });
    const q = queries[0];
    expect(q.calls).toContainEqual(['neq', 'status', 'draft']);
    expect(q.calls).toContainEqual(['in', 'status', ['confirmed', 'preparing']]);
    expect(q.calls).toContainEqual(['eq', 'delivery_type', 'delivery']);
    expect(q.calls.some((c) => c[0] === 'or')).toBe(true); // búsqueda intacta
    expect(q.calls).toContainEqual(['range', 40, 59]); // paginación intacta
  });

  it('countsByStatus excluye draft del conteo (no cuenta en ningún resumen)', async () => {
    const { client, queries } = fakeClient({ data: [{ status: 'confirmed' }], error: null });
    const ds = createSupabaseOrdersDataSource(client);
    const counts = await ds.countsByStatus('2026-08-09T00:00:00.000Z', null);
    const q = queries[0];
    expect(q.calls).toContainEqual(['neq', 'status', 'draft']);
    expect(q.calls).toContainEqual(['gte', 'created_at', '2026-08-09T00:00:00.000Z']);
    expect(counts).toEqual({ confirmed: 1 });
  });
});
