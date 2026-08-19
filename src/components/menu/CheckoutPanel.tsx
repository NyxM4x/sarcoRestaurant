'use client';

import { useEffect, useId } from 'react';
import type { DeliveryType, PaymentMethod } from '@/types';
import type { CartSummary } from '@/lib/cart/cart';
// Solo presentación de totales: `Bs 45,00`. No altera campos, validaciones ni el
// cálculo server-side (la autoridad de precio sigue en el servidor).
import { formatMoney } from '@/lib/dashboard/format';
import { MAX_CUSTOMER_NAME_LENGTH, MAX_NOTES_LENGTH } from '@/lib/checkout/limits';
import type { CheckoutFormErrors, CheckoutFormFields } from '@/lib/checkout/form';
import type { CheckoutFailure } from '@/lib/checkout/errors';

/**
 * Formulario del checkout: misma hoja inferior que el carrito, sin librerías.
 *
 * Es un componente controlado: no guarda estado propio. Todo vive en el reducer
 * (`@/lib/checkout/state`), que también decide cuándo los campos están
 * congelados. Aquí solo se pinta.
 */
export function CheckoutPanel({
  open,
  fields,
  errors,
  summary,
  submitting,
  frozen,
  failure,
  canRetry,
  canSubmit,
  onChange,
  onSubmit,
  onRetry,
  onBackToCart,
  onClose,
}: {
  open: boolean;
  fields: CheckoutFormFields;
  errors: CheckoutFormErrors;
  summary: CartSummary;
  submitting: boolean;
  /** Campos y carrito bloqueados: envío en vuelo o resultado ambiguo. */
  frozen: boolean;
  failure: CheckoutFailure | null;
  canRetry: boolean;
  /** El reducer aceptaría un envío. Si es `false`, no se muestra «Confirmar pedido». */
  canSubmit: boolean;
  onChange: (field: keyof CheckoutFormFields, value: string) => void;
  onSubmit: () => void;
  onRetry: () => void;
  onBackToCart: () => void;
  onClose: () => void;
}) {
  const nameId = useId();
  const notesId = useId();
  const deliveryId = useId();
  const paymentId = useId();

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      // Con un envío en vuelo o un resultado ambiguo, Escape no cierra.
      if (event.key === 'Escape' && !frozen) onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, frozen, onClose]);

  if (!open) return null;

  const notesLength = fields.notes.trim().length;
  const isDelivery = fields.delivery_type === 'delivery';
  /** 401 y 409: el enlace se agotó, no hay nada que reintentar. */
  const terminal = failure?.recovery === 'none';
  /** El producto ya no está: hay que volver al carrito antes de reenviar. */
  const needsCartReview = failure?.recovery === 'fix_cart';
  const showRetryOnly = !submitting && canRetry;

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end">
      <button
        type="button"
        aria-label="Cerrar checkout"
        onClick={frozen ? undefined : onClose}
        disabled={frozen}
        className="absolute inset-0 bg-black/50 disabled:cursor-default"
      />

      <section
        role="dialog"
        aria-modal="true"
        aria-label="Confirma tu pedido"
        className="relative flex max-h-[90vh] flex-col rounded-t-3xl bg-white"
      >
        {/* Encabezado */}
        <div className="flex items-center justify-between border-b border-zinc-100 px-4 py-4">
          <button
            type="button"
            onClick={onBackToCart}
            disabled={frozen}
            aria-label="Volver al carrito"
            className="flex h-9 w-9 items-center justify-center rounded-full bg-zinc-100 text-lg leading-none text-zinc-600 disabled:opacity-40"
          >
            ‹
          </button>
          <h2 className="text-lg font-bold text-zinc-900">Confirma tu pedido</h2>
          <button
            type="button"
            onClick={onClose}
            disabled={frozen}
            aria-label="Cerrar"
            className="flex h-9 w-9 items-center justify-center rounded-full bg-zinc-100 text-lg leading-none text-zinc-600 disabled:opacity-40"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto px-4 py-4">
          {/* Nombre */}
          <div>
            <label htmlFor={nameId} className="block text-sm font-semibold text-zinc-900">
              Tu nombre <span className="text-red-600">*</span>
            </label>
            <input
              id={nameId}
              type="text"
              value={fields.customer_name}
              onChange={(event) => onChange('customer_name', event.target.value)}
              disabled={frozen}
              maxLength={MAX_CUSTOMER_NAME_LENGTH}
              autoComplete="name"
              enterKeyHint="next"
              aria-invalid={errors.customer_name ? true : undefined}
              aria-describedby={errors.customer_name ? `${nameId}-error` : undefined}
              placeholder="¿Cómo te llamas?"
              className={`mt-1.5 w-full rounded-xl border px-4 py-3 text-base text-zinc-900 outline-none disabled:bg-zinc-50 disabled:text-zinc-500 ${
                errors.customer_name
                  ? 'border-red-400 focus:border-red-500'
                  : 'border-zinc-200 focus:border-lafija-green-dark'
              }`}
            />
            {errors.customer_name ? (
              <p id={`${nameId}-error`} role="alert" className="mt-1.5 text-sm text-red-600">
                {errors.customer_name}
              </p>
            ) : null}
          </div>

          {/* Tipo de entrega */}
          <div>
            <span id={deliveryId} className="block text-sm font-semibold text-zinc-900">
              ¿Cómo lo recibes? <span className="text-red-600">*</span>
            </span>
            <div
              role="radiogroup"
              aria-labelledby={deliveryId}
              aria-invalid={errors.delivery_type ? true : undefined}
              aria-describedby={errors.delivery_type ? `${deliveryId}-error` : undefined}
              className="mt-1.5 grid grid-cols-2 gap-2"
            >
              <DeliveryOption
                label="Envío"
                hint="A tu dirección"
                icon="🛵"
                value="delivery"
                active={isDelivery}
                disabled={frozen}
                onSelect={() => onChange('delivery_type', 'delivery')}
              />
              <DeliveryOption
                label="Recojo"
                hint="En el local"
                icon="🏠"
                value="pickup"
                active={fields.delivery_type === 'pickup'}
                disabled={frozen}
                onSelect={() => onChange('delivery_type', 'pickup')}
              />
            </div>
            {errors.delivery_type ? (
              <p id={`${deliveryId}-error`} role="alert" className="mt-1.5 text-sm text-red-600">
                {errors.delivery_type}
              </p>
            ) : null}
          </div>

          {/* Método de pago (6D.1) */}
          <div>
            <span id={paymentId} className="block text-sm font-semibold text-zinc-900">
              Método de pago <span className="text-red-600">*</span>
            </span>
            <div
              role="radiogroup"
              aria-labelledby={paymentId}
              aria-invalid={errors.payment_method ? true : undefined}
              aria-describedby={errors.payment_method ? `${paymentId}-error` : undefined}
              className="mt-1.5 grid grid-cols-2 gap-2"
            >
              <PaymentOption
                label="QR"
                hint="Escanea y paga"
                icon="📱"
                value="qr"
                active={fields.payment_method === 'qr'}
                disabled={frozen}
                onSelect={() => onChange('payment_method', 'qr')}
              />
              <PaymentOption
                label="Efectivo"
                hint="Pagas al recibir"
                icon="💵"
                value="cash"
                active={fields.payment_method === 'cash'}
                disabled={frozen}
                onSelect={() => onChange('payment_method', 'cash')}
              />
            </div>
            {errors.payment_method ? (
              <p id={`${paymentId}-error`} role="alert" className="mt-1.5 text-sm text-red-600">
                {errors.payment_method}
              </p>
            ) : null}
          </div>

          {/* Notas */}
          <div>
            <div className="flex items-baseline justify-between">
              <label htmlFor={notesId} className="text-sm font-semibold text-zinc-900">
                Notas <span className="font-normal text-zinc-400">(opcional)</span>
              </label>
              <span className="text-xs text-zinc-400 tabular-nums">
                {notesLength} / {MAX_NOTES_LENGTH}
              </span>
            </div>
            <textarea
              id={notesId}
              value={fields.notes}
              onChange={(event) => onChange('notes', event.target.value)}
              disabled={frozen}
              maxLength={MAX_NOTES_LENGTH}
              rows={2}
              aria-invalid={errors.notes ? true : undefined}
              aria-describedby={errors.notes ? `${notesId}-error` : undefined}
              placeholder="Sin cebolla, bien cocido…"
              className={`mt-1.5 w-full resize-none rounded-xl border px-4 py-3 text-base text-zinc-900 outline-none disabled:bg-zinc-50 disabled:text-zinc-500 ${
                errors.notes
                  ? 'border-red-400 focus:border-red-500'
                  : 'border-zinc-200 focus:border-lafija-green-dark'
              }`}
            />
            {errors.notes ? (
              <p id={`${notesId}-error`} role="alert" className="mt-1.5 text-sm text-red-600">
                {errors.notes}
              </p>
            ) : null}
          </div>

          {/* Resumen */}
          <div className="rounded-2xl bg-zinc-50 px-4 py-3">
            <p className="text-xs font-semibold tracking-wide text-zinc-500 uppercase">
              Tu pedido
            </p>
            <ul className="mt-2 space-y-1">
              {summary.lines.map((line) => (
                <li
                  key={line.product_code}
                  className="flex items-baseline justify-between gap-3 text-sm"
                >
                  <span className="min-w-0 truncate text-zinc-600">
                    {line.quantity} × {line.product_name_snapshot}
                  </span>
                  <span className="shrink-0 text-zinc-900 tabular-nums">
                    {formatMoney(line.subtotal)}
                  </span>
                </li>
              ))}
            </ul>
            {errors.items ? (
              <p role="alert" className="mt-2 text-sm text-red-600">
                {errors.items}
              </p>
            ) : null}
          </div>

        </div>

        {/* Totales + acción. El fallo se muestra aquí, en el pie fijo, para que
            nunca quede fuera de vista por el scroll del formulario. */}
        <div className="border-t border-zinc-100 px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))]">
          {failure ? (
            <p
              role="alert"
              className={`mb-3 rounded-xl px-3 py-2.5 text-sm leading-relaxed ${
                terminal ? 'bg-amber-50 text-amber-800' : 'bg-red-50 text-red-700'
              }`}
            >
              {failure.message}
            </p>
          ) : null}
          <div className="flex items-center justify-between text-sm text-zinc-500">
            <span>Subtotal</span>
            <span className="tabular-nums">{formatMoney(summary.subtotal)}</span>
          </div>
          {isDelivery ? (
            <div className="mt-0.5 flex items-center justify-between text-sm text-zinc-500">
              <span>Envío</span>
              <span>por confirmar</span>
            </div>
          ) : null}
          <div className="mt-1 flex items-center justify-between text-lg font-bold text-zinc-900">
            <span>Total</span>
            <span className="tabular-nums">{formatMoney(summary.total)}</span>
          </div>
          {isDelivery ? (
            <p className="mt-0.5 text-xs text-zinc-400">
              Total provisional: falta sumar el envío.
            </p>
          ) : null}

          {/* Exactamente una acción por situación. Nunca se muestra «Confirmar
              pedido» si el reducer fuese a ignorar el envío. */}
          {submitting ? (
            <button
              type="button"
              disabled
              aria-busy
              className="mt-3 flex w-full items-center justify-center gap-2 rounded-full bg-lafija-green-dark px-5 py-4 text-base font-semibold text-white opacity-60"
            >
              <Spinner />
              Enviando pedido…
            </button>
          ) : terminal ? (
            // 401 o 409: el enlace se agotó. Reintentar no puede ayudar.
            <button
              type="button"
              onClick={onClose}
              className="mt-3 w-full rounded-full bg-zinc-100 px-5 py-4 text-base font-semibold text-zinc-700 transition-colors hover:bg-zinc-200 active:bg-zinc-300"
            >
              Volver al menú
            </button>
          ) : showRetryOnly ? (
            <button
              type="button"
              onClick={onRetry}
              className="mt-3 w-full rounded-full bg-lafija-green-dark px-5 py-4 text-base font-semibold text-white transition-colors hover:bg-lafija-green-hover active:bg-lafija-green-active"
            >
              Reintentar pedido
            </button>
          ) : needsCartReview ? (
            // Un producto dejó de estar disponible: hay que revisar el carrito
            // antes de volver a enviar.
            <button
              type="button"
              onClick={onBackToCart}
              className="mt-3 w-full rounded-full bg-lafija-green-dark px-5 py-4 text-base font-semibold text-white transition-colors hover:bg-lafija-green-hover active:bg-lafija-green-active"
            >
              Revisar carrito
            </button>
          ) : canSubmit ? (
            <button
              type="button"
              onClick={onSubmit}
              className="mt-3 w-full rounded-full bg-lafija-green-dark px-5 py-4 text-base font-semibold text-white transition-colors hover:bg-lafija-green-hover active:bg-lafija-green-active"
            >
              Confirmar pedido
            </button>
          ) : (
            <button
              type="button"
              onClick={onClose}
              className="mt-3 w-full rounded-full bg-zinc-100 px-5 py-4 text-base font-semibold text-zinc-700 transition-colors hover:bg-zinc-200 active:bg-zinc-300"
            >
              Volver al menú
            </button>
          )}

          {showRetryOnly ? (
            <p className="mt-2 text-center text-xs leading-relaxed text-zinc-500">
              No cambies tu pedido: si ya se registró, al reintentar recuperamos el mismo.
            </p>
          ) : null}
        </div>
      </section>
    </div>
  );
}

/** Opción del selector de entrega. Botón, no radio nativo, por el diseño. */
function DeliveryOption({
  label,
  hint,
  icon,
  value,
  active,
  disabled,
  onSelect,
}: {
  label: string;
  hint: string;
  icon: string;
  value: DeliveryType;
  active: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      data-value={value}
      onClick={onSelect}
      disabled={disabled}
      className={`flex flex-col items-center gap-0.5 rounded-xl border px-3 py-3 transition-colors disabled:opacity-50 ${
        active
          ? 'border-lafija-green-dark bg-lafija-green-dark text-white'
          : 'border-zinc-200 bg-white text-zinc-700'
      }`}
    >
      <span className="text-xl leading-none" aria-hidden>
        {icon}
      </span>
      <span className="text-sm font-semibold">{label}</span>
      <span className={`text-xs ${active ? 'text-white/70' : 'text-zinc-400'}`}>{hint}</span>
    </button>
  );
}

/** Opción del selector de pago (6D.1). Mismo diseño que la de entrega. */
function PaymentOption({
  label,
  hint,
  icon,
  value,
  active,
  disabled,
  onSelect,
}: {
  label: string;
  hint: string;
  icon: string;
  value: PaymentMethod;
  active: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      data-value={value}
      onClick={onSelect}
      disabled={disabled}
      className={`flex flex-col items-center gap-0.5 rounded-xl border px-3 py-3 transition-colors disabled:opacity-50 ${
        active
          ? 'border-lafija-green-dark bg-lafija-green-dark text-white'
          : 'border-zinc-200 bg-white text-zinc-700'
      }`}
    >
      <span className="text-xl leading-none" aria-hidden>
        {icon}
      </span>
      <span className="text-sm font-semibold">{label}</span>
      <span className={`text-xs ${active ? 'text-white/70' : 'text-zinc-400'}`}>{hint}</span>
    </button>
  );
}

function Spinner() {
  return (
    <span
      aria-hidden
      className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white"
    />
  );
}
