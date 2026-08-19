'use client';

import { MAX_QUANTITY_PER_ITEM } from '@/lib/cart/cart';

/**
 * Controles − cantidad +. Botones de 40px para tocar cómodo.
 * En 1 unidad, "−" elimina el producto del carrito (label acorde).
 */
export function QuantityControl({
  name,
  quantity,
  onAdd,
  onRemove,
  size = 'md',
}: {
  name: string;
  quantity: number;
  onAdd: () => void;
  onRemove: () => void;
  size?: 'md' | 'sm';
}) {
  const atMax = quantity >= MAX_QUANTITY_PER_ITEM;
  const button =
    size === 'sm'
      ? 'h-8 w-8 text-base'
      : 'h-10 w-10 text-lg';

  return (
    <div className="inline-flex items-center gap-1 rounded-full bg-donzarco-red-dark p-1 text-white">
      <button
        type="button"
        onClick={onRemove}
        aria-label={quantity <= 1 ? `Quitar ${name} del carrito` : `Quitar una unidad de ${name}`}
        className={`${button} flex items-center justify-center rounded-full leading-none transition-colors hover:bg-white/15 active:bg-white/25`}
      >
        {quantity <= 1 ? '🗑' : '−'}
      </button>

      <span
        className="min-w-6 text-center text-sm font-semibold tabular-nums"
        aria-live="polite"
        aria-label={`${quantity} ${name} en el carrito`}
      >
        {quantity}
      </span>

      <button
        type="button"
        onClick={onAdd}
        disabled={atMax}
        aria-label={
          atMax
            ? `Máximo ${MAX_QUANTITY_PER_ITEM} unidades de ${name}`
            : `Agregar una unidad de ${name}`
        }
        className={`${button} flex items-center justify-center rounded-full leading-none transition-colors hover:bg-white/15 active:bg-white/25 disabled:opacity-40`}
      >
        +
      </button>
    </div>
  );
}
