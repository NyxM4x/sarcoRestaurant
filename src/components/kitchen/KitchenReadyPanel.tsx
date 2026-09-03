'use client';

import { useEffect, useMemo } from 'react';
import type { KdsAction } from '@/lib/kitchen/kds-status';
import { formatClockTime } from '@/lib/kitchen/timer';
import type { KitchenTicket } from '@/lib/kitchen/ticket-view';
import { shortOrderNumber } from '@/lib/orders/order-number';
import { CollectChip } from './KitchenTicketCard';

/**
 * Historial de "Pedidos listos": el salvavidas por si un cocinero completo un
 * pedido por error. Lo ultimo completado va primero, con la hora en formato 24 h,
 * y cada tarjeta puede volver al grid en preparacion.
 *
 * ── Y el sitio donde de verdad se decide qué cobrar (03-09-2026) ────────────
 *
 * Este panel dejó de ser solo un historial el día que se empezó a usar para
 * empacar. Es la lista de lo que está esperando salir, así que es la pantalla
 * que se mira al meter el pedido en la bolsa y dársela a quien reparte — el
 * momento exacto en que hay que decir si se cobra el envío o no.
 *
 * Esa información existía y solo estaba en el ticket del grid, que para
 * entonces ya no se ve: al completarse, el pedido desaparece de allí. O sea que
 * la respuesta se guardaba justo hasta el instante antes de hacer falta.
 */
export interface KitchenReadyPanelProps {
  tickets: KitchenTicket[];
  busyOrder: string | null;
  onAction: (orderNumber: string, action: KdsAction) => void;
  onClose: () => void;
  /** Recarga el tablero tras marcar un envío. Sin él, espera al poll. */
  onCollectDecided?: () => void;
}

export function KitchenReadyPanel({
  tickets,
  busyOrder,
  onAction,
  onClose,
  onCollectDecided,
}: KitchenReadyPanelProps) {
  /**
   * El recuento de arriba: cuántos salen cobrando y cuántos no.
   *
   * Va en la cabecera porque responde de un vistazo la pregunta que trae a
   * alguien a este panel con varios pedidos listos a la vez —"¿a cuántos de
   * estos hay que cobrarles?"— sin leer tarjeta por tarjeta.
   *
   * `porConfirmar` se cuenta APARTE de `porCobrar` a propósito: son los que
   * salen con una deducción y no con un dato, y sumarlos a los otros los
   * escondería justo dentro de la cifra que se mira con confianza.
   */
  const resumen = useMemo(() => {
    let pagados = 0;
    let porCobrar = 0;
    let porConfirmar = 0;
    for (const t of tickets) {
      const c = t.deliveryCollect;
      if (c === null) continue;
      if (c.basis === 'pedido') porConfirmar += 1;
      else if (c.kind === 'pagado') pagados += 1;
      else porCobrar += 1;
    }
    return { pagados, porCobrar, porConfirmar };
  }, [tickets]);
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
        <header className="shrink-0 bg-zinc-900 px-4 py-2 text-white">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-extrabold tracking-tight">Pedidos listos</h2>
            <button
              type="button"
              onClick={onClose}
              className="h-10 rounded-lg bg-white/10 px-4 text-sm font-bold hover:bg-white/20"
            >
              Cerrar
            </button>
          </div>

          {/* A cuántos hay que cobrarles, de un vistazo. Cada cifra lleva su
              palabra: el color solo acompaña, nunca comunica solo.

              Azul y rojo son los mismos del chip de cada tarjeta —rojo se
              cobra, azul no— para que la cuenta de arriba y lo que se ve al
              bajar la vista sean el mismo código. El ámbar de "sin confirmar"
              no compite con ellos: no dice si se cobra, dice que nadie lo
              verificó. */}
          {(resumen.pagados > 0 || resumen.porCobrar > 0 || resumen.porConfirmar > 0) && (
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] font-bold uppercase tracking-wide">
              {resumen.pagados > 0 && (
                <span className="text-sky-300">{resumen.pagados} envío pagado</span>
              )}
              {resumen.porCobrar > 0 && (
                <span className="text-red-300">{resumen.porCobrar} por cobrar</span>
              )}
              {resumen.porConfirmar > 0 && (
                <span className="text-amber-300">{resumen.porConfirmar} sin confirmar</span>
              )}
            </div>
          )}
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {tickets.length === 0 ? (
            <p className="py-10 text-center text-sm text-zinc-500">
              Todavía no hay pedidos completados hoy.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {tickets.map((ticket) => (
                <li
                  key={ticket.orderNumber}
                  className="rounded-lg bg-white p-3 shadow-sm ring-1 ring-black/5"
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-xl font-extrabold leading-none tracking-tight text-zinc-900">
                      {shortOrderNumber(ticket.orderNumber)}
                    </span>
                    <span className="text-xs font-semibold tabular-nums text-zinc-500">
                      {formatClockTime(ticket.completedAt)}
                    </span>
                  </div>
                  <ul className="mt-1.5 flex flex-col gap-0.5">
                    {ticket.lines.map((line, i) => (
                      <li key={`${line.name}-${i}`} className="text-[13px] leading-tight text-zinc-700">
                        <span className="font-bold tabular-nums">{line.quantity}</span> {line.name}
                      </li>
                    ))}
                  </ul>
                  {/* Qué se cobra en la puerta. Va ENTRE los productos y
                      "Devolver a cocina" porque es lo que se lee mientras se
                      empaca; el botón de devolver es el salvavidas de un error
                      y casi nunca se toca.

                      Aquí ya casi nunca trae botones (03-09-2026): un pedido
                      listo tiene el comprobante aceptado, y con él la
                      instrucción quedó cerrada y ya salió al grupo de reparto.
                      Los botones que había eran dos dianas grandes, en la
                      pantalla que se mira con las manos ocupadas, capaces de
                      contradecir en silencio lo que el repartidor ya tenía
                      escrito. */}
                  {ticket.deliveryCollect && (
                    <CollectChip
                      collect={ticket.deliveryCollect}
                      orderNumber={ticket.orderNumber}
                      onDecided={onCollectDecided}
                    />
                  )}

                  {/* En recojo no hay puerta donde cobrar, así que no hay chip
                      —y entonces la etiqueta del comprobante es lo único que
                      dice si está pagado—. Callarla dejaría la tarjeta muda. */}
                  {ticket.deliveryCollect === null && ticket.amountLabel && (
                    <p className="mt-1.5 rounded-md bg-zinc-100 px-2 py-1 text-[12px] font-extrabold uppercase leading-tight tracking-wide text-zinc-700">
                      {ticket.amountLabel.text}
                    </p>
                  )}

                  <button
                    type="button"
                    disabled={busyOrder !== null}
                    onClick={() => onAction(ticket.orderNumber, 'recall')}
                    className="mt-2 h-12 w-full rounded-lg bg-blue-600 text-sm font-extrabold uppercase tracking-wide text-white hover:bg-blue-500 active:bg-blue-700 disabled:opacity-50"
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
