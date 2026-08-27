import { createOrdersRepository, type OrdersListResult } from '@/lib/dashboard/orders-repository';
import { createSupabaseOrdersDataSource } from '@/lib/dashboard/data-source';
import { normalizeFilters } from '@/lib/dashboard/filters';
import { OrdersDashboard } from '@/components/dashboard/OrdersDashboard';
import { readRainSurcharge } from '@/lib/delivery/quote-service';

export const dynamic = 'force-dynamic';

const EMPTY: OrdersListResult = {
  summary: { today: 0, preparing: 0, ready: 0, completed: 0 },
  orders: [],
  hasMore: false,
  limit: 20,
  offset: 0,
};

/**
 * Página de pedidos (Server Component). Carga la primera página server-side con
 * el cliente `service_role` (nunca en el navegador) y entrega datos ya
 * sanitizados al componente cliente, que hace polling contra el route handler.
 */
export default async function OrdersPage() {
  // Server Component: leer el reloj del servidor es intencional (fecha "hoy").
  // eslint-disable-next-line react-hooks/purity
  const now = Date.now();

  // El interruptor de lluvia se lee aqui, en servidor. Si falla se asume
  // apagado: cobrar de menos por un fallo nuestro es preferible a cobrar de mas.
  let rainSurcharge = false;
  try {
    rainSurcharge = await readRainSurcharge();
  } catch {
    rainSurcharge = false;
  }

  let initial = EMPTY;
  try {
    const repo = createOrdersRepository(createSupabaseOrdersDataSource());
    initial = await repo.getList(normalizeFilters({ dateRange: 'today' }), now);
  } catch {
    // Si la carga inicial falla, el cliente reintentará vía polling/refresh.
    initial = EMPTY;
  }

  return <OrdersDashboard initial={initial} serverNow={now} rainSurcharge={rainSurcharge} />;
}
