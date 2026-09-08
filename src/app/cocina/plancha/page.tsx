import { createKitchenRepository, type KitchenBoard } from '@/lib/kitchen/tickets-repository';
import { createSupabaseKitchenDataSource } from '@/lib/kitchen/data-source';
import { KitchenBoardScreen } from '@/components/kitchen/KitchenBoardScreen';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Cocina — Don Zarco Orders',
};

/**
 * Pantalla de PLANCHA (07-09-2026).
 *
 * Lo que ya se puede cocinar: el pago aceptado por caja, o el pedido en efectivo
 * —que no tiene comprobante que aceptar y por eso no pasa por allí—. Aquí viven
 * INICIAR, COMPLETAR y el panel de "Listos".
 *
 * El resumen de la barra derecha cuenta solo lo que llega a esta pantalla, que
 * es justo lo que el planchero necesita: unidades en firme, sin los pedidos cuyo
 * pago todavía está por confirmar.
 *
 * Ver `/cocina/caja` para por qué esto son rutas nuevas y `/cocina` se queda
 * exactamente como está.
 */
export default async function PlanchaPage() {
  // eslint-disable-next-line react-hooks/purity
  const now = Date.now();

  let initial: KitchenBoard = { tickets: [], serverNow: now, paymentsAvailable: false };
  try {
    const repo = createKitchenRepository(createSupabaseKitchenDataSource());
    initial = await repo.getBoard(now);
  } catch {
    initial = { tickets: [], serverNow: now, paymentsAvailable: false };
  }

  return <KitchenBoardScreen initial={initial} serverNow={now} view="line" />;
}
