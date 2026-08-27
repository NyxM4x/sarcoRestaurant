'use client';

import { useCallback, useState, useTransition } from 'react';
import type { AttemptView, PaymentView, ProofView } from '@/lib/dashboard/attempt-review';
import {
  NOTIFICATION_FAILED_NOTICE,
  reviewErrorMessage,
  type ReviewDecision,
} from '@/lib/payment-proof/review-result';
import { reviewPaymentAttemptAction } from '@/app/dashboard/actions';

/**
 * Sección de Pago del panel de detalle.
 *
 * Muestra el historial COMPLETO de intentos —el rechazado no desaparece porque
 * después se acepte otro— y permite decidir solo sobre el que está pendiente.
 *
 * El archivo nunca se pide por una URL del bucket: siempre a través del
 * endpoint autenticado `/api/dashboard/proofs/file`, que revalida la sesión en
 * cada petición. Aquí solo circula el id del comprobante.
 */

const TONE_CLASSES = {
  amber: 'bg-amber-50 text-amber-800 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-900',
  green: 'bg-emerald-50 text-emerald-800 ring-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-900',
  red: 'bg-red-50 text-red-800 ring-red-200 dark:bg-red-950/40 dark:text-red-300 dark:ring-red-900',
} as const;

function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('es-BO', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const fileUrl = (proofId: string) =>
  `/api/dashboard/proofs/file?id=${encodeURIComponent(proofId)}`;

/** Tarjeta de un comprobante: miniatura si es imagen, documento si es PDF. */
function ProofCard({ proof }: { proof: ProofView }) {
  const [imgFailed, setImgFailed] = useState(false);

  return (
    <li className="rounded-lg border border-black/[0.07] p-3 dark:border-white/10">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-xs text-zinc-500">Recibido: {formatDateTime(proof.receivedAt)}</p>
          {proof.associationLabel && (
            <p className="mt-0.5 text-xs text-zinc-600 dark:text-zinc-400">{proof.associationLabel}</p>
          )}
          {proof.exceptionLabel && (
            <p className="mt-0.5 text-xs font-medium text-amber-700 dark:text-amber-400">
              {proof.exceptionLabel}
            </p>
          )}
          <div className="mt-1 flex flex-wrap gap-1">
            {proof.isDuplicate && (
              <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-600 dark:bg-white/10 dark:text-zinc-300">
                Duplicado
              </span>
            )}
            {!proof.isAvailable && (
              <span className="rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-red-700 dark:bg-red-950/50 dark:text-red-300">
                Archivo no disponible
              </span>
            )}
            {/* Qué llegó, cuando no se pudo traer. Un "no disponible" a secas no
                distingue un PDF que aún no sabemos leer de una descarga caída, y
                son dos problemas con dos respuestas distintas. */}
            {!proof.isAvailable && proof.declaredLabel && (
              <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-600 dark:bg-white/10 dark:text-zinc-300">
                {proof.declaredLabel}
              </span>
            )}
          </div>
        </div>

        {/* Imagen: miniatura clicable. PDF o fallo: tarjeta de documento. La
            ausencia de miniatura NUNCA impide decidir el pago. */}
        {proof.isAvailable && proof.isImage && !imgFailed ? (
          <a
            href={fileUrl(proof.id)}
            target="_blank"
            rel="noreferrer"
            className="shrink-0"
            title="Abrir comprobante"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={fileUrl(proof.id)}
              alt="Comprobante de pago"
              onError={() => setImgFailed(true)}
              className="h-20 w-20 rounded-md object-cover ring-1 ring-black/10 dark:ring-white/15"
            />
          </a>
        ) : proof.isAvailable ? (
          <a
            href={fileUrl(proof.id)}
            target="_blank"
            rel="noreferrer"
            className="flex shrink-0 flex-col items-center gap-1 rounded-md border border-black/[0.07] px-3 py-2 text-center hover:bg-black/[0.03] dark:border-white/10 dark:hover:bg-white/[0.06]"
          >
            <DocumentIcon />
            <span className="text-[10px] font-semibold uppercase tracking-wide text-zinc-600 dark:text-zinc-300">
              {imgFailed ? 'Abrir' : 'PDF'}
            </span>
          </a>
        ) : null}
      </div>

      {proof.isAvailable && (
        <a
          href={fileUrl(proof.id)}
          target="_blank"
          rel="noreferrer"
          className="mt-2 inline-block text-xs font-medium text-zinc-700 underline underline-offset-2 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-white"
        >
          Abrir comprobante
        </a>
      )}
    </li>
  );
}

/** Un episodio de revisión con sus comprobantes y, si procede, sus acciones. */
function AttemptCard({
  attempt,
  onDecided,
}: {
  attempt: AttemptView;
  onDecided: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [confirmReject, setConfirmReject] = useState(false);
  const [confirmAccept, setConfirmAccept] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [decided, setDecided] = useState(false);

  const decide = useCallback(
    (decision: ReviewDecision) => {
      setError(null);
      setNotice(null);
      setConfirmReject(false);
      setConfirmAccept(false);
      startTransition(async () => {
        const res = await reviewPaymentAttemptAction(attempt.id, decision);
        if (res.ok) {
          // Los botones se retiran de inmediato; el estado real llega al recargar.
          setDecided(true);
          if (res.notification === 'failed') setNotice(NOTIFICATION_FAILED_NOTICE);
          onDecided();
          return;
        }
        setError(reviewErrorMessage(res.reason));
        // Tras un conflicto, el panel debe reflejar lo que de verdad pasó.
        if (res.reason === 'conflict') onDecided();
      });
    },
    [attempt.id, onDecided],
  );

  const showActions = attempt.canDecide && !decided;

  return (
    <li className="rounded-lg border border-black/[0.07] p-3 dark:border-white/10">
      <div className="flex items-center justify-between gap-2">
        <span
          className={`rounded px-2 py-0.5 text-xs font-semibold ring-1 ${TONE_CLASSES[attempt.tone]}`}
        >
          {attempt.statusLabel}
        </span>
        <span className="text-xs text-zinc-500">
          {attempt.proofCount} {attempt.proofCount === 1 ? 'comprobante' : 'comprobantes'}
        </span>
      </div>

      <dl className="mt-2 space-y-0.5 text-xs text-zinc-600 dark:text-zinc-400">
        <div className="flex gap-2">
          <dt>Abierto:</dt>
          <dd>{formatDateTime(attempt.openedAt)}</dd>
        </div>
        {attempt.reviewedAt && (
          <div className="flex gap-2">
            <dt>Decidido:</dt>
            <dd>{formatDateTime(attempt.reviewedAt)}</dd>
          </div>
        )}
      </dl>

      {attempt.proofs.length > 0 && (
        <ul className="mt-2 space-y-2">
          {attempt.proofs.map((p) => (
            <ProofCard key={p.id} proof={p} />
          ))}
        </ul>
      )}

      {notice && (
        <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
          {notice}
        </p>
      )}
      {error && (
        <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </p>
      )}

      {showActions && (
        <div className="mt-3 space-y-2">
          {/* Doble confirmación en AMBAS decisiones: un clic accidental no
              confirma ni rechaza el pago de nadie. */}
          {confirmAccept ? (
            <ConfirmRow
              question="¿Confirmar que este pago es correcto?"
              confirmLabel="Sí, confirmar"
              tone="green"
              pending={pending}
              onConfirm={() => decide('accept')}
              onCancel={() => setConfirmAccept(false)}
            />
          ) : confirmReject ? (
            <ConfirmRow
              question="¿Confirmar que deseas rechazar este pago?"
              confirmLabel="Sí, rechazar"
              tone="red"
              pending={pending}
              onConfirm={() => decide('reject')}
              onCancel={() => setConfirmReject(false)}
            />
          ) : (
            <div className="flex gap-2">
              <button
                type="button"
                disabled={pending}
                onClick={() => setConfirmAccept(true)}
                className="flex-1 rounded-lg bg-emerald-600 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
              >
                Confirmar pago
              </button>
              <button
                type="button"
                disabled={pending}
                onClick={() => setConfirmReject(true)}
                className="rounded-lg border border-red-300 px-3 py-2 text-sm font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50 dark:border-red-900 dark:text-red-300 dark:hover:bg-red-950/40"
              >
                Rechazar
              </button>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

function ConfirmRow({
  question,
  confirmLabel,
  tone,
  pending,
  onConfirm,
  onCancel,
}: {
  question: string;
  confirmLabel: string;
  tone: 'green' | 'red';
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="rounded-lg bg-black/[0.03] p-2 dark:bg-white/[0.06]">
      <p className="mb-2 text-xs font-medium text-zinc-700 dark:text-zinc-200">{question}</p>
      <div className="flex gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={onConfirm}
          className={`flex-1 rounded-lg py-2 text-sm font-semibold text-white disabled:opacity-50 ${
            tone === 'green' ? 'bg-emerald-600 hover:bg-emerald-500' : 'bg-red-600 hover:bg-red-500'
          }`}
        >
          {pending ? 'Guardando…' : confirmLabel}
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={onCancel}
          className="rounded-lg border border-black/10 px-4 py-2 text-sm font-medium disabled:opacity-50 dark:border-white/15"
        >
          No
        </button>
      </div>
    </div>
  );
}

function DocumentIcon() {
  return (
    <svg
      width="28"
      height="28"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className="text-zinc-500"
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
    </svg>
  );
}

export function PaymentSection({
  payment,
  onDecided,
}: {
  payment: PaymentView | null;
  onDecided: () => void;
}) {
  if (!payment) return null;
  const vacio = payment.attempts.length === 0 && payment.unlinkedProofs.length === 0;

  return (
    <div>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Pago</h3>

      {vacio ? (
        <p className="rounded-lg border border-dashed border-black/[0.12] px-3 py-3 text-sm text-zinc-500 dark:border-white/15">
          Sin comprobantes recibidos para este pedido.
        </p>
      ) : (
        <ul className="space-y-2">
          {payment.attempts.map((a) => (
            <AttemptCard key={a.id} attempt={a} onDecided={onDecided} />
          ))}
        </ul>
      )}

      {payment.unlinkedProofs.length > 0 && (
        <div className="mt-3">
          <p className="mb-1 text-xs font-medium text-zinc-500">
            Comprobantes sin asociar a un intento
          </p>
          <ul className="space-y-2">
            {payment.unlinkedProofs.map((p) => (
              <ProofCard key={p.id} proof={p} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
