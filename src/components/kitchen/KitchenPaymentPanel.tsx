'use client';

import { useCallback, useState, useTransition } from 'react';
import { reviewPaymentAttemptAction } from '@/app/dashboard/actions';
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
  onDecided,
}: KitchenPaymentPanelProps) {
  // El intento vigente es el más reciente; `toPaymentView` ya los ordena así.
  const attempt = payment?.attempts[0] ?? null;
  const sueltos = payment?.unlinkedProofs ?? [];

  return (
    <div className="mb-3 rounded-lg bg-zinc-100 px-3 py-2.5">
      <div className="flex items-baseline justify-between gap-2">
        {/* El rótulo dice QUÉ es la cifra. "Pago: Bs 48" invita a compararla con
            cualquier cosa; "A cobrar por QR" dice exactamente qué tiene que
            decir el comprobante que se está mirando. */}
        <p className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">
          A cobrar por QR
        </p>
        <p className="text-lg font-extrabold tabular-nums text-zinc-900">
          {formatBs(amountDueByQr)}
        </p>
      </div>

      {attempt === null ? (
        <p className="mt-1 text-sm font-semibold text-zinc-500">
          {sueltos.length > 0 ? 'Comprobante sin asociar' : 'Sin comprobante'}
        </p>
      ) : (
        <AttemptBlock attempt={attempt} onDecided={onDecided} />
      )}

      {/* Comprobantes que llegaron pero no se pudieron asociar a este intento.
          Se muestran igualmente: es la señal de que algo llegó y alguien tiene
          que mirarlo, que es justo lo que se perdía cuando no se pintaban. */}
      {sueltos.length > 0 && (
        <ul className="mt-2 space-y-1.5">
          {sueltos.map((p) => (
            <ProofRow key={p.id} proof={p} />
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
      <div className="mt-1.5 flex items-center justify-between gap-2">
        <span
          className={`rounded px-2 py-1 text-sm font-bold ring-1 ${TONE_CLASSES[attempt.tone]}`}
        >
          {attempt.statusLabel}
        </span>
        <span className="text-xs font-medium text-zinc-500">
          {attempt.proofCount} {attempt.proofCount === 1 ? 'comprobante' : 'comprobantes'}
        </span>
      </div>

      {attempt.proofs.length > 0 && (
        <ul className="mt-2 space-y-1.5">
          {attempt.proofs.map((p) => (
            <ProofRow key={p.id} proof={p} />
          ))}
        </ul>
      )}

      {error && (
        <p role="alert" className="mt-2 text-sm font-semibold text-red-700">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="mt-2 text-sm font-semibold text-amber-800">
          {notice}
        </p>
      )}

      {mostrarAcciones && (
        <div className="mt-2.5">
          {/* Doble confirmación en AMBAS decisiones, igual que en el panel: en
              una pantalla táctil de cocina un roce accidental es más probable,
              no menos, y esto manda un WhatsApp al cliente. */}
          {confirmar !== null ? (
            <div>
              <p className="mb-1.5 text-sm font-bold text-zinc-800">
                {confirmar === 'accept'
                  ? '¿Confirmar que este pago es correcto?'
                  : '¿Rechazar este pago?'}
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => decide(confirmar)}
                  className={`h-12 flex-1 rounded-lg text-base font-extrabold text-white disabled:opacity-50 ${
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
                  className="h-12 w-20 rounded-lg bg-zinc-300 text-base font-bold text-zinc-800 active:bg-zinc-400 disabled:opacity-50"
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
                className="h-12 flex-1 rounded-lg bg-emerald-600 text-base font-extrabold text-white active:bg-emerald-700 disabled:opacity-50"
              >
                Confirmar pago
              </button>
              <button
                type="button"
                disabled={pending}
                onClick={() => setConfirmar('reject')}
                className="h-12 rounded-lg border-2 border-red-600 px-4 text-base font-extrabold text-red-700 active:bg-red-50 disabled:opacity-50"
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

/**
 * Un comprobante. Sin miniatura a propósito: en el KDS el espacio del ticket es
 * para los platos, y una foto de comprobante no se juzga en 80 píxeles. El botón
 * abre el archivo a tamaño completo por el endpoint autenticado.
 */
function ProofRow({ proof }: { proof: ProofView }) {
  if (!proof.isAvailable) {
    return (
      <li className="flex items-center gap-2 rounded-md bg-red-50 px-2 py-1.5">
        <span className="text-xs font-bold uppercase tracking-wide text-red-700">
          Archivo no disponible
        </span>
        {proof.declaredLabel && (
          <span className="text-xs font-semibold text-red-600">({proof.declaredLabel})</span>
        )}
      </li>
    );
  }

  return (
    <li>
      <a
        href={fileUrl(proof.id)}
        target="_blank"
        rel="noreferrer"
        className="flex h-11 items-center justify-center gap-2 rounded-lg bg-zinc-800 text-sm font-bold uppercase tracking-wide text-white active:bg-zinc-900"
      >
        Ver comprobante
        {proof.isDuplicate && (
          <span className="rounded bg-white/20 px-1.5 py-0.5 text-[10px]">Duplicado</span>
        )}
      </a>
    </li>
  );
}
