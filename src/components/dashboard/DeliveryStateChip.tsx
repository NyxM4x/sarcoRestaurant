import type { DeliveryStateView } from '@/lib/dashboard/delivery-state';
import type { StatusTone } from '@/lib/dashboard/status';

/**
 * Chip del estado de envío dinámico (6D.2D). Reutiliza los tonos del sistema
 * (mismos que StatusBadge). La información NUNCA depende solo del color: siempre
 * lleva la etiqueta de texto y un punto. Se usa igual en la tarjeta y el detalle.
 */
const TONE: Record<StatusTone, string> = {
  gray: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
  amber: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  blue: 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300',
  indigo: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-950 dark:text-indigo-300',
  teal: 'bg-teal-100 text-teal-800 dark:bg-teal-950 dark:text-teal-300',
  purple: 'bg-purple-100 text-purple-800 dark:bg-purple-950 dark:text-purple-300',
  green: 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300',
  red: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
};
const DOT: Record<StatusTone, string> = {
  gray: 'bg-zinc-500', amber: 'bg-amber-500', blue: 'bg-blue-500', indigo: 'bg-indigo-500',
  teal: 'bg-teal-500', purple: 'bg-purple-500', green: 'bg-green-500', red: 'bg-red-500',
};

export function DeliveryStateChip({ state }: { state: DeliveryStateView }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium ${TONE[state.tone]}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${DOT[state.tone]}`} aria-hidden="true" />
      {state.label}
    </span>
  );
}
