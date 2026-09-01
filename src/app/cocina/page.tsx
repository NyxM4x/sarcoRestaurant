import { createKitchenRepository, type KitchenBoard } from '@/lib/kitchen/tickets-repository';
import { createSupabaseKitchenDataSource } from '@/lib/kitchen/data-source';
import { KitchenBoardScreen } from '@/components/kitchen/KitchenBoardScreen';

export const dynamic = 'force-dynamic';

/**
 * Tablero de cocina (Server Component). Carga los tickets del dia con el
 * cliente `service_role` —que jamas llega al navegador— y entrega al componente
 * cliente una vista ya sanitizada, que despues refresca por polling.
 */
export default async function KitchenPage() {
  // Server Component: leer el reloj del servidor es intencional (jornada "hoy"),
  // y ademas es el reloj con el que hidrata el cliente.
  // eslint-disable-next-line react-hooks/purity
  const now = Date.now();

  // `paymentsAvailable: false` en el arranque vacio: sin haber consultado nada
  // no se puede afirmar que el pago este verificado.
  let initial: KitchenBoard = { tickets: [], serverNow: now, paymentsAvailable: false };
  try {
    const repo = createKitchenRepository(createSupabaseKitchenDataSource());
    initial = await repo.getBoard(now);
  } catch {
    // Si la carga inicial falla, el tablero se recupera en el siguiente polling.
    initial = { tickets: [], serverNow: now, paymentsAvailable: false };
  }

  return <KitchenBoardScreen initial={initial} serverNow={now} />;
}
