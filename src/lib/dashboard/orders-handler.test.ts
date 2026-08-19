import { describe, it, expect } from 'vitest';
import { handleListRequest, handleDetailRequest, type DashboardHandlerDeps } from './orders-handler';
import type { OrdersRepository, OrdersListResult } from './orders-repository';
import type { OrderFilters } from './filters';

const LIST: OrdersListResult = {
  summary: { today: 0, preparing: 0, ready: 0, completed: 0 },
  orders: [],
  hasMore: false,
  limit: 20,
  offset: 0,
};

function deps(over: {
  authorized?: boolean;
  onList?: (f: OrderFilters) => Promise<OrdersListResult>;
  onDetail?: (n: string) => Promise<unknown>;
} = {}): DashboardHandlerDeps {
  const repo = {
    async getList(f) {
      return over.onList ? over.onList(f) : LIST;
    },
    async getDetail(n) {
      return (over.onDetail ? await over.onDetail(n) : null) as never;
    },
    async updateStatus() {
      return { ok: false, reason: 'error' } as never;
    },
  } as OrdersRepository;
  return { isAuthorized: () => over.authorized ?? true, repo, now: () => 0 };
}

const req = (url: string) => new Request(url);

describe('orders-handler — lista', () => {
  it('1. sin sesión válida → 401', async () => {
    const res = await handleListRequest(req('http://x/api/dashboard/orders'), deps({ authorized: false }));
    expect(res.status).toBe(401);
  });

  it('2. autorizado → 200 con la lista', async () => {
    const res = await handleListRequest(req('http://x/api/dashboard/orders'), deps());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(LIST);
  });

  it('3/4/5/6. parsea filtros del query string', async () => {
    let seen: OrderFilters | null = null;
    const res = await handleListRequest(
      req('http://x/api/dashboard/orders?statusGroup=en_camino_listos&deliveryType=delivery&search=ORD-1&dateRange=last7&limit=5&offset=10'),
      deps({ onList: async (f) => { seen = f; return LIST; } }),
    );
    expect(res.status).toBe(200);
    expect(seen!).toMatchObject({
      statuses: ['ready', 'on_the_way'],
      deliveryType: 'delivery',
      search: 'ORD-1',
      dateRange: 'last7',
      limit: 5,
      offset: 10,
    });
  });

  it('18. error del repositorio → 500 sanitizado (sin detalle)', async () => {
    const res = await handleListRequest(
      req('http://x/api/dashboard/orders'),
      deps({ onList: async () => { throw new Error('relation "orders" does not exist'); } }),
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: 'internal_error' });
    expect(JSON.stringify(body)).not.toContain('relation');
  });
});

describe('orders-handler — detalle', () => {
  it('sin sesión → 401', async () => {
    const res = await handleDetailRequest(req('http://x/api/dashboard/orders/detail?n=ORD-1'), deps({ authorized: false }));
    expect(res.status).toBe(401);
  });

  it('7. detalle existente → 200', async () => {
    const res = await handleDetailRequest(
      req('http://x/api/dashboard/orders/detail?n=ORD-000001'),
      deps({ onDetail: async () => ({ orderNumber: 'ORD-000001' }) }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ orderNumber: 'ORD-000001' });
  });

  it('detalle inexistente → 404', async () => {
    const res = await handleDetailRequest(req('http://x/api/dashboard/orders/detail?n=ORD-9'), deps({ onDetail: async () => null }));
    expect(res.status).toBe(404);
  });

  it('número de pedido inválido → 400', async () => {
    const res = await handleDetailRequest(req('http://x/api/dashboard/orders/detail?n=' + encodeURIComponent("x'; drop")), deps());
    expect(res.status).toBe(400);
  });

  it('error del repositorio → 500 sanitizado', async () => {
    const res = await handleDetailRequest(
      req('http://x/api/dashboard/orders/detail?n=ORD-1'),
      deps({ onDetail: async () => { throw new Error('pg error 42P01'); } }),
    );
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('42P01');
  });
});
