'use client';

import type { MenuItem } from '@/types';
// Formatter monetario de presentación compartido (puro): `Bs 45,00`. El valor en
// base sigue siendo BOB; esto solo cambia cómo se muestra.
import { formatMoney } from '@/lib/dashboard/format';
import { productDescription } from '@/lib/menu/catalog';
import { ProductImage } from './ProductImage';
import { QuantityControl } from './QuantityControl';

/** Tarjeta de producto: foto, nombre, descripción, precio y acción. */
export function ProductCard({
  item,
  quantity,
  onAdd,
  onRemove,
}: {
  item: MenuItem;
  quantity: number;
  onAdd: () => void;
  onRemove: () => void;
}) {
  const description = productDescription(item.code);
  const available = item.is_active;
  const inCart = quantity > 0;

  return (
    <article
      className={`flex gap-3 rounded-2xl bg-white p-3 shadow-sm ring-1 transition-shadow hover:shadow-md ${
        inCart ? 'ring-2 ring-lafija-green-dark' : 'ring-zinc-200 hover:ring-lafija-green/40'
      } ${available ? '' : 'opacity-70'}`}
    >
      <ProductImage
        item={item}
        unavailable={!available}
        className="h-24 w-24 shrink-0 rounded-xl"
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <h3 className="line-clamp-2 text-base leading-tight font-semibold text-zinc-900">
          {item.name}
        </h3>

        {description ? (
          <p className="mt-1 line-clamp-2 text-sm leading-snug text-zinc-500">{description}</p>
        ) : null}

        <div className="mt-auto flex items-center justify-between gap-2 pt-2">
          <span className="text-lg font-extrabold text-lafija-green-dark tabular-nums">
            {formatMoney(item.price)}
          </span>

          {!available ? (
            <span className="rounded-full bg-zinc-100 px-3 py-1.5 text-xs font-semibold text-zinc-400">
              No disponible
            </span>
          ) : inCart ? (
            <QuantityControl
              name={item.name}
              quantity={quantity}
              onAdd={onAdd}
              onRemove={onRemove}
            />
          ) : (
            <button
              type="button"
              onClick={onAdd}
              aria-label={`Agregar ${item.name} al carrito`}
              className="rounded-full bg-lafija-green-dark px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-lafija-green-hover active:bg-lafija-green-active"
            >
              Agregar
            </button>
          )}
        </div>
      </div>
    </article>
  );
}
