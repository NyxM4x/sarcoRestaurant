/**
 * Controlador de polling — modulo PURO (sin React, testeable).
 *
 * Garantias:
 *  - NUNCA solapa dos ejecuciones (si `onTick` sigue en curso, salta el ciclo);
 *  - un solo temporizador activo (start() es idempotente: no duplica timers);
 *  - se puede pausar cuando la pestana esta oculta.
 *
 * No usa `setInterval` con periodo fijo: reprograma tras cada tick para no
 * encolar ejecuciones si una consulta tarda mas que el intervalo.
 */
export interface PollingTimers {
  setTimer: (cb: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
}

export interface PollingOptions {
  intervalMs: number;
  onTick: () => void | Promise<void>;
  /** Si devuelve false, el ciclo se salta (p. ej. pestana oculta). */
  isActive?: () => boolean;
  timers?: PollingTimers;
}

export interface PollingController {
  start(): void;
  stop(): void;
  isRunning(): boolean;
}

const MIN_INTERVAL_MS = 5_000;

export function createPollingController(opts: PollingOptions): PollingController {
  const interval = Math.max(opts.intervalMs, MIN_INTERVAL_MS);
  const timers: PollingTimers = opts.timers ?? {
    setTimer: (cb, ms) => setTimeout(cb, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  };
  const isActive = opts.isActive ?? (() => true);

  let handle: unknown = null;
  let running = false;
  let ticking = false;

  const schedule = () => {
    // Un unico timer vivo: si ya hay uno, no se crea otro.
    if (!running || handle !== null) return;
    handle = timers.setTimer(run, interval);
  };

  const run = () => {
    handle = null;
    if (!running) return;
    if (ticking || !isActive()) {
      // Sin solape ni trabajo cuando esta inactivo: reprograma el siguiente.
      schedule();
      return;
    }
    ticking = true;
    Promise.resolve()
      .then(() => opts.onTick())
      .catch(() => {})
      .finally(() => {
        ticking = false;
        schedule();
      });
  };

  return {
    start() {
      if (running) return; // idempotente: no duplica temporizadores
      running = true;
      schedule();
    },
    stop() {
      running = false;
      if (handle !== null) {
        timers.clearTimer(handle);
        handle = null;
      }
    },
    isRunning() {
      return running;
    },
  };
}
