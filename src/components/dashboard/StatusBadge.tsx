import type { OrderStatus, DeliveryType } from '@/types';
import { operationalStatusMeta, type StatusTone } from '@/lib/dashboard/status';

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

/**
 * Badge de estado OPERATIVO (Fase 6C). Muestra el lenguaje del encargado (no el
 * estado técnico interno), derivado del estado + tipo de entrega. La informacion
 * NUNCA se comunica solo con color: siempre lleva la etiqueta de texto (ademas
 * del punto), para accesibilidad.
 */
export function StatusBadge({ status, deliveryType }: { status: OrderStatus; deliveryType: DeliveryType }) {
  const meta = operationalStatusMeta(status, deliveryType);
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${TONE[meta.tone]}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${DOT[meta.tone]}`} aria-hidden="true" />
      {meta.label}
    </span>
  );
}
