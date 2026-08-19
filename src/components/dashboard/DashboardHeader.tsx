'use client';

import { formatLongDate, formatTime } from '@/lib/dashboard/format';

export function DashboardHeader({
  nowMs,
  lastUpdated,
  refreshing,
  onRefresh,
  soundOn,
  onToggleSound,
}: {
  nowMs: number | null;
  lastUpdated: number | null;
  refreshing: boolean;
  onRefresh: () => void;
  soundOn: boolean;
  onToggleSound: () => void;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-x-3 gap-y-1.5 sm:mb-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Pedidos</h1>
        <p className="text-xs capitalize text-zinc-500 sm:mt-0.5 sm:text-sm">
          {nowMs !== null ? formatLongDate(nowMs) : ' '}
        </p>
      </div>
      <div className="flex items-center gap-2 sm:gap-3">
        <span className="flex items-center gap-1.5 text-xs text-zinc-400">
          <span className={`h-1.5 w-1.5 rounded-full ${refreshing ? 'animate-pulse bg-blue-500' : 'bg-green-500'}`} aria-hidden />
          {lastUpdated ? `Actualizado ${formatTime(new Date(lastUpdated).toISOString())}` : 'Sin actualizar'}
        </span>
        <button
          type="button"
          onClick={onToggleSound}
          aria-pressed={soundOn}
          aria-label={soundOn ? 'Silenciar aviso sonoro de pedidos nuevos' : 'Activar aviso sonoro de pedidos nuevos'}
          title={soundOn ? 'Sonido activado' : 'Sonido silenciado'}
          className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors ${
            soundOn
              ? 'border-green-500/40 bg-green-50 text-green-700 hover:bg-green-100 dark:border-green-500/40 dark:bg-green-950/40 dark:text-green-300'
              : 'border-black/10 text-zinc-700 hover:bg-black/[0.04] dark:border-white/15 dark:text-zinc-200 dark:hover:bg-white/[0.06]'
          }`}
        >
          {soundOn ? '🔔' : '🔕'}
        </button>
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          className="rounded-lg border border-black/10 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-black/[0.04] disabled:opacity-50 dark:border-white/15 dark:text-zinc-200 dark:hover:bg-white/[0.06]"
        >
          {refreshing ? 'Actualizando…' : '↻ Actualizar'}
        </button>
      </div>
    </div>
  );
}
