'use client';

// Formatter monetario de presentación compartido (puro): `Bs 45,00`.
import { formatMoney } from '@/lib/dashboard/format';
import type { CheckoutOrder } from '@/lib/checkout/client';
import { shortOrderNumber } from '@/lib/orders/order-number';

/**
 * Pantalla final del checkout. Estado terminal: no hay ningún botón que vuelva
 * a enviar el pedido, que es la garantía última contra el doble envío.
 *
 * Dos variantes:
 * - pickup: el pedido queda confirmado para recoger.
 * - delivery: queda registrado, pero falta la ubicación por WhatsApp. El envío
 *   de esa solicitud es de la Fase 5.2D; aquí solo se instruye al usuario.
 */
export function OrderSuccess({
  order,
  onBackToMenu,
}: {
  order: CheckoutOrder;
  onBackToMenu: () => void;
}) {
  const isPickup = order.delivery_type === 'pickup';

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end">
      <div className="absolute inset-0 bg-black/50" />

      <section
        role="dialog"
        aria-modal="true"
        aria-label={isPickup ? 'Pedido confirmado' : 'Pedido registrado'}
        className="relative flex max-h-[90vh] flex-col rounded-t-3xl bg-white"
      >
        <div className="flex-1 overflow-y-auto px-5 pt-8 pb-2 text-center">
          <span className="text-5xl" aria-hidden>
            ✅
          </span>

          <h2 role="status" className="mt-3 text-xl font-bold text-zinc-900">
            {isPickup ? 'Pedido confirmado' : 'Pedido registrado'}
          </h2>

          <p className="mt-1 text-3xl font-bold tracking-wide text-donzarco-red-dark tabular-nums">
            {shortOrderNumber(order.order_number)}
          </p>
          {/* El número completo, discreto: es la referencia con la que se puede
              reclamar un pedido de otra noche, cuando el "#7" ya no distingue. */}
          {shortOrderNumber(order.order_number) !== order.order_number && (
            <p className="text-xs text-zinc-400 tabular-nums">{order.order_number}</p>
          )}

          {isPickup && order.customer_name ? (
            <p className="mt-1 text-sm text-zinc-500">A nombre de {order.customer_name}</p>
          ) : null}

          {/* Totales */}
          <dl className="mt-6 space-y-1.5 text-left">
            <div className="flex items-center justify-between text-sm text-zinc-500">
              <dt>Subtotal</dt>
              <dd className="tabular-nums">{formatMoney(order.subtotal_amount)}</dd>
            </div>

            {isPickup ? null : (
              <div className="flex items-center justify-between text-sm text-zinc-500">
                <dt>Envío</dt>
                <dd>por confirmar</dd>
              </div>
            )}

            <div className="flex items-center justify-between border-t border-zinc-100 pt-1.5 text-lg font-bold text-zinc-900">
              <dt>Total</dt>
              <dd className="tabular-nums">{formatMoney(order.total_amount)}</dd>
            </div>

            {isPickup ? null : (
              <p className="text-right text-xs text-zinc-400">
                Total provisional: falta sumar el envío.
              </p>
            )}
          </dl>

          {/* Siguiente paso */}
          {isPickup ? (
            <p className="mt-5 rounded-xl bg-zinc-50 px-4 py-3 text-sm leading-relaxed text-zinc-600">
              Tu pedido quedó confirmado para recoger en el local.
            </p>
          ) : (
            <div className="mt-5 rounded-xl bg-amber-50 px-4 py-3 text-left">
              <p className="text-sm font-semibold text-amber-900">📍 Falta un paso</p>
              <p className="mt-1 text-sm leading-relaxed text-amber-800">
                Vuelve a WhatsApp y comparte tu ubicación para calcular el costo del envío.
              </p>
            </div>
          )}

          <p className="mt-4 text-xs leading-relaxed text-zinc-400">
            Para hacer otro pedido, solicita un nuevo enlace por WhatsApp.
          </p>
        </div>

        <div className="border-t border-zinc-100 px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))]">
          <button
            type="button"
            onClick={onBackToMenu}
            className="w-full rounded-full bg-zinc-100 px-5 py-4 text-base font-semibold text-zinc-700 transition-colors hover:bg-zinc-200 active:bg-zinc-300"
          >
            Volver al menú
          </button>
        </div>
      </section>
    </div>
  );
}
