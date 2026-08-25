'use client';

import type { KitchenCounters } from '@/lib/kitchen/summary';

/**
 * Barra superior oscura del KDS. Todos los contadores se reciben ya derivados
 * de la lista de tickets: este componente no guarda ni calcula nada por su
 * cuenta, para que no haya numeros que se queden estaticos.
 */
export interface KitchenTopBarProps {
  counters: KitchenCounters;
  refreshing: boolean;
  offline: boolean;
  onOpenReady: () => void;
  onLogout: () => void;
}

function Counter({ label, value, accent }: { label: string; value: number; accent: string }) {
  return (
    <div className="flex flex-col leading-tight">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
        {label}
      </span>
      <span className={`text-2xl font-extrabold tabular-nums ${accent}`}>{value}</span>
    </div>
  );
}

export function KitchenTopBar({
  counters,
  refreshing,
  offline,
  onOpenReady,
  onLogout,
}: KitchenTopBarProps) {
  return (
    <header className="flex shrink-0 items-center gap-6 bg-zinc-900 px-5 py-3 text-white">
      <div className="flex items-center gap-3">
        <span className="grid h-10 w-10 place-items-center rounded-xl bg-white text-sm font-bold text-zinc-900">
          DZ
        </span>
        <span className="hidden text-base font-bold tracking-tight sm:block">COCINA</span>
      </div>

      <div className="flex flex-1 items-center gap-6 overflow-x-auto">
        <Counter label="Pedidos hoy" value={counters.today} accent="text-white" />
        <Counter label="Pendientes" value={counters.pending} accent="text-amber-300" />
        <Counter label="En preparación" value={counters.inProgress} accent="text-sky-300" />
      </div>

      {offline && (
        <span className="rounded-lg bg-red-600 px-3 py-1 text-xs font-bold uppercase tracking-wide">
          Sin conexión
        </span>
      )}
      {refreshing && !offline && (
        <span className="text-xs font-medium text-zinc-500" aria-live="polite">
          Actualizando…
        </span>
      )}

      <button
        type="button"
        onClick={onOpenReady}
        className="h-14 shrink-0 rounded-xl bg-emerald-600 px-5 text-base font-extrabold tracking-wide hover:bg-emerald-500 active:bg-emerald-700"
      >
        Listos: {counters.done}
      </button>

      <button
        type="button"
        onClick={onLogout}
        className="shrink-0 text-xs font-medium text-zinc-400 underline-offset-2 hover:text-white hover:underline"
      >
        Salir
      </button>
    </header>
  );
}
