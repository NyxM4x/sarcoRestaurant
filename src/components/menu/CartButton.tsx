'use client';

// Formatter monetario de presentación compartido (puro): `Bs 45,00`.
import { formatMoney } from '@/lib/dashboard/format';

/** Botón fijo al pie. Solo se renderiza cuando hay productos en el carrito. */
export function CartButton({
  units,
  total,
  onOpen,
}: {
  units: number;
  total: number;
  onOpen: () => void;
}) {
  const productLabel = `${units} ${units === 1 ? 'producto' : 'productos'}`;
  return (
    <div className="fixed inset-x-0 bottom-0 z-30 bg-gradient-to-t from-donzarco-surface via-donzarco-surface/95 to-transparent px-4 pt-6 pb-[max(1rem,env(safe-area-inset-bottom))]">
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Ver carrito: ${productLabel}, total ${formatMoney(total)}`}
        className="flex w-full items-center justify-between gap-3 rounded-full bg-donzarco-red-dark px-5 py-4 text-white shadow-lg shadow-black/20 transition-colors hover:bg-donzarco-red-hover active:bg-donzarco-red-active"
      >
        <span className="flex min-w-0 items-center gap-3">
          <span
            className="flex h-8 min-w-8 items-center justify-center rounded-full bg-white px-1.5 text-sm font-bold text-donzarco-red-dark tabular-nums"
            aria-hidden
          >
            {units}
          </span>
          <span className="flex flex-col items-start leading-tight">
            <span className="text-base font-semibold">Ver carrito</span>
            <span className="text-xs font-medium text-white/70">{productLabel}</span>
          </span>
        </span>
        <span className="shrink-0 text-base font-bold tabular-nums">{formatMoney(total)}</span>
      </button>
    </div>
  );
}
