'use client';

import { useEffect, useMemo } from 'react';
import type { MenuItem } from '@/types';
import type { CartSummary } from '@/lib/cart/cart';
// Formatter monetario de presentación compartido (puro): `Bs 45,00`.
import { formatMoney } from '@/lib/dashboard/format';
import { ProductImage } from './ProductImage';
import { QuantityControl } from './QuantityControl';

/**
 * Panel del carrito (sin librería de modales). Se cierra con el botón, con
 * Escape o tocando fuera; siempre se puede volver al catálogo sin perder la
 * selección.
 *
 * Responsive: en móvil (< lg) es una hoja inferior (bottom-sheet). Desde `lg:`
 * pasa a un drawer lateral derecho de altura completa y ancho acotado, para no
 * ocupar toda la pantalla en monitor. El estado, las acciones, las cantidades,
 * los cálculos y el checkout NO cambian: solo la disposición.
 */
export function CartPanel({
  open,
  summary,
  items,
  onClose,
  onAdd,
  onRemove,
  onContinue,
  canCheckout,
  checkoutNotice,
}: {
  open: boolean;
  summary: CartSummary;
  items: MenuItem[];
  onClose: () => void;
  onAdd: (code: string) => void;
  onRemove: (code: string) => void;
  onContinue: () => void;
  /** `false` sin sesión válida o con la sesión ya consumida. */
  canCheckout: boolean;
  checkoutNotice: string | null;
}) {
  const itemsByCode = useMemo(
    () => new Map(items.map((item) => [item.code, item])),
    [items],
  );

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40 flex flex-col justify-end lg:flex-row lg:justify-end">
      <button
        type="button"
        aria-label="Cerrar carrito"
        onClick={onClose}
        className="absolute inset-0 bg-black/50"
      />

      <section
        role="dialog"
        aria-modal="true"
        aria-label="Tu carrito"
        className="relative flex max-h-[85vh] flex-col rounded-t-3xl bg-white shadow-xl lg:h-full lg:max-h-none lg:w-[520px] lg:max-w-[92vw] lg:rounded-none lg:rounded-l-3xl"
      >
        <div className="flex items-center justify-between border-b border-zinc-100 px-4 py-4">
          <h2 className="text-lg font-bold text-zinc-900">Tu pedido</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Volver al menú"
            className="flex h-9 w-9 items-center justify-center rounded-full bg-zinc-100 text-lg leading-none text-zinc-600"
          >
            ✕
          </button>
        </div>

        <ul className="flex-1 divide-y divide-zinc-100 overflow-y-auto px-4">
          {summary.lines.map((line) => {
            const item = itemsByCode.get(line.product_code);
            return (
              <li key={line.product_code} className="flex items-center gap-3 py-3">
                {item ? (
                  <ProductImage
                    item={item}
                    className="h-14 w-14 shrink-0 rounded-lg"
                    sizes="56px"
                  />
                ) : null}

                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-zinc-900">
                    {line.product_name_snapshot}
                  </p>
                  <p className="text-xs text-zinc-500 tabular-nums">
                    {line.quantity} × {formatMoney(line.unit_price_snapshot)}
                  </p>
                </div>

                <div className="flex flex-col items-end gap-1.5">
                  <span className="text-sm font-bold text-zinc-900 tabular-nums">
                    {formatMoney(line.subtotal)}
                  </span>
                  <QuantityControl
                    name={line.product_name_snapshot}
                    quantity={line.quantity}
                    onAdd={() => onAdd(line.product_code)}
                    onRemove={() => onRemove(line.product_code)}
                    size="sm"
                  />
                </div>
              </li>
            );
          })}
        </ul>

        <div className="border-t border-zinc-100 px-4 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
          <div className="flex items-center justify-between text-sm text-zinc-500">
            <span>Subtotal</span>
            <span className="tabular-nums">{formatMoney(summary.subtotal)}</span>
          </div>
          <div className="mt-1 flex items-center justify-between text-lg font-bold text-zinc-900">
            <span>Total</span>
            <span className="tabular-nums">{formatMoney(summary.total)}</span>
          </div>
          <p className="mt-1 text-xs text-zinc-400">
            El costo de envío se define al finalizar el pedido.
          </p>

          <button
            type="button"
            onClick={onContinue}
            disabled={!canCheckout}
            aria-describedby={checkoutNotice ? 'cart-checkout-notice' : undefined}
            className="mt-4 w-full rounded-full bg-lafija-green-dark px-5 py-4 text-base font-semibold text-white transition-colors hover:bg-lafija-green-hover active:bg-lafija-green-active disabled:pointer-events-none disabled:opacity-40"
          >
            Continuar pedido
          </button>

          {checkoutNotice ? (
            <p
              id="cart-checkout-notice"
              role="status"
              className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-center text-sm leading-relaxed text-amber-800"
            >
              {checkoutNotice}
            </p>
          ) : null}
        </div>
      </section>
    </div>
  );
}
