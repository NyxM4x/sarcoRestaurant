'use client';

import type { OrderListItem } from '@/lib/dashboard/order-view';
import type { OrderStatus } from '@/types';
import { StatusBadge } from './StatusBadge';
import { DeliveryStateChip } from './DeliveryStateChip';
import { primaryActionFor, isTerminalStatus } from '@/lib/dashboard/status';
import { elapsedMinutes, waitingLabel, urgencyLevel, urgencyMeta } from '@/lib/dashboard/urgency';
import { paymentMethodMeta } from '@/lib/dashboard/payment';
import { formatMoney, formatTime, deliveryTypeLabel, formatCustomerName } from '@/lib/dashboard/format';

function Flag({ tone, children }: { tone: 'amber' | 'red'; children: React.ReactNode }) {
  const cls =
    tone === 'red'
      ? 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300'
      : 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300';
  return (
    <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium ${cls}`}>
      {children}
    </span>
  );
}

/** Acento de borde izquierdo por urgencia (o pedido nuevo). Nunca solo color. */
function accentClass(urgency: 'none' | 'normal' | 'attention' | 'overdue', isNew: boolean): string {
  if (urgency === 'overdue') return 'border-l-4 border-l-red-500';
  if (urgency === 'attention') return 'border-l-4 border-l-amber-500';
  if (isNew) return 'border-l-4 border-l-green-500';
  return '';
}

function OrderCard({
  order,
  active,
  busy,
  isNew,
  nowMs,
  onSelect,
  onQuickAction,
}: {
  order: OrderListItem;
  active: boolean;
  busy: boolean;
  isNew: boolean;
  nowMs: number;
  onSelect: () => void;
  onQuickAction: (to: OrderStatus) => void;
}) {
  const primary = primaryActionFor(order.status, order.deliveryType);
  const hasFlags = order.locationPending || order.manualReview || order.notificationIssue;

  const terminal = isTerminalStatus(order.status);
  const minutes = elapsedMinutes(order.createdAt, nowMs);
  const urgency = urgencyLevel(minutes, order.status);
  const uMeta = urgencyMeta(urgency);
  const payment = paymentMethodMeta(order.paymentMethod);
  // 6D.2D: en dynamic, el chip de estado de envío reemplaza el flag genérico de
  // "Ubicación pendiente" (no se muestran juntos).
  const showSignals = hasFlags || uMeta !== null || order.deliveryState !== null;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
      aria-label={`Ver pedido ${order.orderNumber}`}
      className={`group cursor-pointer rounded-xl border p-4 transition hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900/20 dark:focus-visible:ring-white/20 ${
        active
          ? 'border-zinc-400 bg-zinc-50 dark:border-zinc-500 dark:bg-zinc-800/60'
          : 'border-black/[0.07] bg-white dark:border-white/10 dark:bg-zinc-900'
      } ${accentClass(urgency, isNew)} ${isNew ? 'ring-1 ring-green-500/40' : ''}`}
    >
      {/* Superior: número (+ "Nuevo") + estado */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <p className="font-semibold tracking-tight text-zinc-900 tabular-nums dark:text-zinc-50">{order.orderNumber}</p>
          {isNew && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-green-600 px-1.5 py-0.5 text-[11px] font-semibold text-white">
              <span aria-hidden>●</span> Nuevo
            </span>
          )}
        </div>
        <StatusBadge status={order.status} deliveryType={order.deliveryType} />
      </div>

      {/* Centro: cliente + meta */}
      <p className="mt-1 truncate text-sm font-medium text-zinc-700 dark:text-zinc-200">
        {formatCustomerName(order.customerName) ?? 'Sin nombre'}
      </p>
      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-zinc-500">
        {terminal ? (
          <span className="tabular-nums">{formatTime(order.createdAt)}</span>
        ) : (
          <span className="font-medium text-zinc-600 tabular-nums dark:text-zinc-300" title={`Creado ${formatTime(order.createdAt)}`}>
            {waitingLabel(minutes)}
          </span>
        )}
        <span aria-hidden>·</span>
        <span>{deliveryTypeLabel(order.deliveryType)}</span>
        <span aria-hidden>·</span>
        <span>{order.itemCount} {order.itemCount === 1 ? 'producto' : 'productos'}</span>
        {!terminal && (
          <>
            <span aria-hidden>·</span>
            <span className="tabular-nums text-zinc-400">{formatTime(order.createdAt)}</span>
          </>
        )}
        {payment && (
          <>
            <span aria-hidden>·</span>
            <span className="inline-flex items-center gap-1 rounded bg-black/[0.04] px-1.5 py-0.5 font-medium text-zinc-600 dark:bg-white/[0.06] dark:text-zinc-300">
              <span aria-hidden>{payment.icon}</span> {payment.label}
            </span>
          </>
        )}
      </div>

      {showSignals && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {uMeta && <Flag tone={uMeta.tone}>{uMeta.icon} {uMeta.label}</Flag>}
          {order.deliveryState ? (
            <DeliveryStateChip state={order.deliveryState} />
          ) : (
            order.locationPending && <Flag tone="amber">📍 Ubicación pendiente</Flag>
          )}
          {order.manualReview && <Flag tone="red">⚠ Revisión manual</Flag>}
          {order.notificationIssue && <Flag tone="amber">✉ Problema de notificación</Flag>}
        </div>
      )}

      {/* Inferior: total + acciones */}
      <div className="mt-3 flex items-center justify-between gap-2 border-t border-black/[0.06] pt-3 dark:border-white/[0.06]">
        <span className="text-base font-semibold text-zinc-900 tabular-nums dark:text-zinc-50">
          {formatMoney(order.total, order.currency)}
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onSelect(); }}
            className="rounded-lg px-2.5 py-1.5 text-sm font-medium text-zinc-600 hover:bg-black/[0.04] dark:text-zinc-300 dark:hover:bg-white/[0.06]"
          >
            Ver pedido
          </button>
          {primary && (
            <button
              type="button"
              disabled={busy}
              onClick={(e) => { e.stopPropagation(); onQuickAction(primary.to); }}
              className="rounded-lg bg-zinc-900 px-3 py-1.5 text-sm font-semibold text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
            >
              {busy ? '…' : primary.label}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Skeleton() {
  return (
    <div className="space-y-3">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="h-32 animate-pulse rounded-xl border border-black/[0.05] bg-zinc-100 dark:border-white/5 dark:bg-zinc-900" />
      ))}
    </div>
  );
}

export function OrderList({
  orders,
  loading,
  error,
  activeOrder,
  busyOrder,
  newOrderNumbers,
  nowMs,
  onSelect,
  onQuickAction,
  hasMore,
  onLoadMore,
  onRetry,
}: {
  orders: OrderListItem[];
  loading: boolean;
  error: boolean;
  activeOrder: string | null;
  busyOrder: string | null;
  /** Números de pedido marcados como "Nuevo" (detección por polling en cliente). */
  newOrderNumbers: ReadonlySet<string>;
  /** Reloj compartido del dashboard: alimenta tiempo de espera y urgencia. */
  nowMs: number;
  onSelect: (orderNumber: string) => void;
  onQuickAction: (orderNumber: string, to: OrderStatus) => void;
  hasMore: boolean;
  onLoadMore: () => void;
  onRetry: () => void;
}) {
  if (loading && orders.length === 0) return <Skeleton />;

  if (error && orders.length === 0) {
    return (
      <div className="rounded-xl border border-red-200 bg-red-50 p-8 text-center dark:border-red-900 dark:bg-red-950/40">
        <p className="text-sm text-red-700 dark:text-red-300">No se pudieron cargar los pedidos.</p>
        <button type="button" onClick={onRetry} className="mt-3 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700">
          Reintentar
        </button>
      </div>
    );
  }

  if (orders.length === 0) {
    return (
      <div className="flex flex-col items-center rounded-xl border border-dashed border-black/15 px-6 py-14 text-center dark:border-white/15">
        <span className="mb-3 grid h-12 w-12 place-items-center rounded-full bg-black/[0.04] text-2xl dark:bg-white/[0.06]" aria-hidden>🍽️</span>
        <p className="text-sm font-semibold text-zinc-700 dark:text-zinc-200">No hay pedidos</p>
        <p className="mt-1 max-w-xs text-sm text-zinc-400">No encontramos pedidos para los filtros seleccionados.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {orders.map((o) => (
        <OrderCard
          key={o.orderNumber}
          order={o}
          active={activeOrder === o.orderNumber}
          busy={busyOrder === o.orderNumber}
          isNew={newOrderNumbers.has(o.orderNumber)}
          nowMs={nowMs}
          onSelect={() => onSelect(o.orderNumber)}
          onQuickAction={(to) => onQuickAction(o.orderNumber, to)}
        />
      ))}
      {hasMore && (
        <button
          type="button"
          onClick={onLoadMore}
          disabled={loading}
          className="w-full rounded-lg border border-black/10 py-2.5 text-sm font-medium text-zinc-600 hover:bg-black/[0.03] disabled:opacity-50 dark:border-white/15 dark:text-zinc-300 dark:hover:bg-white/5"
        >
          {loading ? 'Cargando…' : 'Cargar más'}
        </button>
      )}
    </div>
  );
}
