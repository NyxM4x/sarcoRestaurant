'use client';

import { DELIVERY_TYPES } from '@/types';
import { deliveryTypeLabel } from '@/lib/dashboard/format';
import {
  type DateRange,
  STATUS_GROUP_ORDER,
  STATUS_GROUP_LABELS,
} from '@/lib/dashboard/filters';

export interface FilterState {
  /** Grupo operativo (clave de STATUS_GROUPS) o '' para todos. */
  statusGroup: string;
  deliveryType: string;
  dateRange: DateRange;
  search: string;
}

const DATE_OPTIONS: Array<{ value: DateRange; label: string }> = [
  { value: 'today', label: 'Hoy' },
  { value: 'yesterday', label: 'Ayer' },
  { value: 'last7', label: '7 días' },
  { value: 'all', label: 'Todos' },
];

const selectCls =
  'rounded-lg border border-black/10 bg-white px-3 py-2 text-sm text-zinc-800 shadow-sm ' +
  'focus:border-zinc-400 focus:outline-none focus:ring-2 focus:ring-zinc-900/10 ' +
  'dark:border-white/15 dark:bg-zinc-900 dark:text-zinc-100 dark:focus:ring-white/10';

export function OrderFilters({
  value,
  onChange,
}: {
  value: FilterState;
  onChange: (next: FilterState) => void;
}) {
  const set = (patch: Partial<FilterState>) => onChange({ ...value, ...patch });

  return (
    <div className="flex flex-col gap-3">
      {/* Buscador: presencia principal */}
      <div className="relative">
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" aria-hidden>🔍</span>
        <input
          type="search"
          inputMode="search"
          placeholder="Buscar por N.º de pedido o cliente…"
          aria-label="Buscar por número de pedido o cliente"
          className={`w-full rounded-lg border border-black/10 bg-white py-2.5 pl-9 pr-3 text-sm shadow-sm focus:border-zinc-400 focus:outline-none focus:ring-2 focus:ring-zinc-900/10 dark:border-white/15 dark:bg-zinc-900 dark:focus:ring-white/10`}
          value={value.search}
          onChange={(e) => set({ search: e.target.value })}
        />
      </div>

      {/* Selector temporal + filtros secundarios */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-0.5 overflow-x-auto rounded-lg bg-black/[0.04] p-0.5 dark:bg-white/[0.06]" role="group" aria-label="Rango de fecha">
          {DATE_OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              aria-pressed={value.dateRange === o.value}
              onClick={() => set({ dateRange: o.value })}
              className={`whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition ${
                value.dateRange === o.value
                  ? 'bg-white text-zinc-900 shadow-sm dark:bg-zinc-700 dark:text-white'
                  : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>

        <span className="hidden h-5 w-px bg-black/10 dark:bg-white/10 sm:block" aria-hidden />

        <select aria-label="Filtrar por etapa" className={selectCls} value={value.statusGroup} onChange={(e) => set({ statusGroup: e.target.value })}>
          <option value="">Todas las etapas</option>
          {STATUS_GROUP_ORDER.map((g) => (
            <option key={g} value={g}>{STATUS_GROUP_LABELS[g]}</option>
          ))}
        </select>

        <select aria-label="Filtrar por tipo de entrega" className={selectCls} value={value.deliveryType} onChange={(e) => set({ deliveryType: e.target.value })}>
          <option value="">Delivery y recojo</option>
          {DELIVERY_TYPES.map((d) => (
            <option key={d} value={d}>{deliveryTypeLabel(d)}</option>
          ))}
        </select>
      </div>
    </div>
  );
}
