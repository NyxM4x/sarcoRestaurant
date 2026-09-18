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
  tone = 'brand',
}: {
  name: string;
  quantity: number;
  onAdd: () => void;
  onRemove: () => void;
  size?: 'md' | 'sm';
  /**
   * Paleta de la píldora (EXPERIMENTAL, rediseno-menu-fastfood, 17-09-2026).
   * `brand` (rojo) es el uso de siempre — `PromoCard` y `CartPanel` no pasan
   * este prop, así que no cambian. `inverse` (dorado sobre tinta) es para la
   * tarjeta oscura rediseñada de `ProductCard`, donde el rojo de siempre se
   * perdería contra el fondo.
   */
  tone?: 'brand' | 'inverse';
}) {
  const atMax = quantity >= MAX_QUANTITY_PER_ITEM;
  const button = size === 'sm' ? 'h-8 w-8 text-base' : 'h-10 w-10 text-lg';
  const palette =
    tone === 'inverse' ? 'bg-donzarco-gold text-donzarco-ink' : 'bg-donzarco-red-dark text-white';
  const buttonHover =
    tone === 'inverse' ? 'hover:bg-black/10 active:bg-black/20' : 'hover:bg-white/15 active:bg-white/25';

  return (
    <div className={`inline-flex items-center gap-1 rounded-full p-1 ${palette}`}>
      <button
        type="button"
        onClick={onRemove}
        aria-label={quantity <= 1 ? `Quitar ${name} del carrito` : `Quitar una unidad de ${name}`}
        className={`${button} flex items-center justify-center rounded-full leading-none transition-colors ${buttonHover}`}
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
        className={`${button} flex items-center justify-center rounded-full leading-none transition-colors ${buttonHover} disabled:opacity-40`}
      >
        +
      </button>
    </div>
  );
}
