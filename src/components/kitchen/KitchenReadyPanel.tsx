'use client';

import { useEffect } from 'react';
import type { KdsAction } from '@/lib/kitchen/kds-status';
import { formatClockTime } from '@/lib/kitchen/timer';
import type { KitchenTicket } from '@/lib/kitchen/ticket-view';
import { shortOrderNumber } from '@/lib/orders/order-number';

/**
 * Historial de "Pedidos listos": el salvavidas por si un cocinero completo un
 * pedido por error. Lo ultimo completado va primero, con la hora en formato 24 h,
 * y cada tarjeta puede volver al grid en preparacion.
 */
export interface KitchenReadyPanelProps {
  tickets: KitchenTicket[];
  busyOrder: string | null;
  onAction: (orderNumber: string, action: KdsAction) => void;
  onClose: () => void;
}

export function KitchenReadyPanel({
  tickets,
  busyOrder,
  onAction,
  onClose,
}: KitchenReadyPanelProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-40 flex justify-end bg-black/50"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Pedidos listos"
        className="flex h-full w-full max-w-md flex-col overflow-hidden bg-zinc-50 shadow-2xl"
      >
        <header className="flex shrink-0 items-center justify-between bg-zinc-900 px-5 py-4 text-white">
          <h2 className="text-lg font-extrabold tracking-tight">Pedidos listos</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg bg-white/10 px-4 py-2 text-sm font-bold hover:bg-white/20"
          >
            Cerrar
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {tickets.length === 0 ? (
            <p className="py-10 text-center text-sm text-zinc-500">
              Todavía no hay pedidos completados hoy.
            </p>
          ) : (
            <ul className="flex flex-col gap-3">
              {tickets.map((ticket) => (
                <li
                  key={ticket.orderNumber}
                  className="rounded-xl bg-white p-4 shadow-sm ring-1 ring-black/5"
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-2xl font-extrabold tracking-tight text-zinc-900">
                      {shortOrderNumber(ticket.orderNumber)}
                    </span>
                    <span className="text-sm font-semibold tabular-nums text-zinc-500">
                      {formatClockTime(ticket.completedAt)}
                    </span>
                  </div>
                  <ul className="mt-2 flex flex-col gap-1">
                    {ticket.lines.map((line, i) => (
                      <li key={`${line.name}-${i}`} className="text-sm text-zinc-700">
                        <span className="font-bold tabular-nums">{line.quantity}</span> {line.name}
                      </li>
                    ))}
                  </ul>
                  <button
                    type="button"
                    disabled={busyOrder !== null}
                    onClick={() => onAction(ticket.orderNumber, 'recall')}
                    className="mt-3 h-14 w-full rounded-xl bg-blue-600 text-base font-extrabold uppercase tracking-wide text-white hover:bg-blue-500 active:bg-blue-700 disabled:opacity-50"
                  >
                    Devolver a cocina
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>
    </div>
  );
}
