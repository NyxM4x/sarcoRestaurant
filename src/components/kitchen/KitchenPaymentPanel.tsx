'use client';

import { useCallback, useState, useTransition } from 'react';
import { reviewLooseProofAction, reviewPaymentAttemptAction } from '@/app/dashboard/actions';
import type { AttemptView, PaymentView, ProofView } from '@/lib/dashboard/attempt-review';
import {
  NOTIFICATION_FAILED_NOTICE,
  reviewErrorMessage,
  type ReviewDecision,
} from '@/lib/payment-proof/review-result';

/**
 * Pago dentro del ticket del KDS.
 *
 * Misma decisión que en el panel del encargado y por el mismo camino: la Server
 * Action `reviewPaymentAttemptAction`, con su CAS atómico detrás. Lo que cambia
 * es la PRESENTACIÓN, no la lógica — aquí se toca con las manos ocupadas, en una
 * pantalla que se mira a un metro, así que todo es más grande y hay menos texto.
 *
 * ── Por qué no se reutiliza `PaymentSection` tal cual ───────────────────────
 *
 * Aquel componente resuelve otro problema: el encargado revisando el historial
 * completo de un pedido, con todos los episodios y sus comprobantes, en un panel
 * denso. Aquí solo importa una pregunta —¿este pago está bien para empezar a
 * cocinar?— y una sola respuesta. Meter los dos casos en un componente lo
 * llenaría de condicionales de presentación sin compartir ninguna regla real:
 * las reglas ya están compartidas, y están en el servidor.
 *
 * Lo que SÍ se comparte es todo lo que decide algo: la acción, los tipos de
 * vista, los textos de error y el endpoint del archivo.
 *
 * ── Confirmar un pago NO inicia el pedido ──────────────────────────────────
 *
 * Son dimensiones separadas, igual que en el panel. Este componente nunca llama
 * a `onAction`: quien decide el pago decide sobre el pago, y quien pulsa INICIAR
 * decide sobre la plancha. Que suelan ir seguidos no los convierte en lo mismo,
 * y acoplarlos dejaría la cocina parada ante cualquier fallo de captura.
 */

export interface KitchenPaymentPanelProps {
  payment: PaymentView | null;
  /**
   * Lo que el cliente debía transferir por QR. Es contra esto —y no contra el
   * total— que se contrasta el comprobante: en delivery el envío se paga al
   * recibir el pedido.
   */
  amountDueByQr: number;
  /**
   * ¿Este pedido se paga en EFECTIVO al recibirlo? (05-09-2026)
   *
   * Cambia el rótulo entero. "A cobrar por QR Bs 18" sobre un pedido en
   * efectivo es falso dos veces: no hay QR por el que cobrar, y esos Bs 18 no
   * son lo que nadie va a pedir —el repartidor cobra el total en la puerta, que
   * es lo que dice el chip de abajo—. Dos cifras distintas en el mismo ticket,
   * y la de arriba en el sitio donde se mira el dinero.
   */
  isCash: boolean;
  /** Refresca el tablero tras una decisión (o un conflicto). */
  onDecided: () => void;
}

const fileUrl = (proofId: string) =>
  `/api/dashboard/proofs/file?id=${encodeURIComponent(proofId)}`;

const TONE_CLASSES = {
  amber: 'bg-amber-100 text-amber-900 ring-amber-300',
  green: 'bg-emerald-100 text-emerald-900 ring-emerald-300',
  red: 'bg-red-100 text-red-900 ring-red-300',
} as const;

/** Bolivianos con dos decimales, como en el resto del producto. */
function formatBs(amount: number): string {
  return `Bs ${amount.toFixed(2).replace('.', ',')}`;
}

export function KitchenPaymentPanel({
  payment,
  amountDueByQr,
  isCash,
  onDecided,
}: KitchenPaymentPanelProps) {
  // El intento vigente es el más reciente; `toPaymentView` ya los ordena así.
  const attempt = payment?.attempts[0] ?? null;
  const sueltos = payment?.unlinkedProofs ?? [];

  return (
    <div className="rounded-md bg-zinc-100 px-2 py-1.5">
      {/* Rótulo y cifra en UNA línea.
 
          Apilados ocupaban 42 px de los 310 que mide la tarjeta en la tablet de
          cocina, y no por decir más: el rótulo es corto y la cifra es corta.
          Puestos en la misma línea dicen lo mismo en 20 px, y la mitad
          recuperada es una línea de producto que ahora se ve sin scroll.
 
          El rótulo dice QUÉ es la cifra. "Pago: Bs 48" invita a compararla con
          cualquier cosa; "A cobrar por QR" dice exactamente qué tiene que decir
          el comprobante que se está mirando. */}
      {/* En efectivo va el rótulo SOLO, sin cifra: la única que hay que cobrar
          está en el chip de la puerta, y repetir aquí otra distinta es la clase
          de duda que se resuelve mirando el ticket equivocado. */}
      {isCash ? (
        <p className="text-[10px] font-bold uppercase leading-none tracking-wider text-zinc-500">
          Paga en efectivo
        </p>
      ) : (
        <div className="flex items-baseline justify-between gap-2">
          <p className="text-[10px] font-bold uppercase leading-none tracking-wider text-zinc-500">
            A cobrar por QR
          </p>
          <p className="text-base font-extrabold leading-none tabular-nums text-zinc-900">
            {formatBs(amountDueByQr)}
          </p>
        </div>
      )}

      {attempt === null ? (
        // "Sin comprobante" es un dato en un pedido por QR —falta algo que tiene
        // que llegar— y una obviedad en uno en efectivo, donde no se espera
        // ninguno. Ahí no se escribe nada.
        sueltos.length > 0 ? (
          <p className="mt-1 text-xs font-semibold leading-tight text-zinc-500">
            Comprobante sin asociar
          </p>
        ) : isCash ? null : (
          <p className="mt-1 text-xs font-semibold leading-tight text-zinc-500">Sin comprobante</p>
        )
      ) : (
        <AttemptBlock attempt={attempt} onDecided={onDecided} />
      )}

      {/* Comprobantes que llegaron pero no se pudieron asociar a este intento.
          Se muestran igualmente: es la señal de que algo llegó y alguien tiene
          que mirarlo, que es justo lo que se perdía cuando no se pintaban.

          Y desde el 03-09-2026 traen su propio botón. Verlos sin poder hacer
          nada con ellos era peor que no verlos: un cliente reenvió su
          comprobante —había pagado de más y quería avisarlo—, el reenvío entró
          como duplicado, y quien cocinaba se quedó con el archivo delante y
          ningún botón para aceptar el pago. El pedido acabó borrándose y
          cobrándose por WhatsApp a mano. */}
      {sueltos.length > 0 && (
        <ul className="mt-1.5 space-y-1">
          {sueltos.map((p) => (
            <ProofRow key={p.id} proof={p} onReviewed={onDecided} />
          ))}
        </ul>
      )}
    </div>
  );
}

function AttemptBlock({
  attempt,
  onDecided,
}: {
  attempt: AttemptView;
  onDecided: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [confirmar, setConfirmar] = useState<ReviewDecision | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [decided, setDecided] = useState(false);

  const decide = useCallback(
    (decision: ReviewDecision) => {
      setError(null);
      setNotice(null);
      setConfirmar(null);
      startTransition(async () => {
        const res = await reviewPaymentAttemptAction(attempt.id, decision);
        if (res.ok) {
          // Los botones se retiran ya; el estado real llega con el refresco.
          setDecided(true);
          if (res.notification === 'failed') setNotice(NOTIFICATION_FAILED_NOTICE);
          onDecided();
          return;
        }
        setError(reviewErrorMessage(res.reason));
        // Tras un conflicto hay que mostrar lo que de verdad pasó: puede que el
        // encargado lo haya decidido desde su panel un segundo antes.
        if (res.reason === 'conflict') onDecided();
      });
    },
    [attempt.id, onDecided],
  );

  const mostrarAcciones = attempt.canDecide && !decided;

  return (
    <>
      {/*
        El estado se dice SOLO cuando ya no hay nada que decidir.
 
        Con los botones delante, "Pendiente de revisión" no aporta: lo mismo que
        dicen CONFIRMAR y RECHAZAR con más claridad, y encima no cambia al abrir
        el comprobante, así que se lee como un estado que no responde. Un cartel
        que repite lo evidente y no reacciona enseña a ignorar los carteles.
 
        Decidido, en cambio, es el único sitio donde consta si se aceptó o se
        rechazó, y ahí sí se muestra.
 
        El recuento de comprobantes se quitó entero: casi siempre es uno, y "1
        comprobante" ocupa una línea de un ticket que se mira a un metro para
        decir algo que la lista de abajo ya enseña.
      */}
      {!mostrarAcciones && (
        <div className="mt-1.5">
          <span
            className={`inline-block rounded px-1.5 py-0.5 text-[11px] font-bold leading-tight ring-1 ${TONE_CLASSES[attempt.tone]}`}
          >
            {attempt.statusLabel}
          </span>
        </div>
      )}

      {attempt.proofs.length > 0 && (
        <ul className="mt-1.5 space-y-1">
          {attempt.proofs.map((p) => (
            <ProofRow key={p.id} proof={p} />
          ))}
        </ul>
      )}

      {error && (
        <p role="alert" className="mt-1.5 text-xs font-semibold leading-tight text-red-700">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="mt-1.5 text-xs font-semibold leading-tight text-amber-800">
          {notice}
        </p>
      )}

      {mostrarAcciones && (
        <div className="mt-1.5">
          {/* Doble confirmación en AMBAS decisiones, igual que en el panel: en
              una pantalla táctil de cocina un roce accidental es más probable,
              no menos, y esto manda un WhatsApp al cliente. */}
          {confirmar !== null ? (
            <div>
              <p className="mb-1 text-xs font-bold leading-tight text-zinc-800">
                {confirmar === 'accept'
                  ? '¿Confirmar que este pago es correcto?'
                  : '¿Rechazar este pago?'}
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => decide(confirmar)}
                  className={`h-11 flex-1 rounded-lg text-sm font-extrabold text-white disabled:opacity-50 ${
                    confirmar === 'accept'
                      ? 'bg-emerald-600 active:bg-emerald-700'
                      : 'bg-red-600 active:bg-red-700'
                  }`}
                >
                  {pending ? 'Guardando…' : confirmar === 'accept' ? 'Sí, confirmar' : 'Sí, rechazar'}
                </button>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => setConfirmar(null)}
                  className="h-11 w-16 rounded-lg bg-zinc-300 text-sm font-bold text-zinc-800 active:bg-zinc-400 disabled:opacity-50"
                >
                  No
                </button>
              </div>
            </div>
          ) : (
            <div className="flex gap-2">
              <button
                type="button"
                disabled={pending}
                onClick={() => setConfirmar('accept')}
                className="h-11 flex-1 rounded-lg bg-emerald-600 text-sm font-extrabold text-white active:bg-emerald-700 disabled:opacity-50"
              >
                Confirmar pago
              </button>
              <button
                type="button"
                disabled={pending}
                onClick={() => setConfirmar('reject')}
                className="h-11 rounded-lg border-2 border-red-600 px-3 text-sm font-extrabold text-red-700 active:bg-red-50 disabled:opacity-50"
              >
                Rechazar
              </button>
            </div>
          )}
        </div>
      )}
    </>
  );
}

/** Qué decir cuando la revisión no se pudo abrir. Cada motivo, su frase. */
const LOOSE_ERRORS: Record<string, string> = {
  not_found: 'No se encontró este comprobante. Recarga el tablero.',
  no_order: 'Este comprobante no está unido a ningún pedido.',
  already_linked: 'Ya estaba en revisión. Recarga el tablero.',
  already_paid: 'Este pedido ya tiene un pago aceptado.',
  error: 'No se pudo abrir la revisión. Intenta de nuevo.',
};

/**
 * Un comprobante. Sin miniatura a propósito: en el KDS el espacio del ticket es
 * para los platos, y una foto de comprobante no se juzga en 80 píxeles. El botón
 * abre el archivo a tamaño completo por el endpoint autenticado.
 *
 * `onReviewed` solo llega en los comprobantes SUELTOS —los que no pertenecen a
 * ningún episodio de revisión— y es lo que los saca del callejón sin salida:
 * abre el intento sobre el pedido que el comprobante ya tenía y hace aparecer
 * CONFIRMAR y RECHAZAR. No acepta el pago: eso lo sigue decidiendo quien mira.
 */
function ProofRow({ proof, onReviewed }: { proof: ProofView; onReviewed?: () => void }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (!proof.isAvailable) {
    return (
      <li className="flex items-center gap-1.5 rounded bg-red-50 px-2 py-1">
        <span className="text-[11px] font-bold uppercase leading-tight tracking-wide text-red-700">
          Archivo no disponible
        </span>
        {proof.declaredLabel && (
          <span className="text-[11px] font-semibold text-red-600">({proof.declaredLabel})</span>
        )}
      </li>
    );
  }

  const revisar = () => {
    setError(null);
    start(async () => {
      const res = await reviewLooseProofAction(proof.id);
      // Tras un conflicto también se refresca: puede que otro lo haya puesto en
      // revisión un segundo antes, y entonces lo que hay que ver es el estado
      // real y no un error.
      if (res.ok || res.reason === 'already_linked') onReviewed?.();
      if (!res.ok) setError(LOOSE_ERRORS[res.reason] ?? LOOSE_ERRORS.error);
    });
  };

  return (
    <li>
      <a
        href={fileUrl(proof.id)}
        target="_blank"
        rel="noreferrer"
        className="flex h-11 items-center justify-center gap-2 rounded-lg bg-zinc-800 text-xs font-bold uppercase tracking-wide text-white active:bg-zinc-900"
      >
        Ver comprobante
        {proof.isDuplicate && (
          <span className="rounded bg-white/20 px-1.5 py-0.5 text-[10px]">Duplicado</span>
        )}
      </a>

      {onReviewed && (
        <>
          {/* Dice lo que va a pasar, no lo que es: "poner en revisión" deja al
              cocinero adivinando si eso cobra algo. Esto no cobra nada — hace
              aparecer los botones con los que él decide. */}
          <button
            type="button"
            disabled={pending}
            onClick={revisar}
            className="mt-1 h-11 w-full rounded-lg border-2 border-emerald-600 text-xs font-extrabold uppercase tracking-wide text-emerald-800 active:bg-emerald-50 disabled:opacity-50"
          >
            {pending ? 'Abriendo…' : 'Usar este comprobante'}
          </button>
          {error && (
            <p role="alert" className="mt-1 text-[11px] font-bold leading-tight text-red-700">
              {error}
            </p>
          )}
        </>
      )}
    </li>
  );
}
