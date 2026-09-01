'use client';

import { useState, useTransition } from 'react';
import { setRainSurchargeAction, sweepExpiredOrdersAction } from '@/app/dashboard/actions';
import { formatLongDate, formatTime } from '@/lib/dashboard/format';

export function DashboardHeader({
  nowMs,
  lastUpdated,
  refreshing,
  onRefresh,
  soundOn,
  onToggleSound,
  rainSurcharge = false,
}: {
  nowMs: number | null;
  lastUpdated: number | null;
  refreshing: boolean;
  onRefresh: () => void;
  soundOn: boolean;
  onToggleSound: () => void;
  /** Estado inicial del recargo por lluvia, leído en servidor. */
  rainSurcharge?: boolean;
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
        <SweepExpiredButton />
        <RainSurchargeToggle initial={rainSurcharge} />
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

/**
 * Cierra los pedidos cuya ventana de gracia venció (0028).
 *
 * ── Por qué es un botón y no ocurre solo ────────────────────────────────────
 *
 * Cuando cocina rechaza un comprobante, el cliente tiene quince minutos para
 * reenviar otro. Pasado ese plazo el pedido ya no puede cocinarse —el KDS lo
 * enseña así y su botón de INICIAR está bloqueado— pero su estado en la base
 * sigue siendo `confirmed` hasta que alguien lo cierra.
 *
 * Ese "alguien" es este botón, y es deliberado: cancelar es terminal, y una
 * cancelación automática a las tres de la mañana no la revisa nadie. Aquí la
 * pulsa una persona que está mirando la pantalla.
 *
 * No cancela nada que esté en la plancha: solo lo que nunca llegó a empezarse.
 */
function SweepExpiredButton() {
  const [pending, startTransition] = useTransition();
  const [resultado, setResultado] = useState<string | null>(null);

  const barrer = () => {
    setResultado(null);
    startTransition(async () => {
      const res = await sweepExpiredOrdersAction();
      if (!res.ok) {
        setResultado('Sin permiso');
        return;
      }
      // Decir "0" es informativo, no un fallo: significa que no hay nada
      // colgando, que es la respuesta que se espera la mayoría de las veces.
      setResultado(
        res.cancelled === 0 ? 'Nada que cerrar' : `${res.cancelled} cerrado${res.cancelled === 1 ? '' : 's'}`,
      );
    });
  };

  return (
    <button
      type="button"
      onClick={barrer}
      disabled={pending}
      title="Cancelar los pedidos cuyo plazo para reenviar el comprobante ya venció"
      className="rounded-lg border border-black/10 px-3 py-1.5 text-sm font-medium text-zinc-700 transition-colors hover:bg-black/[0.04] disabled:opacity-50 dark:border-white/15 dark:text-zinc-200 dark:hover:bg-white/[0.06]"
    >
      {pending ? 'Cerrando…' : (resultado ?? 'Limpiar expirados')}
    </button>
  );
}

/**
 * Interruptor de la tarifa de lluvia (+3 Bs).
 *
 * Estado optimista: el botón cambia al instante y se revierte si el servidor lo
 * rechaza. Quien lo pulsa está mirando por la ventana y necesita que la tarifa
 * cambie ya, no dentro de un ciclo de refresco.
 *
 * Afecta solo a las cotizaciones NUEVAS. Los pedidos ya cotizados conservan su
 * precio: el cliente vio una cifra y esa es la que vale.
 */
function RainSurchargeToggle({ initial }: { initial: boolean }) {
  const [active, setActive] = useState(initial);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState(false);

  const toggle = () => {
    const siguiente = !active;
    setActive(siguiente);
    setError(false);
    startTransition(async () => {
      const res = await setRainSurchargeAction(siguiente);
      if (!res.ok) {
        // Se revierte: dejar el botón encendido cuando el servidor no lo aceptó
        // haría cobrar de menos creyendo que se cobra de más.
        setActive(!siguiente);
        setError(true);
      }
    });
  };

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={pending}
      aria-pressed={active}
      aria-label={
        active ? 'Desactivar tarifa de lluvia (+3 Bs)' : 'Activar tarifa de lluvia (+3 Bs)'
      }
      title={
        error
          ? 'No se pudo cambiar la tarifa'
          : active
            ? 'Tarifa lluvia ACTIVA: +3 Bs en cada envío nuevo'
            : 'Tarifa lluvia apagada'
      }
      className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-50 ${
        error
          ? 'border-red-500/50 bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300'
          : active
            ? 'border-blue-500/40 bg-blue-50 text-blue-700 hover:bg-blue-100 dark:border-blue-500/40 dark:bg-blue-950/40 dark:text-blue-300'
            : 'border-black/10 text-zinc-700 hover:bg-black/[0.04] dark:border-white/15 dark:text-zinc-200 dark:hover:bg-white/[0.06]'
      }`}
    >
      {/* El icono nunca comunica solo: va con el texto, igual que el resto del
          panel. Un paraguas a secas no dice si está activo o apagado. */}
      🌧 {active ? 'Lluvia +3' : 'Lluvia'}
    </button>
  );
}
