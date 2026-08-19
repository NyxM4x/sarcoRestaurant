import type { ReactNode } from 'react';
import type { OrderSummary } from '@/lib/dashboard/order-view';

type IconKey = keyof OrderSummary;

// Iconos monocromaticos (trazo currentColor), consistentes y pequeños. Sin
// dependencias: SVG inline. La barra lateral de color aporta la categoria; el
// icono se mantiene neutro para no competir con el numero protagonista.
const ICON_PATHS: Record<IconKey, ReactNode> = {
  today: (
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      d="M8.25 6.75h12M8.25 12h12M8.25 17.25h12M3.75 6.75h.008v.008H3.75V6.75Zm0 5.25h.008v.008H3.75V12Zm0 5.25h.008v.008H3.75v-.008Z"
    />
  ),
  preparing: (
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      d="M15.362 5.214A8.252 8.252 0 0 1 12 21 8.25 8.25 0 0 1 6.038 7.048 8.287 8.287 0 0 0 9 9.6a8.983 8.983 0 0 1 3.362-6.867 8.21 8.21 0 0 0 3 2.48Z"
    />
  ),
  ready: <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 18.75a1.5 1.5 0 0 1-3 0m3 0a1.5 1.5 0 0 0-3 0m3 0h6m-9 0H3.375a1.125 1.125 0 0 1-1.125-1.125V14.25m17.25 4.5a1.5 1.5 0 0 1-3 0m3 0a1.5 1.5 0 0 0-3 0m3 0h1.125c.621 0 1.129-.504 1.09-1.124a17.902 17.902 0 0 0-3.213-9.193 2.056 2.056 0 0 0-1.58-.86H14.25M16.5 18.75h-6.75M3 6.75h11.25c.621 0 1.125.504 1.125 1.125v10.5m0-14.25v14.25" />,
  completed: (
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      d="M9 12.75 11.25 15 15 9.75m-3-7.036A11.959 11.959 0 0 1 3.598 6 11.99 11.99 0 0 0 3 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285Z"
    />
  ),
};

function CardIcon({ name }: { name: IconKey }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      className="h-4 w-4 shrink-0 text-zinc-400 dark:text-zinc-500"
      aria-hidden="true"
      focusable="false"
    >
      {ICON_PATHS[name]}
    </svg>
  );
}

// Lenguaje operativo 6C: cuatro etapas que el encargado realmente gestiona,
// derivadas de los estados internos en `summarize` (sin jerga técnica).
const CARDS: Array<{ key: IconKey; label: string; num: string; bar: string }> = [
  { key: 'today', label: 'Pedidos de hoy', num: 'text-zinc-900 dark:text-zinc-50', bar: 'bg-zinc-400 dark:bg-zinc-500' },
  { key: 'preparing', label: 'En preparación', num: 'text-indigo-600 dark:text-indigo-400', bar: 'bg-indigo-500' },
  { key: 'ready', label: 'En camino / Listos', num: 'text-purple-600 dark:text-purple-400', bar: 'bg-purple-500' },
  { key: 'completed', label: 'Entregados', num: 'text-green-600 dark:text-green-400', bar: 'bg-green-500' },
];

export function SummaryCards({ summary, loading }: { summary: OrderSummary | null; loading?: boolean }) {
  return (
    <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
      {CARDS.map((c) => (
        <div
          key={c.key}
          className="relative overflow-hidden rounded-xl border border-black/[0.07] bg-white px-4 py-3 shadow-sm dark:border-white/10 dark:bg-zinc-900"
        >
          <span className={`absolute inset-y-0 left-0 w-1 ${c.bar}`} aria-hidden />
          <div className="flex items-center gap-1.5 text-xs font-medium text-zinc-500">
            <CardIcon name={c.key} />
            <span className="truncate">{c.label}</span>
          </div>
          {loading || !summary ? (
            <div className="mt-1.5 h-8 w-10 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
          ) : (
            <p className={`mt-0.5 text-3xl font-bold leading-tight tabular-nums ${c.num}`}>{summary[c.key]}</p>
          )}
        </div>
      ))}
    </div>
  );
}
