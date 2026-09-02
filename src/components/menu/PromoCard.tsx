'use client';

import { formatMoney } from '@/lib/dashboard/format';
import type { Promotion, PromotionPricing } from '@/lib/promotions/promotion';
import {
  composeSummary,
  expiryLabel,
  resolvePromotionImage,
} from '@/lib/promotions/promotion-display';
import { ProductImage } from './ProductImage';
import { QuantityControl } from './QuantityControl';

/**
 * Tarjeta de promoción. Misma altura y mismo lenguaje que `ProductCard`, con
 * tres cosas propias: la etiqueta PROMO, el precio tachado y el ahorro.
 *
 * ── Una sola línea de composición, no tres cosas a la vez ───────────────────
 *
 * Se muestra la composición resumida —"2× Lomito + 2× Soda Peque"— y NADA más:
 * ni la descripción administrativa, ni la lista vertical de componentes.
 * Enseñar las tres duplica la misma información y estira la tarjeta hasta que
 * en un celular caben dos promociones por pantalla.
 *
 * El texto se recorta a dos líneas por CSS, pero viaja entero en el DOM: quien
 * use un lector de pantalla oye el combo completo. Recortarlo en origen sería
 * quitarle el dato, no ahorrarle espacio.
 *
 * ── El borde no es decoración ───────────────────────────────────────────────
 *
 * La promoción va con un aro naranja permanente porque compite por atención con
 * el catálogo entero que tiene debajo. El aro ROJO sigue significando lo mismo
 * que en los productos: "esto está en tu carrito".
 */
export function PromoCard({
  promotion,
  pricing,
  quantity,
  now,
  onAdd,
  onRemove,
}: {
  promotion: Promotion;
  pricing: PromotionPricing;
  quantity: number;
  now: number;
  onAdd: () => void;
  onRemove: () => void;
}) {
  const enCarrito = quantity > 0;
  const composicion = composeSummary(promotion.components);
  const vence = expiryLabel(promotion.endsAt, now);
  const imagen = resolvePromotionImage(promotion.imageUrl, promotion.components);

  // La foto sale del componente protagonista salvo que la promoción tenga la
  // suya. El placeholder solo aparece si no hay ninguna de las dos.
  const item =
    imagen.kind === 'component'
      ? { code: imagen.code, category: imagen.category, name: promotion.name }
      : { code: '', category: 'plato' as const, name: promotion.name };

  return (
    <article
      className={`flex gap-3 rounded-2xl bg-white p-3 shadow-sm ring-2 transition-shadow hover:shadow-md ${
        enCarrito ? 'ring-donzarco-red-dark' : 'ring-donzarco-gold/70'
      }`}
    >
      <div className="relative shrink-0">
        <ProductImage
          item={item}
          src={imagen.kind === 'url' ? imagen.url : undefined}
          alt={promotion.name}
          className="h-24 w-24 rounded-xl"
          sizes="(max-width: 640px) 30vw, 120px"
        />
        <span className="absolute left-1 top-1 rounded-full bg-donzarco-gold px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-donzarco-ink shadow-sm">
          Promo
        </span>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <h3 className="line-clamp-2 text-base leading-tight font-semibold text-zinc-900">
          {promotion.name}
        </h3>

        {/* `title` conserva el texto completo para el puntero; el DOM lo tiene
            entero para los lectores de pantalla aunque el CSS lo recorte. */}
        <p className="mt-1 line-clamp-2 text-sm leading-snug text-zinc-500" title={composicion}>
          {composicion}
        </p>

        {/* Sin vencimiento no se pinta nada: ni etiqueta, ni hueco reservado. */}
        {vence !== null && (
          <p className="mt-1 text-xs font-medium text-donzarco-red">{vence}</p>
        )}

        <div className="mt-auto flex items-end justify-between gap-2 border-t border-zinc-100 pt-2">
          <div className="min-w-0">
            <p className="flex items-baseline gap-1.5">
              <span className="text-xs text-zinc-400 line-through tabular-nums">
                {formatMoney(pricing.normalPrice)}
              </span>
              <span className="text-lg font-extrabold text-donzarco-red-dark tabular-nums">
                {formatMoney(pricing.promoPrice)}
              </span>
            </p>
            <p className="text-xs font-semibold text-emerald-700 tabular-nums">
              Ahorras {formatMoney(pricing.savings)}
            </p>
          </div>

          {enCarrito ? (
            <QuantityControl
              name={promotion.name}
              quantity={quantity}
              onAdd={onAdd}
              onRemove={onRemove}
              size="sm"
            />
          ) : (
            <button
              type="button"
              onClick={onAdd}
              aria-label={`Agregar la promoción ${promotion.name} al carrito`}
              className="shrink-0 rounded-full bg-donzarco-red-dark px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-donzarco-red-hover active:bg-donzarco-red-active"
            >
              Agregar
            </button>
          )}
        </div>
      </div>
    </article>
  );
}
