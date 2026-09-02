'use client';

import { useState, useTransition } from 'react';
import type { MenuCategory, MenuItem } from '@/types';
import { setMenuItemActiveAction } from '@/app/dashboard/actions';
import { categoryLabel } from '@/lib/menu/catalog';
import { formatMoney } from '@/lib/dashboard/format';

/**
 * "Se acabó": retirar un producto del menú y devolverlo.
 *
 * ── Por qué no es una gestión de stock ──────────────────────────────────────
 *
 * No cuenta unidades ni descuenta al vender. Es un interruptor por producto,
 * porque es lo que de verdad pasa en la cocina: no se acaba "una unidad", se
 * acaba el lomito, y quien está atendiendo necesita sacarlo del menú en dos
 * segundos y sin escribir un número.
 *
 * ── Retirar no borra ────────────────────────────────────────────────────────
 *
 * Los pedidos de ayer nombran ese producto y las promociones que lo incluyen
 * siguen existiendo. Una promoción con un componente retirado pasa sola a "No
 * disponible" y vuelve cuando el producto vuelve: no hay que recrear nada.
 *
 * El cambio es optimista —el botón responde al instante y se revierte si el
 * servidor lo rechaza— porque quien lo pulsa está en plena hora punta.
 */
export function MenuAvailability({ items }: { items: MenuItem[] }) {
  // Estado local sobre lo que llegó del servidor: la fila cambia al instante y
  // el `revalidatePath` de la acción trae la verdad en el siguiente render.
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const [pendiente, startTransition] = useTransition();

  const estaActivo = (item: MenuItem): boolean => overrides[item.id] ?? item.is_active;

  const cambiar = (item: MenuItem) => {
    const siguiente = !estaActivo(item);
    setOverrides((prev) => ({ ...prev, [item.id]: siguiente }));
    setError(null);

    startTransition(async () => {
      const res = await setMenuItemActiveAction(item.id, siguiente);
      if (!res.ok) {
        // Se revierte: dejar la fila en "disponible" cuando el servidor no lo
        // aceptó haría que la cocina reciba pedidos de algo que no hay.
        setOverrides((prev) => ({ ...prev, [item.id]: !siguiente }));
        setError(
          res.reason === 'unauthorized'
            ? 'No tienes permiso para esto.'
            : res.reason === 'not_found'
              ? 'Ese producto ya no existe.'
              : 'No se pudo cambiar. Intenta de nuevo.',
        );
      }
    });
  };

  // Por categoría, en el orden del menú: es como se busca un producto cuando se
  // acaba de agotar, no por nombre.
  const grupos = (['plato', 'bebida', 'extra'] as MenuCategory[])
    .map((category) => ({
      category,
      items: items.filter((i) => i.category === category),
    }))
    .filter((g) => g.items.length > 0);

  return (
    <section className="mt-10">
      <h2 className="text-lg font-semibold tracking-tight">🍽 Disponibilidad</h2>
      <p className="mt-1 text-sm text-zinc-500">
        Retira lo que se acabó. Desaparece del menú al instante y vuelve con el mismo botón.
      </p>

      {error !== null && (
        <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </p>
      )}

      {grupos.map((grupo) => (
        <div key={grupo.category} className="mt-5">
          <h3 className="text-xs font-bold uppercase tracking-wide text-zinc-500">
            {categoryLabel(grupo.category)}
          </h3>
          <ul className="mt-2 space-y-2">
            {grupo.items.map((item) => {
              const activo = estaActivo(item);
              return (
                <li
                  key={item.id}
                  className="flex items-center justify-between gap-3 rounded-xl border border-black/[0.07] bg-white px-4 py-3 dark:border-white/10 dark:bg-zinc-900"
                >
                  <div className="min-w-0">
                    <p className={`truncate text-sm ${activo ? '' : 'text-zinc-400 line-through'}`}>
                      {item.name}
                    </p>
                    <p className="text-xs tabular-nums text-zinc-500">{formatMoney(item.price)}</p>
                  </div>

                  <button
                    type="button"
                    onClick={() => cambiar(item)}
                    disabled={pendiente}
                    // El estado va en el texto del botón y en `aria-pressed`,
                    // no solo en el color.
                    aria-pressed={activo}
                    className={`shrink-0 rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-50 ${
                      activo
                        ? 'border-emerald-500/40 bg-emerald-50 text-emerald-800 hover:bg-emerald-100 dark:bg-emerald-950/40 dark:text-emerald-300'
                        : 'border-black/10 text-zinc-500 hover:bg-black/[0.04] dark:border-white/15 dark:hover:bg-white/[0.06]'
                    }`}
                  >
                    {activo ? 'Disponible' : 'Agotado'}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </section>
  );
}
