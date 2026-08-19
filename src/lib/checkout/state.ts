import type { CheckoutFailure } from './errors';
import type { CheckoutFormErrors, CheckoutFormFields, NormalizedCheckout } from './form';
import { EMPTY_FORM_FIELDS } from './form';
import type { CheckoutOrder } from './client';

/**
 * Máquina de estados del checkout — reducer puro.
 *
 * Toda la lógica delicada vive aquí para poder probarla sin React ni red:
 * bloqueo del doble envío, fotografía inmutable del pedido enviado, reintento
 * exacto tras un resultado ambiguo, y bloqueo del enlace.
 *
 * La fotografía (`snapshot`) NO contiene el `session_token`. El token vive solo
 * en un prop del componente y se adjunta en el momento del `fetch`, de modo que
 * nunca entra en el estado de la aplicación.
 */

export type CheckoutStep = 'idle' | 'form' | 'submitting' | 'failed' | 'success';

/**
 * Por qué el enlace ya no sirve para confirmar un pedido.
 *
 * - `used`: el enlace ya tiene un pedido asociado (201, 200 idempotente o 409).
 * - `invalid`: el enlace no es válido o venció (401).
 *
 * Son situaciones distintas y el mensaje al usuario difiere, por eso no basta
 * un booleano. Solo vive en memoria: nunca en `localStorage` ni
 * `sessionStorage`, para que un enlace nuevo empiece limpio.
 */
export type SessionBlockReason = 'used' | 'invalid';

export interface CheckoutState {
  step: CheckoutStep;
  /** Valores actuales del formulario. Congelados mientras hay un envío en vuelo. */
  fields: CheckoutFormFields;
  /** Errores de la validación local o del 422 del servidor. */
  errors: CheckoutFormErrors;
  /**
   * Pedido exacto que se envió (o se está enviando). Es lo único que puede
   * reintentarse tras un resultado ambiguo. Nunca incluye el token.
   */
  snapshot: NormalizedCheckout | null;
  /** Fallo actual. Puede acompañar a `failed` y también a `form` (422 de campos). */
  failure: CheckoutFailure | null;
  /** Pedido creado o recuperado, si el paso es `success`. */
  order: CheckoutOrder | null;
  /** `true` si el pedido se creó ahora (201); `false` si ya existía (200). */
  created: boolean;
  /** `null` mientras el enlace siga sirviendo. Una vez puesto, no se revierte. */
  sessionBlockReason: SessionBlockReason | null;
}

export const INITIAL_CHECKOUT_STATE: CheckoutState = {
  step: 'idle',
  fields: EMPTY_FORM_FIELDS,
  errors: {},
  snapshot: null,
  failure: null,
  order: null,
  created: false,
  sessionBlockReason: null,
};

export type CheckoutAction =
  /** Abrir el formulario desde el carrito. */
  | { type: 'OPEN_FORM' }
  /** Cerrar el checkout y volver al catálogo. */
  | { type: 'CLOSE' }
  /** Editar un campo del formulario. */
  | { type: 'SET_FIELD'; field: keyof CheckoutFormFields; value: string | null }
  /** La validación local falló: no se envía nada. */
  | { type: 'VALIDATION_FAILED'; errors: CheckoutFormErrors }
  /** Empezar el envío con el pedido ya normalizado. */
  | { type: 'SUBMIT'; snapshot: NormalizedCheckout }
  /** Reintentar el mismo pedido tras un resultado ambiguo. */
  | { type: 'RETRY' }
  /** El servidor confirmó el pedido (201 o 200). */
  | { type: 'SUCCESS'; order: CheckoutOrder; created: boolean }
  /** El envío falló. */
  | { type: 'FAILURE'; failure: CheckoutFailure };

/**
 * Un envío está en vuelo. Es la guarda contra el doble toque: mientras sea
 * `true`, `SUBMIT` y `RETRY` no hacen nada.
 */
export function isSubmitting(state: CheckoutState): boolean {
  return state.step === 'submitting';
}

/** El enlace ya no sirve para confirmar ningún pedido más. */
export function isSessionBlocked(state: CheckoutState): boolean {
  return state.sessionBlockReason !== null;
}

/**
 * El checkout puede abrirse: hay sesión utilizable y no hay envío en curso.
 * `sessionBlockReason` lo bloquea de forma definitiva.
 */
export function canOpenCheckout(state: CheckoutState, hasSession: boolean): boolean {
  return hasSession && !isSessionBlocked(state) && state.step === 'idle';
}

/**
 * El formulario y el carrito están congelados: hay un envío en vuelo o el
 * resultado fue ambiguo y solo cabe reintentar el pedido idéntico.
 */
export function isFrozen(state: CheckoutState): boolean {
  if (state.step === 'submitting') return true;
  return state.step === 'failed' && state.failure?.ambiguous === true;
}

/** Hay un reintento exacto disponible. */
export function canRetry(state: CheckoutState): boolean {
  return (
    state.step === 'failed' &&
    state.failure?.recovery === 'retry_same' &&
    state.snapshot !== null
  );
}

/**
 * El envío normal está permitido. La UI solo debe mostrar «Confirmar pedido»
 * cuando esto sea `true`: así no existe un botón que aparente enviar mientras
 * el reducer ignora la transición.
 */
export function canSubmit(state: CheckoutState): boolean {
  return state.step === 'form' && !isSessionBlocked(state);
}

/** Traduce un fallo al motivo de bloqueo del enlace, si lo hay. */
function blockReasonFor(failure: CheckoutFailure): SessionBlockReason | null {
  if (failure.kind === 'session_already_used') return 'used';
  if (failure.kind === 'invalid_session') return 'invalid';
  return null;
}

export function checkoutReducer(state: CheckoutState, action: CheckoutAction): CheckoutState {
  switch (action.type) {
    case 'OPEN_FORM': {
      // Un enlace bloqueado no vuelve a abrir el checkout.
      if (isSessionBlocked(state)) return state;
      if (state.step !== 'idle') return state;
      return { ...state, step: 'form', errors: {}, failure: null };
    }

    case 'CLOSE': {
      // Nunca se cierra con un envío en vuelo.
      if (state.step === 'submitting') return state;

      if (state.step === 'success') {
        // Volver al catálogo tras el éxito: se conserva el bloqueo del enlace.
        return {
          ...INITIAL_CHECKOUT_STATE,
          sessionBlockReason: state.sessionBlockReason,
        };
      }

      // Tras un fallo ambiguo no se puede abandonar sin más: el pedido pudo
      // haberse creado, así que se conserva la fotografía para reintentar.
      if (isFrozen(state)) return state;

      // `sessionBlockReason` se conserva por el spread: cerrar la pantalla de un
      // 401 o un 409 no vuelve a habilitar el checkout.
      return { ...state, step: 'idle', errors: {}, failure: null };
    }

    case 'SET_FIELD': {
      // Los campos se congelan durante el envío y tras un fallo ambiguo.
      if (isFrozen(state)) return state;
      if (isSessionBlocked(state)) return state;
      if (state.step !== 'form') return state;

      const fields: CheckoutFormFields = { ...state.fields, [action.field]: action.value ?? '' };
      if (action.field === 'delivery_type') {
        fields.delivery_type =
          action.value === 'delivery' || action.value === 'pickup' ? action.value : null;
      }
      if (action.field === 'payment_method') {
        fields.payment_method =
          action.value === 'cash' || action.value === 'qr' ? action.value : null;
      }

      // Editar limpia el error de ese campo: el usuario ya está corrigiendo.
      const errors = { ...state.errors };
      delete errors[action.field];

      return { ...state, fields, errors, failure: null };
    }

    case 'VALIDATION_FAILED': {
      if (isFrozen(state)) return state;
      if (state.step !== 'form') return state;
      return { ...state, errors: action.errors };
    }

    case 'SUBMIT': {
      // Guardas: doble envío, enlace bloqueado y envío desde un paso que no es
      // el formulario (por ejemplo, desde `failed`).
      if (isSubmitting(state)) return state;
      if (!canSubmit(state)) return state;

      return {
        ...state,
        step: 'submitting',
        errors: {},
        failure: null,
        // La fotografía se congela aquí y no vuelve a tocarse hasta un SUBMIT nuevo.
        snapshot: action.snapshot,
      };
    }

    case 'RETRY': {
      if (isSubmitting(state)) return state;
      if (!canRetry(state)) return state;

      // Reenvía exactamente la misma fotografía: si el pedido ya existía, el
      // fingerprint coincide y el backend responde 200 con `created: false`.
      return { ...state, step: 'submitting', failure: null };
    }

    case 'SUCCESS': {
      return {
        ...state,
        step: 'success',
        errors: {},
        failure: null,
        order: action.order,
        created: action.created,
        // 201 y 200 agotan el enlace por igual.
        sessionBlockReason: 'used',
      };
    }

    case 'FAILURE': {
      const { failure } = action;
      // Una vez bloqueado, el motivo no cambia.
      const sessionBlockReason = state.sessionBlockReason ?? blockReasonFor(failure);

      // Un 422 de campos vuelve directamente al formulario con sus errores: no
      // es un callejón sin salida, el usuario corrige y reenvía.
      if (failure.recovery === 'fix_form') {
        return {
          ...state,
          step: 'form',
          failure,
          sessionBlockReason,
          errors: failure.issues ? mapIssuesToErrors(failure.issues) : state.errors,
        };
      }

      return { ...state, step: 'failed', failure, sessionBlockReason };
    }

    default:
      return state;
  }
}

/** Traduce los `issues` del 422 a errores por campo del formulario. */
function mapIssuesToErrors(
  issues: ReadonlyArray<{ field: string; message: string }>,
): CheckoutFormErrors {
  const errors: CheckoutFormErrors = {};
  for (const issue of issues) {
    if (issue.field === 'customer_name' && !errors.customer_name) {
      errors.customer_name = issue.message;
    } else if (issue.field === 'delivery_type' && !errors.delivery_type) {
      errors.delivery_type = issue.message;
    } else if (issue.field === 'payment_method' && !errors.payment_method) {
      errors.payment_method = issue.message;
    } else if (issue.field === 'notes' && !errors.notes) {
      errors.notes = issue.message;
    } else if (issue.field.startsWith('items') && !errors.items) {
      errors.items = issue.message;
    }
  }
  return errors;
}
