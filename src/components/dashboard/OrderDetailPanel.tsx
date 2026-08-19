'use client';

import { useEffect, useState, useTransition, useCallback } from 'react';
import type { OrderDetail } from '@/lib/dashboard/order-view';
import type { OrderStatus } from '@/types';
import { actionsFor, actionRequiresConfirmation } from '@/lib/dashboard/status';
import { googleMapsUrl } from '@/lib/dashboard/geo';
import { paymentMethodMeta } from '@/lib/dashboard/payment';
import { StatusBadge } from './StatusBadge';
import { DeliveryStateChip } from './DeliveryStateChip';
import { formatMoney, formatTime, formatDate, deliveryTypeLabel, formatCustomerName, formatPhone, formatDistanceKm } from '@/lib/dashboard/format';
import { updateOrderStatusAction, type UpdateActionResult } from '@/app/dashboard/actions';

const REASON_TEXT: Record<string, string> = {
  conflict: 'El pedido cambió mientras lo actualizabas. Se recargó su estado.',
  invalid_transition: 'Esa transición no está permitida.',
  terminal: 'El pedido ya está en un estado final.',
  not_found: 'No se encontró el pedido.',
  unauthorized: 'Tu sesión expiró. Vuelve a iniciar sesión.',
  invalid_status: 'Estado no válido.',
  error: 'Ocurrió un error. Intenta de nuevo.',
};

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 py-1 text-sm">
      <span className="text-zinc-500">{label}</span>
      <span className="text-right font-medium text-zinc-800 dark:text-zinc-100">{children}</span>
    </div>
  );
}

export function OrderDetailPanel({
  orderNumber,
  onClose,
  onUpdated,
}: {
  orderNumber: string;
  onClose: () => void;
  onUpdated: () => void;
}) {
  const [detail, setDetail] = useState<OrderDetail | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error' | 'notfound'>('loading');
  const [pending, startTransition] = useTransition();
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Solo hace setState DESPUES del await (nunca sincronamente en el efecto). El
  // panel se remonta por `key={orderNumber}` desde el padre, asi que el estado
  // inicial 'loading' ya es correcto al seleccionar otro pedido.
  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/dashboard/orders/detail?n=${encodeURIComponent(orderNumber)}`, {
        cache: 'no-store',
      });
      if (res.status === 404) return setState('notfound');
      if (!res.ok) return setState('error');
      setDetail((await res.json()) as OrderDetail);
      setState('ready');
    } catch {
      setState('error');
    }
  }, [orderNumber]);

  const retry = () => {
    setState('loading');
    setActionError(null);
    load();
  };

  useEffect(() => {
    // Fetch-on-mount: sincronización con la API (sistema externo). El panel se
    // remonta por `key`, así que corre una vez por pedido seleccionado.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const runAction = (to: OrderStatus) => {
    setActionError(null);
    startTransition(async () => {
      const result: UpdateActionResult = await updateOrderStatusAction(orderNumber, to);
      if (result.ok) {
        setConfirmCancel(false);
        onUpdated();
        await load();
      } else {
        setActionError(REASON_TEXT[result.reason] ?? 'No se pudo actualizar.');
        // En conflicto se recarga el estado real.
        if (result.reason === 'conflict') await load();
      }
    });
  };

  const actions = detail ? actionsFor(detail.status, detail.deliveryType) : [];

  return (
    <div className="fixed inset-0 z-40 flex justify-end" role="dialog" aria-modal="true" aria-label="Detalle del pedido">
      <button type="button" aria-label="Cerrar" className="absolute inset-0 bg-black/30 backdrop-blur-[1px]" onClick={onClose} />
      <aside className="relative flex h-full w-full max-w-md flex-col overflow-hidden border-l border-black/10 bg-white shadow-xl dark:border-white/10 dark:bg-zinc-950">
        <header className="flex shrink-0 items-center justify-between border-b border-black/[0.07] bg-white/90 px-5 py-4 backdrop-blur dark:border-white/10 dark:bg-zinc-950/90">
          <div>
            <p className="text-lg font-semibold tracking-tight">{orderNumber}</p>
            {detail && <p className="text-xs text-zinc-500">{formatDate(detail.createdAt)} · {formatTime(detail.createdAt)}</p>}
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-2 text-zinc-500 hover:bg-black/5 dark:hover:bg-white/10" aria-label="Cerrar panel">✕</button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 pb-8">
          {state === 'loading' && (
            <div className="space-y-3">
              {[0, 1, 2].map((i) => <div key={i} className="h-16 animate-pulse rounded-lg bg-zinc-100 dark:bg-zinc-900" />)}
            </div>
          )}

          {state === 'error' && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-center text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
              No se pudo cargar el detalle.
              <button type="button" onClick={retry} className="mt-2 block w-full rounded bg-red-600 py-1.5 text-white">Reintentar</button>
            </div>
          )}

          {state === 'notfound' && (
            <p className="py-8 text-center text-sm text-zinc-500">El pedido ya no está disponible.</p>
          )}

          {state === 'ready' && detail && (
            <div className="space-y-5">
              <div className="flex items-center justify-between">
                <StatusBadge status={detail.status} deliveryType={detail.deliveryType} />
                <span className="text-sm text-zinc-500">{deliveryTypeLabel(detail.deliveryType)}</span>
              </div>

              {(detail.locationPending || detail.manualReview || detail.notificationIssue) && (
                <div className="space-y-1 rounded-lg bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
                  {detail.locationPending && <p>📍 Ubicación de entrega pendiente.</p>}
                  {detail.manualReview && <p>⚠ Notificación marcada para revisión manual.</p>}
                  {detail.notificationIssue && <p>✉ Hubo un problema al notificar al cliente.</p>}
                </div>
              )}

              {/* Bloque: Pedido */}
              <div>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Pedido</h3>
                <div className="rounded-lg border border-black/[0.07] px-3 py-2 dark:border-white/10">
                  <Row label="Cliente">{formatCustomerName(detail.customerName) ?? '—'}</Row>
                  <Row label="Teléfono">{formatPhone(detail.contactPhone) ?? '—'}</Row>
                  <Row label="Entrega">{deliveryTypeLabel(detail.deliveryType)}</Row>
                  {(() => {
                    // Pago: dimensión independiente del estado operativo (6D.1).
                    // Sin método (histórico / Flow) no se muestra la fila.
                    const payment = paymentMethodMeta(detail.paymentMethod);
                    return payment ? (
                      <Row label="Pago">
                        <span aria-hidden>{payment.icon}</span> {payment.label}
                      </Row>
                    ) : null;
                  })()}
                  <Row label="Creado">{formatDate(detail.createdAt)} · {formatTime(detail.createdAt)}</Row>
                  {detail.confirmedAt && <Row label="Confirmado">{formatDate(detail.confirmedAt)} · {formatTime(detail.confirmedAt)}</Row>}
                  <Row label="Actualizado">{formatDate(detail.updatedAt)} · {formatTime(detail.updatedAt)}</Row>
                </div>
              </div>

              {/* Bloque: Entrega (solo delivery) */}
              {detail.deliveryType === 'delivery' && (() => {
                // Solo se ofrece el enlace si hay coordenadas válidas; si no, se
                // conserva la dirección/referencia sin un botón roto.
                const mapsUrl = googleMapsUrl(detail.deliveryLatitude, detail.deliveryLongitude);
                const hasCoords = detail.deliveryLatitude !== null && detail.deliveryLongitude !== null;
                const distanceLabel = formatDistanceKm(detail.deliveryDistanceMeters);
                const st = detail.deliveryState; // null en legacy → bloque igual que antes.
                const showReceived =
                  st != null && (st.key === 'awaiting_location' || st.key === 'quoting' || st.key === 'failed');
                const showDistance =
                  distanceLabel != null && (st?.key === 'quoted' || st?.key === 'out_of_coverage');
                return (
                  <div>
                    <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Entrega</h3>
                    <div className="rounded-lg border border-black/[0.07] px-3 py-2 dark:border-white/10">
                      {st && (
                        <Row label="Estado envío"><DeliveryStateChip state={st} /></Row>
                      )}
                      <Row label="Dirección">{detail.deliveryAddress ?? '—'}</Row>
                      {detail.deliveryLocationName && <Row label="Referencia">{detail.deliveryLocationName}</Row>}
                      {showReceived && (
                        <Row label="Ubicación recibida">{hasCoords ? 'Sí' : 'No'}</Row>
                      )}
                      {st?.key === 'quoted' && detail.deliveryAmount > 0 && (
                        <Row label="Costo envío">{formatMoney(detail.deliveryAmount, detail.currency)}</Row>
                      )}
                      {showDistance && <Row label="Distancia">{distanceLabel}</Row>}
                      {mapsUrl ? (
                        <a
                          href={mapsUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg border border-black/10 py-2 text-sm font-medium text-zinc-700 hover:bg-black/[0.04] dark:border-white/15 dark:text-zinc-200 dark:hover:bg-white/[0.06]"
                        >
                          📍 Abrir en mapa
                        </a>
                      ) : null}
                      {st?.key === 'failed' && (
                        <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
                          Revisar manualmente
                        </p>
                      )}
                    </div>
                  </div>
                );
              })()}

              {/* Bloque: Productos */}
              <div>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Productos</h3>
                <ul className="divide-y divide-black/[0.06] rounded-lg border border-black/[0.07] dark:divide-white/[0.06] dark:border-white/10">
                  {detail.items.map((it, i) => (
                    <li key={i} className="flex items-center justify-between px-3 py-2 text-sm">
                      <span><span className="font-medium tabular-nums">{it.quantity}×</span> {it.name}</span>
                      <span className="tabular-nums text-zinc-600 dark:text-zinc-400">{formatMoney(it.subtotal, detail.currency)}</span>
                    </li>
                  ))}
                </ul>
              </div>

              {/* Bloque: Totales */}
              <div>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Totales</h3>
                <div className="rounded-lg border border-black/[0.07] px-3 py-2 dark:border-white/10">
                  <Row label="Subtotal">{formatMoney(detail.subtotal, detail.currency)}</Row>
                  {detail.deliveryAmount > 0 && <Row label="Envío">{formatMoney(detail.deliveryAmount, detail.currency)}</Row>}
                  <div className="mt-1 border-t border-black/[0.07] pt-1 dark:border-white/10">
                    <div className="flex items-center justify-between py-1">
                      <span className="text-sm font-semibold text-zinc-700 dark:text-zinc-200">Total</span>
                      <span className="text-lg font-bold text-zinc-900 tabular-nums dark:text-zinc-50">{formatMoney(detail.total, detail.currency)}</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Bloque: Observaciones */}
              {detail.notes && (
                <div>
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Observaciones</h3>
                  <p className="rounded-lg bg-black/[0.03] p-3 text-sm dark:bg-white/[0.06]">{detail.notes}</p>
                </div>
              )}

              {actionError && (
                <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">{actionError}</p>
              )}
            </div>
          )}
        </div>

        {state === 'ready' && detail && actions.length > 0 && (
          <footer className="shrink-0 space-y-2 border-t border-black/[0.07] bg-white/95 px-5 py-4 backdrop-blur dark:border-white/10 dark:bg-zinc-950/95">
            {actions.map((a) => {
              const isCancel = actionRequiresConfirmation(a.to);
              if (isCancel && confirmCancel) {
                return (
                  <div key={a.to} className="flex gap-2">
                    <button type="button" disabled={pending} onClick={() => runAction(a.to)} className="flex-1 rounded-lg bg-red-600 py-2.5 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50">
                      {pending ? 'Cancelando…' : 'Sí, cancelar'}
                    </button>
                    <button type="button" disabled={pending} onClick={() => setConfirmCancel(false)} className="flex-1 rounded-lg border border-black/10 py-2.5 text-sm font-medium dark:border-white/15">
                      No
                    </button>
                  </div>
                );
              }
              return (
                <button
                  key={a.to}
                  type="button"
                  disabled={pending}
                  onClick={() => (isCancel ? setConfirmCancel(true) : runAction(a.to))}
                  className={`w-full rounded-lg py-2.5 text-sm font-semibold disabled:opacity-50 ${
                    a.destructive
                      ? 'border border-red-300 text-red-700 hover:bg-red-50 dark:border-red-900 dark:text-red-300 dark:hover:bg-red-950/40'
                      : 'bg-zinc-900 text-white hover:bg-zinc-700 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200'
                  }`}
                >
                  {pending && !isCancel ? 'Actualizando…' : a.label}
                </button>
              );
            })}
          </footer>
        )}
      </aside>
    </div>
  );
}
