'use client';

import { buttonsForStage, STAGE_LABELS, type KdsAction } from '@/lib/kitchen/kds-status';
import { formatElapsedSince, isLate } from '@/lib/kitchen/timer';
import { proofAlertOf, type KitchenProofAlert } from '@/lib/kitchen/proof-alert';
import type { PaymentGateState } from '@/lib/payment-proof/payment-gate';
import type { ProofAmountLabelView } from '@/lib/dashboard/attempt-review';
import { shortOrderNumber } from '@/lib/orders/order-number';
import type { KitchenTicket } from '@/lib/kitchen/ticket-view';
import { KitchenPaymentPanel } from './KitchenPaymentPanel';

/**
 * Ticket del KDS. No tiene temporizador propio: recibe `nowMs` del reloj
 * compartido del tablero (un unico `setInterval` para toda la pantalla).
 *
 * El color NUNCA comunica solo: el header amarillo/azul/rojo va siempre
 * acompanado de la etiqueta de etapa y, en alerta, de la palabra "Atrasado".
 *
 * ── Por qué la tarjeta tiene esta forma (12,5") ────────────────────────────
 *
 * El tablero corre en una Latitude 5290: 12,5 pulgadas, 1920×1080 físicos que
 * con el escalado de Windows al 150 % dan un viewport de **1280×720 CSS**. En
 * esa pantalla la tarjeta anterior medía casi 500 px de alto, así que solo
 * cabía UNA por columna y el tablero enseñaba tres pedidos.
 *
 * El culpable no eran las fuentes: era el footer, que crecía sin límite —pago,
 * chips, avisos, notas y botones, todo apilado— y empujaba la tarjeta hasta
 * donde hiciera falta. Ahora la tarjeta ocupa su celda del grid y NO crece:
 *
 *   · cabecera        fija arriba, siempre visible
 *   · zona scrollable platos, pago, avisos y notas
 *   · botones         fijos abajo, siempre alcanzables con el pulgar
 *
 * Lo que no cabe se scrollea dentro de la tarjeta en vez de robarle sitio al
 * pedido de al lado. Y lo que va primero dentro del scroll es lo que hay que
 * HACER, no lo que hay que saber: normalmente los platos, pero el pago cuando es
 * lo que impide arrancar. Con el pago siempre al final, sus botones salían
 * cortados por la mitad en el borde del scroll, y medio botón verde asomando es
 * peor que ninguno — se lee como una pantalla rota.
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
  pickup: 'Recojo',
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

  /**
   * ¿Está cerrada la puerta del pago para INICIAR? (0028)
   *
   * Solo afecta al botón de arranque de un ticket NUEVO. El estado viene ya
   * resuelto del servidor —`ticket.gate`— y es el MISMO valor que `applyAction`
   * comprueba antes de escribir: la pantalla no reimplementa la regla, la
   * refleja. Si la reimplementara, un día enseñaría un botón que el servidor
   * rechaza, y eso solo se descubre pulsándolo.
   */
  const pagoBloqueaInicio = ticket.stage === 'new' && !ticket.gate.canStart;

  /**
   * El pago, en un sitio o en otro según lo que haga falta hacer con él.
   *
   * Es el MISMO componente y el mismo estado; lo único que cambia es dónde se
   * pinta. Cuando el pago impide arrancar, sus botones son la tarea pendiente
   * del ticket y van arriba del todo; cuando no, es un dato de consulta y va
   * detrás de los platos.
   */
  const bloquePago = (
    <KitchenPaymentPanel
      payment={ticket.payment}
      amountDueByQr={ticket.amountDueByQr}
      onDecided={onPaymentDecided ?? (() => {})}
    />
  );

  return (
    <article className="flex h-full min-h-0 w-full flex-col overflow-hidden rounded-xl bg-white shadow-md ring-1 ring-black/5">
      {/* ── Cabecera: fija ─────────────────────────────────────────────────
          El número y el reloj no se scrollean nunca. Son lo que se busca con
          la vista desde dos metros para localizar un pedido concreto. */}
      <header className={`shrink-0 px-3 py-2 ${headerTone}`}>
        <div className="flex items-baseline justify-between gap-2">
          {/* El número como se dice en voz alta. El tablero muestra UNA sola
              jornada, así que aquí no hace falta la fecha para desambiguar. */}
          <h2 className="truncate text-2xl font-extrabold leading-none tracking-tight">
            {shortOrderNumber(ticket.orderNumber)}
          </h2>
          <span className="shrink-0 text-xl font-bold leading-none tabular-nums">
            {formatElapsedSince(ticket.enteredAt, nowMs)}
          </span>
        </div>
        <p className="mt-1 truncate text-[10px] font-bold uppercase leading-tight tracking-wide opacity-90">
          {DELIVERY_LABELS[ticket.deliveryType]} · {STAGE_LABELS[ticket.stage]}
          {late && ' · Atrasado'}
          {noSumaTodavia && ' · No suma'}
        </p>
      </header>

      {/* ── Zona scrollable ────────────────────────────────────────────────
          Es la única parte elástica de la tarjeta. Todo lo que antes hacía
          crecer el footer vive aquí dentro, así que un pedido con aviso, chip
          de monto y notas ya no le quita altura a la fila de abajo.

          El ORDEN de lo que va dentro no es fijo: lo decide `pagoBloqueaInicio`.
          Ver `bloquePago`. */}
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {/* Pago ARRIBA cuando es lo que impide cocinar: sus botones son la
            acción a hacer ahora, y al final del scroll salían cortados por la
            mitad — medio botón verde asomando es peor que ninguno. */}
        {pagoBloqueaInicio && <div className="mb-2">{bloquePago}</div>}

        {ticket.lines.length === 0 ? (
          <p className="text-sm italic text-zinc-400">Sin productos registrados</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {ticket.lines.map((line, i) => (
              <li key={`${line.name}-${i}`}>
                <div className="flex items-baseline gap-2">
                  <span className="w-6 shrink-0 text-right text-xl font-extrabold leading-tight tabular-nums text-zinc-900">
                    {line.quantity}
                  </span>
                  <span className="text-[15px] font-semibold leading-tight text-zinc-800">
                    {line.name}
                  </span>
                </div>
                {/* Modificadores: hoy siempre vacios (la base aun no los guarda),
                    pero la tarjeta ya esta lista para pintarlos. */}
                {line.modifiers.length > 0 && (
                  <ul className="mt-0.5 pl-8">
                    {line.modifiers.map((m, j) => (
                      <li key={`${m}-${j}`} className="text-xs font-medium text-orange-700">
                        – {m}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}

        {/* Con la puerta abierta el pago va DESPUÉS de los platos: no hay nada
            que decidir, así que es una referencia y no una tarea, y lo que se
            cocina manda sobre lo que se cobra. */}
        <div className="mt-2 border-t border-zinc-200 pt-2">
          {!pagoBloqueaInicio && bloquePago}

          {/* El aviso va JUNTO a la nota de cocina y encima de ella: las dos
              cosas son "lee esto antes de tocar nada", y lo que se lee primero
              tiene que ser lo que puede costar dinero. */}
          {alerta && <ProofAlertBox alert={alerta} />}

          {/* Qué pagó: lo que el repartidor pregunta al llegar. Va junto al pago
              y antes de las notas, porque decide si hay que cobrar en la puerta. */}
          {ticket.amountLabel && <AmountLabelChip label={ticket.amountLabel} />}

          {ticket.notes && (
            <div className="mt-1.5 rounded-md bg-zinc-100 px-2 py-1.5">
              <p className="text-[10px] font-bold uppercase leading-none tracking-wider text-zinc-500">
                Notas
              </p>
              <p className="mt-1 text-[13px] font-medium leading-tight text-zinc-800">
                {ticket.notes}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* ── Botones: fijos abajo ───────────────────────────────────────────
          Nunca se scrollean. En cocina se toca con las manos ocupadas y a
          medio metro; un botón que hay que ir a buscar con el dedo es un botón
          que se pulsa mal.

          56 px de alto y no 48. Los 48 cumplen de sobra el mínimo táctil de la
          WCAG (44), pero este proyecto se puso un listón más alto para cocina
          —hay un test que lo exige— y bajarlo aquí habría sido cobrarle la
          densidad a la mano que trabaja con grasa y prisa. Los 8 px salen del
          bloque de pago, que solo se lee. */}
      {/* El borde superior no es decoración: es lo que convierte el corte del
          scroll en "esto sigue detrás" en vez de "esto está roto". Sin él, un
          chip cortado por la mitad justo encima de los botones se lee como un
          fallo de pintado — y en cocina un fallo de pintado detiene a alguien. */}
      <footer className="shrink-0 border-t border-zinc-200 px-3 pb-3 pt-2">
        {/* POR QUÉ no se puede empezar. Un botón gris sin explicación se lee
            como una pantalla rota, y en cocina eso acaba en una llamada. */}
        {pagoBloqueaInicio && (
          <p className="mb-1.5 rounded-md bg-amber-50 px-2 py-1 text-[11px] font-bold leading-tight text-amber-900 ring-1 ring-amber-300">
            {GATE_REASONS[ticket.gate.state]}
          </p>
        )}

        <div className="flex gap-2">
          {buttons
            .filter((b) => b.kind !== 'secondary')
            .map((b) => (
              <button
                key={b.action}
                type="button"
                // Cancelar SIEMPRE se puede: si el cliente no pagó, lo que hace
                // falta es poder cerrar el pedido, no quedarse sin botones.
                disabled={busy || (b.action === 'start' && pagoBloqueaInicio)}
                onClick={() => onAction(ticket.orderNumber, b.action)}
                aria-label={b.kind === 'danger' ? 'Cancelar pedido' : undefined}
                className={
                  b.kind === 'danger'
                    ? 'grid h-14 w-14 shrink-0 place-items-center rounded-lg bg-red-600 text-white hover:bg-red-500 active:bg-red-700 disabled:opacity-50'
                    : 'h-14 flex-1 rounded-lg bg-emerald-600 text-lg font-extrabold tracking-wide text-white hover:bg-emerald-500 active:bg-emerald-700 disabled:opacity-50 disabled:hover:bg-emerald-600'
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
              className="mt-1.5 h-11 w-full rounded-md bg-zinc-200 text-xs font-bold uppercase tracking-wide text-zinc-700 hover:bg-zinc-300 active:bg-zinc-400 disabled:opacity-50"
            >
              {b.label}
            </button>
          ))}
      </footer>
    </article>
  );
}

/**
 * Por qué está cerrada la puerta, dicho para quien tiene la plancha delante.
 *
 * Cada estado dice la ACCIÓN que corresponde, no el estado interno: "acepta el
 * pago para empezar" se puede hacer ahora mismo, "awaiting_review" no significa
 * nada a un metro de distancia y con prisa.
 */
const GATE_REASONS: Record<PaymentGateState, string> = {
  awaiting_review: 'Revisa el comprobante y acepta el pago para empezar.',
  no_proof: 'Todavía no llegó el comprobante de este pedido.',
  rejected_grace: 'Pago rechazado. El cliente tiene unos minutos para reenviarlo.',
  expired: 'El cliente no reenvió el comprobante a tiempo. Se puede cancelar.',
  // Los tres que ABREN la puerta no llegan a pintarse nunca.
  accepted: '',
  not_required: '',
  unknown: '',
};

/**
 * Qué pagó el cliente. Tres palabras en mayúsculas y una línea de qué hacer.
 *
 * `PAGO PRODUCTOS` NO es una alerta —es el caso normal en delivery— así que va
 * en azul y no en ámbar: teñir de aviso lo esperado gasta la atención que
 * necesita el rojo. El color nunca comunica solo; siempre va con su palabra.
 */
function AmountLabelChip({ label }: { label: ProofAmountLabelView }) {
  const tono =
    label.code === 'pago_total'
      ? 'bg-emerald-50 ring-emerald-300 text-emerald-900'
      : label.code === 'pago_productos'
        ? 'bg-sky-50 ring-sky-300 text-sky-900'
        : 'bg-red-50 ring-red-300 text-red-900';
  return (
    <div className={`mt-1.5 rounded-md px-2 py-1 ring-1 ${tono}`}>
      <p className="text-[11px] font-extrabold uppercase leading-tight tracking-wide">
        {label.text}
      </p>
      <p className="mt-0.5 text-[11px] font-medium leading-tight opacity-90">{label.hint}</p>
    </div>
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
    <div role="status" className={`mt-1.5 rounded-md px-2 py-1.5 ring-2 ${tono}`}>
      <p className="text-xs font-extrabold uppercase leading-tight tracking-wide">
        {alert.headline}
      </p>
      {alert.reasons.length > 0 && (
        <ul className="mt-1 space-y-0.5">
          {alert.reasons.map((r) => (
            <li key={r} className="text-[11px] font-semibold leading-tight">
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
      width="22"
      height="22"
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
