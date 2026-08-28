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
  /** ¿Suena la campana al entrar un pedido? Ausente = no se pinta el boton. */
  soundOn?: boolean;
  onToggleSound?: () => void;
  /** El aviso esta encendido pero el navegador todavia no deja sonar. */
  soundBlocked?: boolean;
}

/** Campana (activa) y campana tachada (silenciada). */
function BellIcon({ muted }: { muted: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-6 w-6"
      aria-hidden="true"
    >
      {muted ? (
        <path d="M9.14 17.08a24.2 24.2 0 0 0 3.85.15m-3.85-.15a23.9 23.9 0 0 1-5.45-1.31 8.96 8.96 0 0 0 2.3-5.54m3.15 6.85a3 3 0 0 0 5.67 1.97m1.96-2.28a23.8 23.8 0 0 0 3.54-1 8.97 8.97 0 0 1-2.31-6.02V9A6 6 0 0 0 6.53 6.53M3 3l18 18" />
      ) : (
        <path d="M14.86 17.08a23.85 23.85 0 0 0 5.45-1.31A8.97 8.97 0 0 1 18 9.75V9A6 6 0 0 0 6 9v.75a8.97 8.97 0 0 1-2.31 6.02c1.73.64 3.56 1.09 5.45 1.31m5.72 0a24.26 24.26 0 0 1-5.72 0m5.72 0a3 3 0 1 1-5.72 0" />
      )}
    </svg>
  );
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
  soundOn,
  onToggleSound,
  soundBlocked = false,
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

      {/* Aviso mudo: el navegador no deja sonar hasta que alguien toque la
          pantalla. Sin este cartel, la cocina creeria que la campana funciona. */}
      {soundOn === true && soundBlocked && (
        <span className="hidden shrink-0 rounded-lg bg-amber-500 px-3 py-1 text-xs font-bold uppercase tracking-wide text-zinc-900 sm:block">
          Toca la pantalla para activar el sonido
        </span>
      )}

      {soundOn !== undefined && onToggleSound && (
        <button
          type="button"
          onClick={onToggleSound}
          aria-pressed={soundOn}
          title={soundOn ? 'Silenciar el aviso de pedidos nuevos' : 'Activar el aviso sonoro'}
          className={`grid h-14 w-14 shrink-0 place-items-center rounded-xl transition-colors ${
            soundOn
              ? 'bg-zinc-800 text-white hover:bg-zinc-700'
              : 'bg-zinc-800 text-zinc-500 hover:bg-zinc-700 hover:text-zinc-300'
          }`}
        >
          <BellIcon muted={!soundOn} />
          <span className="sr-only">
            {soundOn ? 'Aviso sonoro activado' : 'Aviso sonoro silenciado'}
          </span>
        </button>
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
