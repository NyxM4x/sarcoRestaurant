'use client';

import { useState, useTransition } from 'react';
import { kitchenDeliveryFeePaidAction } from '@/app/cocina/actions';
import { buttonsForStage, type KdsAction } from '@/lib/kitchen/kds-status';
import { formatElapsedSince, isLate } from '@/lib/kitchen/timer';
import { proofAlertOf, type KitchenProofAlert } from '@/lib/kitchen/proof-alert';
import type { PaymentGateState } from '@/lib/payment-proof/payment-gate';
import type { ProofAmountLabelView } from '@/lib/dashboard/attempt-review';
import type { DeliveryCollect } from '@/lib/kitchen/ticket-view';
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
   * POR QUÉ no se puede empezar, dicho con lo que de verdad hay delante.
   *
   * `no_proof` significa "ningún comprobante alimenta un intento", y eso NO es
   * lo mismo que "el cliente no mandó nada": un reenvío marcado como duplicado,
   * o uno con una excepción de enrutado, deja el archivo a la vista y la puerta
   * cerrada. El cartel decía "todavía no llegó el comprobante" con el
   * comprobante pintado tres centímetros más arriba, y eso se lee como una
   * pantalla que se contradice.
   */
  const sueltos = ticket.payment?.unlinkedProofs.length ?? 0;
  const motivoGate =
    ticket.gate.state === 'no_proof' && sueltos > 0
      ? 'Llegó un comprobante que no se pudo asociar. Míralo y pulsa «Usar este comprobante».'
      : GATE_REASONS[ticket.gate.state];

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
          {/* El número como se dice en voz alta, sin la fecha. Casi todo lo que
              hay en el tablero es de esta jornada; lo que no, lo dice la línea
              de abajo — que es donde cabe sin encoger este número. */}
          <h2 className="truncate text-3xl font-extrabold leading-none tracking-tight">
            {shortOrderNumber(ticket.orderNumber)}
          </h2>
          <span className="shrink-0 text-2xl font-bold leading-none tabular-nums">
            {formatElapsedSince(ticket.enteredAt, nowMs)}
          </span>
        </div>
        {/* ── DELIVERY o RECOJO, y poco más (03-09-2026) ──────────────────
            Esta línea llevaba además la etapa y el aviso de "No suma", y las
            tres competían por el mismo renglón a 12 px. El dato que de verdad
            se busca aquí es si el pedido SALE o lo VIENEN A BUSCAR: decide si
            se empaca para la moto o para el mostrador, y equivocarlo cuesta un
            viaje. Así que se queda solo y al doble de tamaño.
 
            La etapa no se pierde: la dice el color de esta cabecera —ámbar es
            nuevo, azul en preparación— y los botones de abajo, que solo ofrecen
            lo que toca hacer ahora.
 
            Lo que SÍ sigue escrito son las dos excepciones, porque un color no
            las puede decir: que el pedido va tarde, y que viene arrastrado de
            otra jornada. Las dos son raras; cuando salen, hay que leerlas. */}
        <p className="mt-1 truncate text-[20px] font-extrabold uppercase leading-tight tracking-wide">
          {DELIVERY_LABELS[ticket.deliveryType]}
          {late && ' · Atrasado'}
          {/* De una jornada anterior: se dice CON SU FECHA, porque el número de
              arriba va recortado y `ORD-036` de anoche se lee igual que el de
              hoy. El cronómetro, que aquí marcará horas, confirma lo mismo. */}
          {ticket.fromPreviousDay && ` · ${jornadaAnteriorLabel(ticket.orderNumber)}`}
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

        {/* ── El tamaño de la letra ────────────────────────────────────────
            Lo que se cocina es lo que más grande se lee: cantidad a 30 px y
            producto a 19 px. La escala subió al pasar el tablero a UNA fila
            (03-09-2026) —con dos, la tarjeta medía menos de 300 px de alto y
            esto no habría cabido—.

            La referencia no es una pantalla a medio metro: es la plancha, a un
            metro y medio, de reojo y con vapor. A esa distancia la diferencia
            entre 15 y 19 px es leerlo o acercarse, y acercarse cuesta un
            movimiento por pedido. Si algún día vuelven las dos filas, esto
            tiene que bajar con ellas o los productos saldrán cortados. */}
        {ticket.lines.length === 0 ? (
          <p className="text-base italic text-zinc-400">Sin productos registrados</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {ticket.lines.map((line, i) => (
              <li key={`${line.name}-${i}`}>
                <div className="flex items-baseline gap-2">
                  <span className="w-9 shrink-0 text-right text-3xl font-extrabold leading-tight tabular-nums text-zinc-900">
                    {line.quantity}
                  </span>
                  <span className="text-[19px] font-semibold leading-tight text-zinc-800">
                    {line.name}
                  </span>
                </div>
                {/* Modificadores: hoy siempre vacios (la base aun no los guarda),
                    pero la tarjeta ya esta lista para pintarlos. */}
                {line.modifiers.length > 0 && (
                  <ul className="mt-0.5 pl-11">
                    {line.modifiers.map((m, j) => (
                      <li key={`${m}-${j}`} className="text-[14px] font-medium text-orange-700">
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

          {/* Qué se cobra en la puerta: lo que el repartidor pregunta al llegar.
              Va junto al pago y antes de las notas, porque decide si hay que
              cobrar algo al entregar.

              Esta línea sale del PEDIDO y por eso está siempre. La etiqueta del
              análisis solo existe cuando el modelo pudo leer un monto en la
              imagen, y cuando no podía, el repartidor se quedaba sin ninguna
              instrucción —que es justo el problema que se reportó—. */}
          {ticket.deliveryCollect && (
            <CollectChip
              collect={ticket.deliveryCollect}
              orderNumber={ticket.orderNumber}
              onDecided={onPaymentDecided}
            />
          )}

          {/* Y la etiqueta del análisis solo cuando dice algo que la línea de
              arriba no diga ya.

              Se calla únicamente cuando HAY línea de cobro y la etiqueta sería
              lo mismo con otras palabras (`PAGO TOTAL`, `PAGO PRODUCTOS`). En
              recojo no hay línea de cobro —no hay puerta donde cobrar—, así que
              ahí la etiqueta sigue siendo la única que dice si está pagado, y
              callarla dejaría el ticket mudo. `REVISAR MONTO` no se calla nunca:
              es una alerta, no una instrucción. */}
          {ticket.amountLabel &&
            (ticket.deliveryCollect === null || ticket.amountLabel.code === 'revisar_monto') && (
              <AmountLabelChip label={ticket.amountLabel} />
            )}

          {ticket.notes && (
            <div className="mt-1.5 rounded-md bg-zinc-100 px-2 py-1.5">
              <p className="text-[11px] font-bold uppercase leading-none tracking-wider text-zinc-500">
                Notas
              </p>
              {/* La nota es una INSTRUCCIÓN, y se lee como tal: negrita y un punto
                  por debajo del producto (19 px). Con 16 px en peso medio se
                  perdía dentro de su propia caja gris —"sin cebolla" pesaba menos
                  que el nombre del plato al que corrige—, y a medio metro de la
                  plancha una nota que no destaca es una nota que no se ejecuta.

                  18 y no 19: por encima competiría con el producto, y quien lee
                  tiene que ver PRIMERO qué prepara y después cómo. */}
              <p className="mt-1 text-[18px] font-bold leading-tight text-zinc-800">
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
          <p className="mb-1.5 rounded-md bg-amber-50 px-2 py-1 text-[13px] font-bold leading-tight text-amber-900 ring-1 ring-amber-300">
            {motivoGate}
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
                    : 'h-14 flex-1 rounded-lg bg-emerald-600 text-xl font-extrabold tracking-wide text-white hover:bg-emerald-500 active:bg-emerald-700 disabled:opacity-50 disabled:hover:bg-emerald-600'
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
              className="mt-1.5 h-11 w-full rounded-md bg-zinc-200 text-sm font-bold uppercase tracking-wide text-zinc-700 hover:bg-zinc-300 active:bg-zinc-400 disabled:opacity-50"
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
 * Cómo se anuncia un pedido arrastrado de otra jornada.
 *
 * La fecha sale del propio número —`ORD-260902-036` lleva dentro la jornada en
 * la que se abrió— así que no hace falta un dato más en el ticket. Un número
 * con otro formato (la numeración vieja, `ORD-000123`) se queda con la frase
 * genérica: inventar una fecha sería peor que no darla.
 */
function jornadaAnteriorLabel(orderNumber: string): string {
  const partes = /^ORD-\d{2}(\d{2})(\d{2})-\d+$/.exec(orderNumber.trim());
  return partes === null ? 'Pedido de antes' : `Pedido del ${partes[2]}-${partes[1]}`;
}

/** Bs sin decimales cuando no hacen falta: "10" y no "10.00". */
function bs(amount: number): string {
  return Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
}

/**
 * Qué se cobra al entregar — la línea que quien empaca le canta al repartidor.
 *
 * Lleva el IMPORTE dentro del título y no solo en la explicación: en la puerta
 * de una casa, con el pedido en una mano, "cobrar el envío" obliga a ir a
 * buscar cuánto es, y ese viaje no se hace —se pregunta al cliente, que es
 * exactamente lo que no debe pasar—.
 *
 * ── DOS colores, y solo dos (03-09-2026) ───────────────────────────────────
 *
 * Rojo cuando hay dinero que recoger en la puerta —el envío o el pedido
 * entero— y azul cuando no hay nada que cobrar. Antes eran tres (verde, azul,
 * ámbar) repartidos por caso, y la pregunta que se hace quien lee esto a un
 * metro y con las manos ocupadas no tiene tres respuestas: o cobra o no cobra.
 * El color nunca comunica solo: siempre va con su palabra.
 *
 * ── Título mientras se puede marcar, TÍTULO cuando ya no ───────────────────
 *
 * Con botones debajo el chip es un control, y va en tinte suave para que los
 * botones manden. Sin ellos —aceptado el comprobante, o leído con claridad— es
 * una instrucción cerrada, y entonces se pinta en color pleno: es lo que se
 * busca de un vistazo en la lista de pedidos listos mientras se empaca.
 */
export function CollectChip({
  collect,
  orderNumber,
  onDecided,
}: {
  collect: DeliveryCollect;
  /** Sin él no se puede marcar nada: el botón no se pinta. */
  orderNumber?: string;
  onDecided?: () => void;
}) {
  /**
   * El título es la instrucción entera. La pista solo existe cuando AÑADE algo.
   *
   * "ENVÍO PAGADO" llevaba debajo "No cobrar nada al entregar", y "COBRAR ENVÍO
   * Bs 27", "la comida ya está pagada: en la puerta solo el envío". Las dos
   * decían con doce palabras lo que el título ya dice con dos, a gente que hace
   * esto cada noche. Una línea que no aporta enseña a no leer las que sí, y
   * justo debajo va la advertencia de que el comprobante no se pudo leer.
   *
   * El efectivo la conserva porque ahí el título NO se explica solo: "COBRAR
   * TODO" no dice que ese total lleva comida Y envío dentro, y esa suma es la
   * que se cobra en la puerta.
   */
  const { titulo, pista } =
    collect.kind === 'pagado'
      ? { titulo: 'ENVÍO PAGADO', pista: null }
      : collect.kind === 'envio'
        ? { titulo: `COBRAR ENVÍO Bs ${bs(collect.amount)}`, pista: null }
        : {
            titulo: `COBRAR TODO Bs ${bs(collect.amount)}`,
            pista: 'Pedido en efectivo: se cobra comida y envío al entregar',
          };

  /**
   * Una deducción no puede vestirse igual que un dato.
   *
   * `pedido` significa que nadie leyó el comprobante y esto sale de la regla
   * general. Iba en el mismo azul tranquilo que un dato confirmado, y quien lo
   * leía no tenía forma de notar la diferencia — cinco de veintidós pedidos de
   * una noche salieron así, mandando cobrar un envío que quizá ya estaba pagado.
   *
   * Ya no cambia el COLOR —el color dice si se cobra, y eso no depende de quién
   * lo diga— sino que lo dice con la palabra, que es lo que de verdad se lee.
   */
  const sinConfirmar = collect.basis === 'pedido';

  /** ¿Sigue siendo esto algo que se puede cambiar aquí mismo? */
  const conBotones = collect.canOverride && Boolean(orderNumber);
  const cobra = collect.kind !== 'pagado';

  const tono = conBotones
    ? cobra
      ? 'bg-red-50 ring-1 ring-red-300 text-red-900'
      : 'bg-sky-50 ring-1 ring-sky-300 text-sky-900'
    : cobra
      ? 'bg-red-600 text-white'
      : 'bg-sky-600 text-white';

  return (
    <div className={`mt-1.5 rounded-md px-2 py-1 ${tono}`}>
      <p
        className={`font-extrabold uppercase leading-tight tracking-wide ${
          conBotones ? 'text-[13px]' : 'text-[15px]'
        }`}
      >
        {titulo}
      </p>
      {/* La advertencia manda sobre la pista: cuando no se pudo leer el
          comprobante, eso es lo único que hay que decir debajo del título. Sin
          ninguna de las dos no se pinta el párrafo — un hueco vacío separa el
          título de sus botones sin motivo. */}
      {(sinConfirmar || pista) && (
        <p className="mt-0.5 text-[12px] font-medium leading-tight opacity-90">
          {sinConfirmar ? 'Sin confirmar: no se pudo leer el comprobante' : pista}
        </p>
      )}
      {collect.basis === 'persona' && (
        <p className="mt-0.5 text-[11px] font-semibold uppercase leading-tight tracking-wide opacity-70">
          Marcado a mano
        </p>
      )}
      {conBotones && orderNumber && (
        <CollectOverride
          orderNumber={orderNumber}
          // Lo que una PERSONA marcó, no lo que se dedujo. `null` = nadie se
          // pronunció, y entonces ningún botón sale hundido: un botón activo
          // sobre una suposición se lee como una decisión que nadie tomó.
          marcado={collect.basis === 'persona' ? collect.kind === 'pagado' : null}
          onDecided={onDecided}
        />
      )}
    </div>
  );
}

/**
 * Los dos botones que zanjan la duda mirando el comprobante.
 *
 * ── Por qué son DOS y no un interruptor ────────────────────────────────────
 *
 * Un toggle tiene un estado de partida, y aquí el estado de partida es
 * precisamente lo que no se sabe: la deducción no es una respuesta, es una
 * suposición. Con dos botones el primer toque es siempre una afirmación
 * explícita de quien miró la imagen, y no la aceptación por inercia de lo que
 * ya estaba puesto.
 *
 * Se quedan visibles después de marcar —el que está activo se ve hundido— para
 * que corregirse cueste un toque. Quien marca esto lo hace con el pedido en la
 * mano y prisa; equivocarse es parte del trabajo, y no poder desandarlo obliga
 * a llamar por teléfono, que es justo lo que esto vino a evitar.
 *
 * Esa ventana para corregirse dura hasta que se acepta el comprobante: ver
 * `canOverride` en `ticket-view`. Después no hay botones que pintar.
 *
 * Cada botón lleva el color del título al que lleva —azul el que deja el chip
 * en ENVÍO PAGADO, rojo el que lo deja en COBRAR— para que el toque y su
 * consecuencia se vean iguales. Con el verde de antes, pulsar "Ya pagó envío"
 * dejaba en pantalla un chip de otro color que el botón que se acababa de
 * tocar, y eso se lee como si no hubiera funcionado.
 */
function CollectOverride({
  orderNumber,
  marcado,
  onDecided,
}: {
  orderNumber: string;
  /** `null` = todavía nadie lo marcó. */
  marcado: boolean | null;
  onDecided?: () => void;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const marcar = (valor: boolean) => {
    setError(null);
    start(async () => {
      const res = await kitchenDeliveryFeePaidAction(orderNumber, valor);
      if (res.ok) onDecided?.();
      else setError(res.message);
    });
  };

  const base =
    'h-10 flex-1 rounded-md text-[12px] font-extrabold uppercase leading-tight tracking-wide ring-1 disabled:opacity-50';

  return (
    <div className="mt-1.5">
      <div className="flex gap-1.5">
        <button
          type="button"
          disabled={pending}
          onClick={() => marcar(true)}
          aria-pressed={marcado === true}
          className={`${base} ${
            marcado === true
              ? 'bg-sky-600 text-white ring-sky-700'
              : 'bg-white text-sky-800 ring-sky-400 hover:bg-sky-50'
          }`}
        >
          Ya pagó envío
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => marcar(false)}
          aria-pressed={marcado === false}
          className={`${base} ${
            marcado === false
              ? 'bg-red-600 text-white ring-red-700'
              : 'bg-white text-red-800 ring-red-400 hover:bg-red-50'
          }`}
        >
          Cobrar envío
        </button>
      </div>
      {error && (
        <p role="alert" className="mt-1 text-[11px] font-bold leading-tight text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}

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
      <p className="text-[13px] font-extrabold uppercase leading-tight tracking-wide">
        {label.text}
      </p>
      <p className="mt-0.5 text-[12px] font-medium leading-tight opacity-90">{label.hint}</p>
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

      {/* A quién dice el comprobante que fue el dinero (0034).
 
          Convierte la acusación en algo que se comprueba de un vistazo. "La
          cuenta que recibe NO es la nuestra" obliga a abrir la imagen para
          saber si es verdad; el nombre leído se lee desde donde se está. Y es
          lo único que delata cuando el equivocado es el filtro: si ahí sale
          nuestro propio nombre, la alerta es nuestra y no del cliente. */}
      {alert.destination && (
        <p className="mt-1 rounded bg-black/5 px-1.5 py-1 text-[11px] font-bold leading-tight">
          Dice que el dinero fue a: {alert.destination}
        </p>
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
