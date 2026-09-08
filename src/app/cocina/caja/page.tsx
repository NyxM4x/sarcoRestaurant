import { createKitchenRepository, type KitchenBoard } from '@/lib/kitchen/tickets-repository';
import { createSupabaseKitchenDataSource } from '@/lib/kitchen/data-source';
import { KitchenBoardScreen } from '@/components/kitchen/KitchenBoardScreen';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Caja — Don Zarco Orders',
};

/**
 * Pantalla de CAJA (07-09-2026).
 *
 * El primer paso del flujo, y el único que hace: llega el pedido, se mira el
 * comprobante y se acepta o se rechaza. Al aceptarlo, ese ticket desaparece de
 * aquí y aparece en `/cocina/plancha`.
 *
 * ── Por qué es una ruta nueva y no un cambio en `/cocina` ───────────────────
 *
 * Porque el local todavía tiene UNA laptop. `/cocina` sigue siendo la pantalla
 * completa —las dos funciones juntas— y no cambia ni una línea: es lo que hay en
 * producción esta noche y lo que va a seguir usándose hasta que llegue la
 * segunda. Estas dos rutas se estrenan el día que haya dos pantallas, abriendo
 * una en cada una, y `/cocina` no deja de existir por eso: es la que sirve
 * cuando el cajero no está.
 *
 * Mismo repositorio, mismo endpoint de refresco y mismo permiso —el layout de
 * `/cocina` ya exige `canAccessKitchen`— así que no hay rol nuevo que crear ni
 * usuario que dar de alta. Las dos laptops entran con la misma cuenta de cocina
 * y cada una abre su URL.
 */
export default async function CajaPage() {
  // eslint-disable-next-line react-hooks/purity
  const now = Date.now();

  let initial: KitchenBoard = { tickets: [], serverNow: now, paymentsAvailable: false };
  try {
    const repo = createKitchenRepository(createSupabaseKitchenDataSource());
    initial = await repo.getBoard(now);
  } catch {
    initial = { tickets: [], serverNow: now, paymentsAvailable: false };
  }

  return <KitchenBoardScreen initial={initial} serverNow={now} view="cashier" />;
}
