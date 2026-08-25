'use client';

import { useEffect, useRef } from 'react';

/**
 * Modal de confirmacion del KDS. Un unico componente para las dos
 * confirmaciones (completar en verde, cancelar en rojo): en una tablet tactil
 * un roce accidental no puede despachar ni tirar un pedido.
 *
 * `Escape` equivale a NO.
 */
export interface KitchenConfirmModalProps {
  question: string;
  tone: 'green' | 'red';
  confirmLabel: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

const TONES = {
  green: 'bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700',
  red: 'bg-red-600 hover:bg-red-500 active:bg-red-700',
} as const;

export function KitchenConfirmModal({
  question,
  tone,
  confirmLabel,
  busy,
  onConfirm,
  onCancel,
}: KitchenConfirmModalProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  // Escape = NO. El foco arranca en NO: la opcion segura.
  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={question}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="w-full max-w-lg rounded-2xl bg-white p-8 shadow-2xl">
        <p className="text-center text-2xl font-bold leading-snug text-zinc-900">{question}</p>
        <div className="mt-8 grid grid-cols-2 gap-4">
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className={`h-20 rounded-xl text-2xl font-extrabold tracking-wide text-white disabled:opacity-60 ${TONES[tone]}`}
          >
            {busy ? '…' : confirmLabel}
          </button>
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="h-20 rounded-xl bg-zinc-200 text-2xl font-extrabold tracking-wide text-zinc-800 hover:bg-zinc-300 active:bg-zinc-400 disabled:opacity-60"
          >
            NO
          </button>
        </div>
      </div>
    </div>
  );
}
