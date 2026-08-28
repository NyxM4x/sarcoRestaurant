'use client';

import { buttonsForStage, STAGE_LABELS, type KdsAction } from '@/lib/kitchen/kds-status';
import { formatElapsedSince, isLate } from '@/lib/kitchen/timer';
import { proofAlertOf, type KitchenProofAlert } from '@/lib/kitchen/proof-alert';
import { shortOrderNumber } from '@/lib/orders/order-number';
import type { KitchenTicket } from '@/lib/kitchen/ticket-view';
import { KitchenPaymentPanel } from './KitchenPaymentPanel';

/**
 * Ticket del KDS. No tiene temporizador propio: recibe `nowMs` del reloj
 * compartido del tablero (un unico `setInterval` para toda la pantalla).
 *
 * El color NUNCA comunica solo: el header amarillo/azul/rojo va siempre
 * acompanado de la etiqueta de etapa y, en alerta, de la palabra "Atrasado".
 */
export interface KitchenTicketCardProps {
  ticket: KitchenTicket;
  nowMs: number;
  busy: boolean;
  onAction: (orderNumber: string, action: KdsAction) => void;
  /**
   * Recarga el tablero tras decidir un pago. Opcional: sin él la tarjeta se
   * comporta igual, solo que el estado del pago espera al siguiente refresco.
   */
  onPaymentDecided?: () => void;
}

const DELIVERY_LABELS = {
  delivery: 'Delivery',
  pickup: 'Recojo en local',
} as const;

export function KitchenTicketCard({
  ticket,
  nowMs,
  busy,
  onAction,
  onPaymentDecided,
}: KitchenTicketCardProps) {
  // La alerta de atraso solo tiene sentido mientras el plato esta en la plancha.
  const late = ticket.stage === 'in_progress' && isLate(ticket.enteredAt, nowMs);
  const headerTone =
    late
      ? 'bg-red-600 text-white'
      : ticket.stage === 'in_progress'
        ? 'bg-blue-600 text-white'
        : 'bg-amber-300 text-zinc-900';

  const buttons = buttonsForStage(ticket.stage);

  /**
   * ¿Este ticket todavía no entra en el resumen de la derecha?
   *
   * Solo mientras está NUEVO y su pago sigue sin confirmar. En cuanto alguien
   * pulsa INICIAR, el pedido cuenta aunque el comprobante siga en revisión —la
   * comida ya se está haciendo—, así que decirlo entonces sería mentira.
   *
   * Se dice en el ticket, y no solo en el panel derecho, porque el panel informa
   * de CUÁNTO falta pero no de CUÁL: sin esta marca hay que abrir pedido por
   * pedido para encontrar el que está reteniendo el total.
   */
  const noSumaTodavia = ticket.stage === 'new' && ticket.awaitingPaymentConfirmation;

  /**
   * Aviso del análisis automático del comprobante.
   *
   * `null` la mayor parte del tiempo: solo aparece cuando hay algo que mirar. No
   * bloquea ningún botón ni oculta nada — el comprobante se abre igual y quien
   * decide sigue siendo quien está delante de la pantalla.
   */
  const alerta = proofAlertOf(ticket.payment);

  return (
    <article className="flex max-h-full w-80 shrink-0 flex-col overflow-hidden rounded-2xl bg-white shadow-md ring-1 ring-black/5">
      <header className={`shrink-0 px-4 py-3 ${headerTone}`}>
        <div className="flex items-baseline justify-between gap-3">
          {/* El número como se dice en voz alta. El tablero muestra UNA sola
              jornada, así que aquí no hace falta la fecha para desambiguar. */}
          <h2 className="truncate text-3xl font-extrabold tracking-tight">
            {shortOrderNumber(ticket.orderNumber)}
          </h2>
          <span className="shrink-0 text-2xl font-bold tabular-nums">
            {formatElapsedSince(ticket.enteredAt, nowMs)}
          </span>
        </div>
        <p className="mt-0.5 text-xs font-semibold uppercase tracking-wide opacity-90">
          {DELIVERY_LABELS[ticket.deliveryType]} · {STAGE_LABELS[ticket.stage]}
          {late && ' · Atrasado'}
          {noSumaTodavia && ' · No suma al resumen'}
        </p>
      </header>

      {/* Unica zona scrollable: un pedido enorme no rompe la columna. */}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {ticket.lines.length === 0 ? (
          <p className="text-sm italic text-zinc-400">Sin productos registrados</p>
        ) : (
          <ul className="flex flex-col gap-2.5">
            {ticket.lines.map((line, i) => (
              <li key={`${line.name}-${i}`}>
                <div className="flex items-baseline gap-2.5">
                  <span className="text-2xl font-extrabold tabular-nums text-zinc-900">
                    {line.quantity}
                  </span>
                  <span className="text-base font-semibold leading-snug text-zinc-800">
                    {line.name}
                  </span>
                </div>
                {/* Modificadores: hoy siempre vacios (la base aun no los guarda),
                    pero la tarjeta ya esta lista para pintarlos. */}
                {line.modifiers.length > 0 && (
                  <ul className="mt-1 pl-8">
                    {line.modifiers.map((m, j) => (
                      <li key={`${m}-${j}`} className="text-sm font-medium text-orange-700">
                        – {m}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <footer className="shrink-0 px-4 pb-4">
        {/* El pago va ANTES de las notas y de los botones: es lo que hay que
            mirar para decidir si se empieza. Nunca bloquea INICIAR — revisar un
            pago y avanzar el pedido son dimensiones separadas. */}
        <KitchenPaymentPanel
          payment={ticket.payment}
          amountDueByQr={ticket.amountDueByQr}
          onDecided={onPaymentDecided ?? (() => {})}
        />

        {/* El aviso va JUNTO a la nota de cocina y encima de ella: las dos cosas
            son "lee esto antes de tocar nada", y lo que se lee primero tiene que
            ser lo que puede costar dinero. */}
        {alerta && <ProofAlertBox alert={alerta} />}

        {ticket.notes && (
          <div className="mb-3 rounded-lg bg-zinc-100 px-3 py-2">
            <p className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Notas</p>
            <p className="mt-0.5 text-sm font-medium leading-snug text-zinc-800">{ticket.notes}</p>
          </div>
        )}

        <div className="flex gap-2">
          {buttons
            .filter((b) => b.kind !== 'secondary')
            .map((b) => (
              <button
                key={b.action}
                type="button"
                disabled={busy}
                onClick={() => onAction(ticket.orderNumber, b.action)}
                aria-label={b.kind === 'danger' ? 'Cancelar pedido' : undefined}
                className={
                  b.kind === 'danger'
                    ? 'grid h-16 w-16 shrink-0 place-items-center rounded-xl bg-red-600 text-white hover:bg-red-500 active:bg-red-700 disabled:opacity-50'
                    : 'h-16 flex-1 rounded-xl bg-emerald-600 text-xl font-extrabold tracking-wide text-white hover:bg-emerald-500 active:bg-emerald-700 disabled:opacity-50'
                }
              >
                {b.kind === 'danger' ? <TrashIcon /> : b.label}
              </button>
            ))}
        </div>

        {buttons
          .filter((b) => b.kind === 'secondary')
          .map((b) => (
            <button
              key={b.action}
              type="button"
              disabled={busy}
              onClick={() => onAction(ticket.orderNumber, b.action)}
              className="mt-2 h-11 w-full rounded-lg bg-zinc-200 text-sm font-bold uppercase tracking-wide text-zinc-700 hover:bg-zinc-300 active:bg-zinc-400 disabled:opacity-50"
            >
              {b.label}
            </button>
          ))}
      </footer>
    </article>
  );
}

/**
 * Aviso del análisis. Texto grande y motivos en lista: quien lo lee está de pie,
 * a un metro de la pantalla y con prisa.
 *
 * El color va SIEMPRE con la palabra —"Revisar este comprobante"— porque a esa
 * distancia un recuadro de color se confunde con el resto de la tarjeta, y
 * porque nadie debería tener que saberse un código de colores para cobrar.
 */
function ProofAlertBox({ alert }: { alert: KitchenProofAlert }) {
  const tono =
    alert.tone === 'red'
      ? 'bg-red-50 ring-red-300 text-red-900'
      : 'bg-amber-50 ring-amber-300 text-amber-900';
  return (
    <div role="status" className={`mb-3 rounded-lg px-3 py-2.5 ring-2 ${tono}`}>
      <p className="text-sm font-extrabold uppercase leading-tight tracking-wide">
        {alert.headline}
      </p>
      {alert.reasons.length > 0 && (
        <ul className="mt-1.5 space-y-1">
          {alert.reasons.map((r) => (
            <li key={r} className="text-sm font-semibold leading-snug">
              · {r}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function TrashIcon() {
  return (
    <svg
      width="26"
      height="26"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M3 6h18" />
      <path d="M8 6V4h8v2" />
      <path d="M19 6l-1 14H6L5 6" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  );
}
