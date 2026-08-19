/**
 * Handlers HTTP del dashboard — modulo con dependencias INYECTADAS.
 *
 * Solo lectura (lista + detalle) para el polling del navegador. Autenticacion
 * por cookie de sesion verificada en servidor; errores SIEMPRE sanitizados
 * (nunca SQL, stack, ni datos tecnicos). No expone el cliente service_role.
 */
import { normalizeFilters } from './filters';
import type { OrdersRepository } from './orders-repository';

export interface DashboardHandlerDeps {
  /** Verifica la cookie de sesion del request. */
  isAuthorized(request: Request): boolean;
  repo: OrdersRepository;
  now(): number;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

/** `GET /api/dashboard/orders` — lista paginada + resumen (para polling). */
export async function handleListRequest(
  request: Request,
  deps: DashboardHandlerDeps,
): Promise<Response> {
  if (!deps.isAuthorized(request)) return json(401, { error: 'unauthorized' });

  const url = new URL(request.url);
  const q = url.searchParams;
  const filters = normalizeFilters({
    statusGroup: q.get('statusGroup'),
    status: q.get('status'),
    deliveryType: q.get('deliveryType'),
    dateRange: q.get('dateRange'),
    search: q.get('search'),
    limit: q.get('limit'),
    offset: q.get('offset'),
  });

  try {
    const result = await deps.repo.getList(filters, deps.now());
    return json(200, result);
  } catch {
    // Nunca se filtra el detalle del error (SQL, stack, etc.).
    return json(500, { error: 'internal_error' });
  }
}

/** `GET /api/dashboard/orders/detail?n=ORD-000001` — detalle sanitizado. */
export async function handleDetailRequest(
  request: Request,
  deps: DashboardHandlerDeps,
): Promise<Response> {
  if (!deps.isAuthorized(request)) return json(401, { error: 'unauthorized' });

  const url = new URL(request.url);
  const orderNumber = (url.searchParams.get('n') ?? '').trim();
  if (!/^[A-Za-z0-9-]{1,40}$/.test(orderNumber)) {
    return json(400, { error: 'invalid_order_number' });
  }

  try {
    const detail = await deps.repo.getDetail(orderNumber);
    if (!detail) return json(404, { error: 'not_found' });
    return json(200, detail);
  } catch {
    return json(500, { error: 'internal_error' });
  }
}
