import { createMenuRepository } from '@/lib/menu';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import { createPromotionsRepository } from '@/lib/promotions/repository';
import type { Promotion } from '@/lib/promotions/promotion';
import type { MenuItem } from '@/types';
import { PromotionsManager } from '@/components/dashboard/PromotionsManager';
import { MenuAvailability } from '@/components/dashboard/MenuAvailability';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Configuración — Don Zarco Orders',
};

/**
 * Configuración del panel (Server Component).
 *
 * Lee con `service_role` en el servidor y entrega datos ya resueltos al
 * componente cliente. El navegador nunca ve la clave ni consulta la base.
 *
 * Lo que todavía no existe sigue enumerado abajo como "próximamente": es más
 * honesto que una pantalla que parece completa y no lo está.
 */
export default async function ConfiguracionPage() {
  // Server Component: leer el reloj del servidor es intencional. Se pasa como
  // prop para que el estado de cada promoción —vencida, programada— se calcule
  // con la hora del servidor y no con la del celular de quien mira.
  // eslint-disable-next-line react-hooks/purity
  const serverNow = Date.now();

  let promotions: Promotion[] = [];
  let catalog: MenuItem[] = [];
  let todos: MenuItem[] = [];
  let cargaFallida = false;

  try {
    const supabase = getSupabaseAdmin();
    // En paralelo: son dos lecturas independientes y encadenarlas solo sumaría
    // latencia a una pantalla que ya espera por la red.
    [promotions, todos] = await Promise.all([
      createPromotionsRepository(supabase).list(),
      // TODOS: la pantalla de disponibilidad necesita ver también lo agotado
      // para poder devolverlo al menú.
      createMenuRepository(supabase).listAll(),
    ]);
    // Al formulario de promociones solo van los ACTIVOS: son los únicos que
    // pueden entrar en un combo nuevo.
    catalog = todos.filter((item) => item.is_active);
  } catch {
    // Sin detalle en pantalla: el error va al log del servidor y aquí se dice
    // lo único accionable, que es volver a intentarlo.
    cargaFallida = true;
  }

  const upcoming = [
    'Edición de productos y precios',
    'Datos del restaurante y horarios',
    'Usuarios y roles del panel',
    'Preferencias de notificaciones',
  ];

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-semibold tracking-tight">Configuración</h1>

      {cargaFallida ? (
        <p className="mt-6 rounded-xl border border-black/[0.07] bg-white px-4 py-3 text-sm text-zinc-600 dark:border-white/10 dark:bg-zinc-900 dark:text-zinc-300">
          No pudimos cargar la configuración. Recarga la página en un momento.
        </p>
      ) : (
        <>
          <MenuAvailability items={todos} />
          <PromotionsManager initial={promotions} catalog={catalog} serverNow={serverNow} />
        </>
      )}

      <section className="mt-10">
        <h2 className="text-lg font-semibold tracking-tight">Más adelante</h2>
        <p className="mt-1 text-sm text-zinc-500">Estas opciones estarán disponibles próximamente.</p>

        <ul className="mt-4 space-y-2">
          {upcoming.map((item) => (
            <li
              key={item}
              className="flex items-center justify-between rounded-xl border border-black/[0.07] bg-white px-4 py-3 text-sm dark:border-white/10 dark:bg-zinc-900"
            >
              <span className="text-zinc-700 dark:text-zinc-200">{item}</span>
              <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-500 dark:bg-zinc-800">
                Próximamente
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
