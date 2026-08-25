'use client';

import type { KitchenSummary } from '@/lib/kitchen/summary';

/**
 * Panel derecho fijo: RESUMEN DE COCINA.
 *
 * Suma las cantidades de cada producto de TODOS los pedidos activos del tablero
 * (nuevos + en preparacion) para cocinar por lotes. Recibe el resumen ya
 * derivado de la lista de tickets: al completar un pedido baja solo, y al
 * devolverlo a cocina vuelve a subir, sin ningun estado que sincronizar.
 */
export function KitchenSummaryPanel({ summary }: { summary: KitchenSummary }) {
  return (
    <aside className="flex w-[300px] shrink-0 flex-col overflow-hidden bg-zinc-900 text-white">
      <div className="shrink-0 border-b border-white/10 px-5 py-4">
        <h2 className="text-sm font-extrabold uppercase tracking-widest text-zinc-300">
          Resumen de cocina
        </h2>
        <p className="mt-1 text-xs font-medium text-zinc-400">
          <span className="tabular-nums text-white">{summary.totalUnits}</span> unidades ·{' '}
          <span className="tabular-nums text-white">{summary.activeOrders}</span>{' '}
          {summary.activeOrders === 1 ? 'pedido activo' : 'pedidos activos'}
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {summary.rows.length === 0 ? (
          <p className="px-2 py-6 text-center text-sm text-zinc-500">Nada pendiente por cocinar.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {summary.rows.map((row) => (
              <li
                key={row.name}
                className="flex items-baseline gap-3 rounded-lg px-2 py-2 odd:bg-white/5"
              >
                <span className="w-12 shrink-0 text-right text-xl font-extrabold tabular-nums text-amber-300">
                  {row.quantity}x
                </span>
                <span className="text-sm font-semibold leading-snug text-zinc-100">{row.name}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}
