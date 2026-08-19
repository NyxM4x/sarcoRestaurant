import { describe, it, expect } from 'vitest';
import { createOrdersRepository, type OrdersDataSource, type ListSpec } from './orders-repository';
import { normalizeFilters } from './filters';
import type { RawOrderRow } from './order-view';

const NOW = Date.parse('2026-08-06T15:00:00.000Z');

function row(id: string, over: Partial<RawOrderRow> = {}): RawOrderRow {
  return {
    id,
    order_number: 'ORD-' + id,
    customer_name: 'Cliente ' + id,
    customer_phone: '59170000000',
    delivery_type: 'pickup',
    status: 'confirmed',
    subtotal_amount: 10,
    delivery_amount: 0,
    total_amount: 10,
    currency: 'BOB',
    notes: null,
    payment_method: null,
    delivery_address: null,
    delivery_location_name: null,
    delivery_latitude: null,
    delivery_longitude: null,
    created_at: '2026-08-06T14:00:00.000Z',
    updated_at: '2026-08-06T14:00:00.000Z',
    confirmed_at: null,
    ...over,
  };
}

function fakeSource(over: Partial<OrdersDataSource> = {}) {
  const calls: { list?: ListSpec; update?: [string, string, string] } = {};
  const base: OrdersDataSource = {
    async listOrders(spec) {
      calls.list = spec;
      return { rows: [], itemCounts: {}, flags: {} };
    },
    async countsByStatus() {
      return { confirmed: 2, preparing: 1 };
    },
    async getDetail() {
      return null;
    },
    async getMeta() {
      return { status: 'confirmed', deliveryType: 'pickup' };
    },
    async updateStatus(n, from, to) {
      calls.update = [n, from, to];
      return 'updated';
    },
  };
  return { source: { ...base, ...over }, calls };
}

describe('orders-repository — lista, filtros, detalle', () => {
  it('2/17. getList mapea filas y resume; lista vacía es válida', async () => {
    const { source } = fakeSource();
    const repo = createOrdersRepository(source);
    const result = await repo.getList(normalizeFilters({}), NOW);
    expect(result.orders).toEqual([]);
    // countsByStatus = {confirmed:2, preparing:1} → todo cae en "En preparación".
    expect(result.summary).toEqual({ today: 3, preparing: 3, ready: 0, completed: 0 });
  });

  it('3/4/5. pasa el conjunto de estados del grupo, tipo de entrega y búsqueda a la fuente', async () => {
    const { source, calls } = fakeSource();
    const repo = createOrdersRepository(source);
    await repo.getList(
      normalizeFilters({ statusGroup: 'en_camino_listos', deliveryType: 'delivery', search: 'ORD-1', dateRange: 'all' }),
      NOW,
    );
    expect(calls.list?.statuses).toEqual(['ready', 'on_the_way']);
    expect(calls.list?.deliveryType).toBe('delivery');
    expect(calls.list?.search).toBe('ORD-1');
  });

  it('6. pide limit+1 y calcula hasMore, recortando a la página', async () => {
    let seenLimit = 0;
    const { source } = fakeSource({
      async listOrders(spec) {
        seenLimit = spec.limit;
        // Devuelve limit+1 filas (spec.limit ya es filters.limit+1).
        const rows = Array.from({ length: spec.limit }, (_, i) => row(String(i)));
        const itemCounts = Object.fromEntries(rows.map((r) => [r.id, 2]));
        return { rows, itemCounts, flags: {} };
      },
    });
    const repo = createOrdersRepository(source);
    const result = await repo.getList(normalizeFilters({ limit: 5 }), NOW);
    expect(seenLimit).toBe(6); // 5 + 1
    expect(result.orders).toHaveLength(5);
    expect(result.hasMore).toBe(true);
    expect(result.orders[0].itemCount).toBe(2);
  });

  it('aplica banderas de notificación sanitizadas por pedido', async () => {
    const { source } = fakeSource({
      async listOrders() {
        return {
          rows: [row('a')],
          itemCounts: { a: 1 },
          flags: { a: { manualReview: true, notificationIssue: true } },
        };
      },
    });
    const result = await createOrdersRepository(source).getList(normalizeFilters({}), NOW);
    expect(result.orders[0].manualReview).toBe(true);
    expect(result.orders[0].notificationIssue).toBe(true);
  });

  it('7. getDetail devuelve detalle sanitizado o null', async () => {
    const { source } = fakeSource({
      async getDetail() {
        return {
          row: row('a', { order_number: 'ORD-000001' }),
          items: [{ product_name_snapshot: 'X', unit_price_snapshot: 5, quantity: 2, subtotal: 10 }],
          flags: { manualReview: false, notificationIssue: false },
        };
      },
    });
    const repo = createOrdersRepository(source);
    const detail = await repo.getDetail('ORD-000001');
    expect(detail?.orderNumber).toBe('ORD-000001');
    expect(detail?.items).toHaveLength(1);
    expect(JSON.stringify(detail)).not.toContain('"id"');
    expect(await createOrdersRepository(fakeSource().source).getDetail('nope')).toBeNull();
  });
});

describe('orders-repository — actualización de estado', () => {
  it('9. transición válida actualiza con guarda optimista (from, to)', async () => {
    // getMeta por defecto = confirmed/pickup → avance operativo a "ready".
    const { source, calls } = fakeSource();
    const repo = createOrdersRepository(source);
    const out = await repo.updateStatus('ORD-1', 'ready');
    expect(out).toEqual({ ok: true, status: 'ready' });
    expect(calls.update).toEqual(['ORD-1', 'confirmed', 'ready']);
  });

  it('10. transición inválida se rechaza SIN llamar a la fuente', async () => {
    const { source, calls } = fakeSource();
    const out = await createOrdersRepository(source).updateStatus('ORD-1', 'delivered');
    expect(out).toEqual({ ok: false, reason: 'invalid_transition' });
    expect(calls.update).toBeUndefined();
  });

  it('no degrada un pedido terminal', async () => {
    const { source } = fakeSource({ async getMeta() { return { status: 'delivered', deliveryType: 'pickup' }; } });
    expect(await createOrdersRepository(source).updateStatus('ORD-1', 'preparing')).toEqual({ ok: false, reason: 'terminal' });
  });

  it('11. doble actualización: la fuente responde conflict (estado ya cambiado)', async () => {
    // confirmed/pickup → 'ready' es válido; la fuente simula el conflicto.
    const { source } = fakeSource({ async updateStatus() { return 'conflict'; } });
    expect(await createOrdersRepository(source).updateStatus('ORD-1', 'ready')).toEqual({ ok: false, reason: 'conflict' });
  });

  it('pedido inexistente → not_found', async () => {
    const { source } = fakeSource({ async getMeta() { return null; } });
    expect(await createOrdersRepository(source).updateStatus('ORD-9', 'preparing')).toEqual({ ok: false, reason: 'not_found' });
  });
});
