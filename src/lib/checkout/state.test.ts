import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  INITIAL_CHECKOUT_STATE,
  canOpenCheckout,
  canRetry,
  canSubmit,
  checkoutReducer,
  isFrozen,
  isSessionBlocked,
  isSubmitting,
  type CheckoutState,
} from './state';
import {
  mapCheckoutFailure,
  networkFailure,
  timeoutFailure,
  unreadableResponseFailure,
} from './errors';
import type { NormalizedCheckout } from './form';
import type { CheckoutOrder } from './client';

const SNAPSHOT: NormalizedCheckout = {
  customer_name: 'Juan García',
  delivery_type: 'delivery',
  payment_method: 'cash',
  notes: 'Sin cebolla',
  items: [{ code: 'la_fija', quantity: 1 }],
};

const OTHER_SNAPSHOT: NormalizedCheckout = {
  customer_name: 'Ana Rojas',
  delivery_type: 'pickup',
  payment_method: 'qr',
  notes: null,
  items: [{ code: 'gaseosa_2l', quantity: 3 }],
};

const ORDER: CheckoutOrder = {
  id: '22222222-2222-4222-8222-222222222222',
  order_number: 'ORD-000123',
  customer_name: 'Juan García',
  delivery_type: 'delivery',
  status: 'awaiting_location',
  subtotal_amount: 40,
  delivery_amount: 0,
  total_amount: 40,
  created_at: '2026-07-20T14:30:00.000Z',
};

/** Aplica una secuencia de acciones desde el estado inicial. */
function run(...actions: Parameters<typeof checkoutReducer>[1][]): CheckoutState {
  return actions.reduce(checkoutReducer, INITIAL_CHECKOUT_STATE);
}

/** Estado justo antes de enviar, con el formulario relleno. */
function readyToSubmit(): CheckoutState {
  return run(
    { type: 'OPEN_FORM' },
    { type: 'SET_FIELD', field: 'customer_name', value: 'Juan García' },
    { type: 'SET_FIELD', field: 'delivery_type', value: 'delivery' },
  );
}

/** Estado tras enviar y recibir el fallo indicado. */
function afterFailure(failure: Parameters<typeof checkoutReducer>[1] extends never ? never : ReturnType<typeof networkFailure>): CheckoutState {
  return checkoutReducer(
    checkoutReducer(readyToSubmit(), { type: 'SUBMIT', snapshot: SNAPSHOT }),
    { type: 'FAILURE', failure },
  );
}

describe('estado inicial', () => {
  it('empieza en idle sin bloqueo de sesión', () => {
    expect(INITIAL_CHECKOUT_STATE.step).toBe('idle');
    expect(INITIAL_CHECKOUT_STATE.sessionBlockReason).toBeNull();
    expect(INITIAL_CHECKOUT_STATE.snapshot).toBeNull();
    expect(isSessionBlocked(INITIAL_CHECKOUT_STATE)).toBe(false);
  });

  it('el estado inicial no contiene ningún token', () => {
    expect(JSON.stringify(INITIAL_CHECKOUT_STATE)).not.toContain('token');
  });
});

describe('apertura del formulario', () => {
  it('OPEN_FORM pasa a form', () => {
    expect(run({ type: 'OPEN_FORM' }).step).toBe('form');
  });

  it('canOpenCheckout requiere sesión', () => {
    expect(canOpenCheckout(INITIAL_CHECKOUT_STATE, false)).toBe(false);
    expect(canOpenCheckout(INITIAL_CHECKOUT_STATE, true)).toBe(true);
  });
});

describe('edición de campos', () => {
  it('SET_FIELD actualiza el valor', () => {
    const state = run(
      { type: 'OPEN_FORM' },
      { type: 'SET_FIELD', field: 'customer_name', value: 'Ana' },
    );
    expect(state.fields.customer_name).toBe('Ana');
  });

  it('delivery_type solo acepta valores del enum', () => {
    const valido = run(
      { type: 'OPEN_FORM' },
      { type: 'SET_FIELD', field: 'delivery_type', value: 'pickup' },
    );
    expect(valido.fields.delivery_type).toBe('pickup');

    const invalido = checkoutReducer(valido, {
      type: 'SET_FIELD',
      field: 'delivery_type',
      value: 'express',
    });
    expect(invalido.fields.delivery_type).toBeNull();
  });

  it('editar un campo limpia su error', () => {
    const conError = run(
      { type: 'OPEN_FORM' },
      { type: 'VALIDATION_FAILED', errors: { customer_name: 'Falta el nombre.' } },
    );
    expect(conError.errors.customer_name).toBeTruthy();

    const editado = checkoutReducer(conError, {
      type: 'SET_FIELD',
      field: 'customer_name',
      value: 'Ana',
    });
    expect(editado.errors.customer_name).toBeUndefined();
  });
});

describe('envío y bloqueo del doble toque', () => {
  it('SUBMIT pasa a submitting y guarda la fotografía', () => {
    const state = checkoutReducer(readyToSubmit(), { type: 'SUBMIT', snapshot: SNAPSHOT });
    expect(state.step).toBe('submitting');
    expect(state.snapshot).toEqual(SNAPSHOT);
    expect(isSubmitting(state)).toBe(true);
  });

  it('un segundo SUBMIT durante el envío no hace nada', () => {
    const enVuelo = checkoutReducer(readyToSubmit(), { type: 'SUBMIT', snapshot: SNAPSHOT });
    const doble = checkoutReducer(enVuelo, { type: 'SUBMIT', snapshot: OTHER_SNAPSHOT });

    expect(doble).toBe(enVuelo);
    expect(doble.snapshot).toEqual(SNAPSHOT);
  });

  it('no se puede cerrar durante el envío', () => {
    const enVuelo = checkoutReducer(readyToSubmit(), { type: 'SUBMIT', snapshot: SNAPSHOT });
    expect(checkoutReducer(enVuelo, { type: 'CLOSE' })).toBe(enVuelo);
  });

  it('no se pueden editar campos durante el envío', () => {
    const enVuelo = checkoutReducer(readyToSubmit(), { type: 'SUBMIT', snapshot: SNAPSHOT });
    const intento = checkoutReducer(enVuelo, {
      type: 'SET_FIELD',
      field: 'customer_name',
      value: 'Otro',
    });
    expect(intento).toBe(enVuelo);
  });

  it('la fotografía no contiene el token', () => {
    const state = checkoutReducer(readyToSubmit(), { type: 'SUBMIT', snapshot: SNAPSHOT });
    expect(Object.keys(state.snapshot!).sort()).toEqual([
      'customer_name',
      'delivery_type',
      'items',
      'notes',
      'payment_method',
    ]);
    expect(JSON.stringify(state.snapshot)).not.toContain('session_token');
  });
});

describe('canSubmit — el envío normal solo procede desde form', () => {
  it('es true en form', () => {
    expect(canSubmit(readyToSubmit())).toBe(true);
  });

  it('es false en idle', () => {
    expect(canSubmit(INITIAL_CHECKOUT_STATE)).toBe(false);
  });

  it('es false mientras se envía', () => {
    const enVuelo = checkoutReducer(readyToSubmit(), { type: 'SUBMIT', snapshot: SNAPSHOT });
    expect(canSubmit(enVuelo)).toBe(false);
  });

  it('es false en failed (ambiguo)', () => {
    expect(canSubmit(afterFailure(networkFailure()))).toBe(false);
  });

  it('es false en failed (product_unavailable)', () => {
    const state = afterFailure(mapCheckoutFailure(422, { error: 'product_unavailable' }));
    expect(state.step).toBe('failed');
    expect(canSubmit(state)).toBe(false);
  });

  it('es false con la sesión bloqueada aunque el paso sea form', () => {
    const bloqueado: CheckoutState = {
      ...readyToSubmit(),
      sessionBlockReason: 'invalid',
    };
    expect(bloqueado.step).toBe('form');
    expect(canSubmit(bloqueado)).toBe(false);
  });

  it('SUBMIT desde failed no hace nada', () => {
    const failed = afterFailure(mapCheckoutFailure(422, { error: 'product_unavailable' }));
    expect(checkoutReducer(failed, { type: 'SUBMIT', snapshot: SNAPSHOT })).toBe(failed);
  });

  it('SUBMIT desde idle no hace nada', () => {
    expect(checkoutReducer(INITIAL_CHECKOUT_STATE, { type: 'SUBMIT', snapshot: SNAPSHOT })).toBe(
      INITIAL_CHECKOUT_STATE,
    );
  });

  it('SUBMIT con la sesión bloqueada no hace nada', () => {
    const bloqueado: CheckoutState = { ...readyToSubmit(), sessionBlockReason: 'used' };
    expect(checkoutReducer(bloqueado, { type: 'SUBMIT', snapshot: SNAPSHOT })).toBe(bloqueado);
  });
});

describe('éxito', () => {
  it('201 pasa a success y bloquea el enlace como "used"', () => {
    const enVuelo = checkoutReducer(readyToSubmit(), { type: 'SUBMIT', snapshot: SNAPSHOT });
    const state = checkoutReducer(enVuelo, { type: 'SUCCESS', order: ORDER, created: true });

    expect(state.step).toBe('success');
    expect(state.created).toBe(true);
    expect(state.order?.order_number).toBe('ORD-000123');
    expect(state.sessionBlockReason).toBe('used');
  });

  it('200 idempotente también bloquea como "used"', () => {
    const enVuelo = checkoutReducer(readyToSubmit(), { type: 'SUBMIT', snapshot: SNAPSHOT });
    const state = checkoutReducer(enVuelo, { type: 'SUCCESS', order: ORDER, created: false });

    expect(state.step).toBe('success');
    expect(state.created).toBe(false);
    expect(state.sessionBlockReason).toBe('used');
  });

  it('CLOSE desde success vuelve a idle conservando el bloqueo', () => {
    const enVuelo = checkoutReducer(readyToSubmit(), { type: 'SUBMIT', snapshot: SNAPSHOT });
    const exito = checkoutReducer(enVuelo, { type: 'SUCCESS', order: ORDER, created: true });
    const state = checkoutReducer(exito, { type: 'CLOSE' });

    expect(state.step).toBe('idle');
    expect(state.sessionBlockReason).toBe('used');
    expect(state.order).toBeNull();
    expect(state.snapshot).toBeNull();
    expect(canOpenCheckout(state, true)).toBe(false);
  });
});

describe('401 invalid_session — bloqueo "invalid"', () => {
  const failure = mapCheckoutFailure(401, { error: 'invalid_session' });

  it('bloquea el enlace con motivo "invalid"', () => {
    const state = afterFailure(failure);
    expect(state.step).toBe('failed');
    expect(state.sessionBlockReason).toBe('invalid');
    expect(isSessionBlocked(state)).toBe(true);
  });

  it('no permite reintentar', () => {
    expect(canRetry(afterFailure(failure))).toBe(false);
  });

  it('cerrar la pantalla NO vuelve a habilitar el checkout', () => {
    const cerrado = checkoutReducer(afterFailure(failure), { type: 'CLOSE' });

    expect(cerrado.step).toBe('idle');
    expect(cerrado.sessionBlockReason).toBe('invalid');
    expect(canOpenCheckout(cerrado, true)).toBe(false);
    expect(canSubmit(cerrado)).toBe(false);
  });

  it('OPEN_FORM tras cerrar sigue bloqueado', () => {
    const cerrado = checkoutReducer(afterFailure(failure), { type: 'CLOSE' });
    expect(checkoutReducer(cerrado, { type: 'OPEN_FORM' })).toBe(cerrado);
  });

  it('el mensaje es el de enlace inválido, no el de utilizado', () => {
    const state = afterFailure(failure);
    expect(state.failure?.message).toContain('ya no es válido');
    expect(state.failure?.message).not.toContain('ya fue utilizado');
  });
});

describe('409 session_already_used — bloqueo "used"', () => {
  const failure = mapCheckoutFailure(409, { error: 'session_already_used' });

  it('bloquea el enlace con motivo "used"', () => {
    const state = afterFailure(failure);
    expect(state.step).toBe('failed');
    expect(state.sessionBlockReason).toBe('used');
  });

  it('no permite reintentar ni abrir de nuevo', () => {
    const state = afterFailure(failure);
    expect(canRetry(state)).toBe(false);
    expect(canOpenCheckout(state, true)).toBe(false);
  });

  it('cerrar la pantalla conserva el bloqueo', () => {
    const cerrado = checkoutReducer(afterFailure(failure), { type: 'CLOSE' });
    expect(cerrado.sessionBlockReason).toBe('used');
    expect(canSubmit(cerrado)).toBe(false);
  });

  it('el mensaje es el de enlace utilizado', () => {
    expect(afterFailure(failure).failure?.message).toContain('ya fue utilizado');
  });
});

describe('validation_error — vuelve al formulario', () => {
  const failure = mapCheckoutFailure(422, {
    error: 'validation_error',
    issues: [{ field: 'customer_name', message: 'El nombre es obligatorio.' }],
  });

  it('regresa al paso form', () => {
    const state = afterFailure(failure);
    expect(state.step).toBe('form');
  });

  it('traslada los errores por campo', () => {
    expect(afterFailure(failure).errors.customer_name).toBe('El nombre es obligatorio.');
  });

  it('permite volver a enviar', () => {
    const state = afterFailure(failure);
    expect(canSubmit(state)).toBe(true);
    expect(isFrozen(state)).toBe(false);
  });

  it('no bloquea el enlace', () => {
    expect(afterFailure(failure).sessionBlockReason).toBeNull();
  });

  it('issues de items se mapean al error del carrito', () => {
    const state = afterFailure(
      mapCheckoutFailure(422, {
        error: 'validation_error',
        issues: [{ field: 'items.0.quantity', message: 'La cantidad máxima es 10.' }],
      }),
    );
    expect(state.errors.items).toBe('La cantidad máxima es 10.');
  });
});

describe('product_unavailable — hay que revisar el carrito', () => {
  const failure = mapCheckoutFailure(422, { error: 'product_unavailable' });

  it('queda en failed con recuperación fix_cart', () => {
    const state = afterFailure(failure);
    expect(state.step).toBe('failed');
    expect(state.failure?.recovery).toBe('fix_cart');
  });

  it('no congela el checkout', () => {
    expect(isFrozen(afterFailure(failure))).toBe(false);
  });

  it('no ofrece reintento exacto', () => {
    expect(canRetry(afterFailure(failure))).toBe(false);
  });

  it('no permite enviar de nuevo sin pasar por el carrito', () => {
    const state = afterFailure(failure);
    expect(canSubmit(state)).toBe(false);
    expect(checkoutReducer(state, { type: 'SUBMIT', snapshot: SNAPSHOT })).toBe(state);
  });

  it('CLOSE devuelve a idle para revisar el carrito', () => {
    const state = checkoutReducer(afterFailure(failure), { type: 'CLOSE' });
    expect(state.step).toBe('idle');
    expect(state.sessionBlockReason).toBeNull();
  });

  it('tras cerrar y reabrir se puede enviar de nuevo', () => {
    const cerrado = checkoutReducer(afterFailure(failure), { type: 'CLOSE' });
    const reabierto = checkoutReducer(cerrado, { type: 'OPEN_FORM' });
    expect(reabierto.step).toBe('form');
    expect(canSubmit(reabierto)).toBe(true);
  });

  it('no bloquea el enlace', () => {
    expect(afterFailure(failure).sessionBlockReason).toBeNull();
  });
});

describe('resultados ambiguos y reintento exacto', () => {
  const ambiguos = [
    ['red', networkFailure()],
    ['timeout', timeoutFailure()],
    ['respuesta ilegible', unreadableResponseFailure()],
    ['500', mapCheckoutFailure(500, { error: 'internal_error' })],
    ['400', mapCheckoutFailure(400, { error: 'invalid_json' })],
  ] as const;

  for (const [nombre, failure] of ambiguos) {
    describe(`tras ${nombre}`, () => {
      const state = afterFailure(failure);

      it('congela el checkout', () => {
        expect(isFrozen(state)).toBe(true);
      });

      it('permite reintentar', () => {
        expect(canRetry(state)).toBe(true);
      });

      it('no permite el envío normal', () => {
        expect(canSubmit(state)).toBe(false);
      });

      it('no permite editar el nombre', () => {
        expect(
          checkoutReducer(state, { type: 'SET_FIELD', field: 'customer_name', value: 'Otro' }),
        ).toBe(state);
      });

      it('no permite cambiar el tipo de entrega', () => {
        expect(
          checkoutReducer(state, { type: 'SET_FIELD', field: 'delivery_type', value: 'pickup' }),
        ).toBe(state);
      });

      it('no permite cambiar las notas', () => {
        expect(
          checkoutReducer(state, { type: 'SET_FIELD', field: 'notes', value: 'otra cosa' }),
        ).toBe(state);
      });

      it('no permite cerrar', () => {
        expect(checkoutReducer(state, { type: 'CLOSE' })).toBe(state);
      });

      it('no bloquea el enlace', () => {
        expect(state.sessionBlockReason).toBeNull();
      });

      it('RETRY reenvía exactamente la misma fotografía', () => {
        const retry = checkoutReducer(state, { type: 'RETRY' });
        expect(retry.step).toBe('submitting');
        expect(retry.snapshot).toEqual(SNAPSHOT);
        expect(retry.failure).toBeNull();
      });
    });
  }

  it('el reintento conserva la fotografía aunque cambie el carrito real', () => {
    const failed = afterFailure(networkFailure());
    const retry = checkoutReducer(failed, { type: 'RETRY' });

    expect(retry.snapshot).toEqual(SNAPSHOT);
    expect(retry.snapshot).not.toEqual(OTHER_SNAPSHOT);
  });

  it('RETRY durante un envío en vuelo no hace nada', () => {
    const enVuelo = checkoutReducer(readyToSubmit(), { type: 'SUBMIT', snapshot: SNAPSHOT });
    expect(checkoutReducer(enVuelo, { type: 'RETRY' })).toBe(enVuelo);
  });

  it('RETRY sin fallo previo no hace nada', () => {
    expect(checkoutReducer(INITIAL_CHECKOUT_STATE, { type: 'RETRY' })).toBe(
      INITIAL_CHECKOUT_STATE,
    );
  });

  it('RETRY tras product_unavailable no hace nada', () => {
    const failed = afterFailure(mapCheckoutFailure(422, { error: 'product_unavailable' }));
    expect(checkoutReducer(failed, { type: 'RETRY' })).toBe(failed);
  });

  it('un reintento ambiguo que acaba en éxito bloquea como "used"', () => {
    const retry = checkoutReducer(afterFailure(timeoutFailure()), { type: 'RETRY' });
    const success = checkoutReducer(retry, { type: 'SUCCESS', order: ORDER, created: false });

    expect(success.step).toBe('success');
    expect(success.created).toBe(false);
    expect(success.sessionBlockReason).toBe('used');
  });

  it('un reintento ambiguo que acaba en 409 bloquea como "used"', () => {
    const retry = checkoutReducer(afterFailure(networkFailure()), { type: 'RETRY' });
    const conflict = checkoutReducer(retry, {
      type: 'FAILURE',
      failure: mapCheckoutFailure(409, { error: 'session_already_used' }),
    });

    expect(conflict.sessionBlockReason).toBe('used');
    expect(canRetry(conflict)).toBe(false);
  });

  it('un reintento ambiguo que acaba en 401 bloquea como "invalid"', () => {
    const retry = checkoutReducer(afterFailure(networkFailure()), { type: 'RETRY' });
    const invalid = checkoutReducer(retry, {
      type: 'FAILURE',
      failure: mapCheckoutFailure(401, { error: 'invalid_session' }),
    });

    expect(invalid.sessionBlockReason).toBe('invalid');
  });
});

describe('el motivo de bloqueo no se sobrescribe', () => {
  it('un 401 posterior no cambia un bloqueo "used" previo', () => {
    const usado = afterFailure(mapCheckoutFailure(409, { error: 'session_already_used' }));
    expect(usado.sessionBlockReason).toBe('used');

    const despues = checkoutReducer(usado, {
      type: 'FAILURE',
      failure: mapCheckoutFailure(401, { error: 'invalid_session' }),
    });
    expect(despues.sessionBlockReason).toBe('used');
  });
});

describe('pureza del reducer', () => {
  it('no muta el estado recibido', () => {
    const before = readyToSubmit();
    const copy = JSON.parse(JSON.stringify(before));
    checkoutReducer(before, { type: 'SUBMIT', snapshot: SNAPSHOT });
    expect(JSON.parse(JSON.stringify(before))).toEqual(copy);
  });

  it('una acción desconocida devuelve el mismo estado', () => {
    const state = readyToSubmit();
    expect(checkoutReducer(state, { type: 'NOPE' } as never)).toBe(state);
  });
});

describe('MenuStore respeta las guardas', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../../components/menu/MenuStore.tsx', import.meta.url)),
    'utf8',
  );

  it('handleSubmit comprueba canSubmit antes de llamar a send', () => {
    const handleSubmit = source.slice(
      source.indexOf('const handleSubmit'),
      source.indexOf('const handleRetry'),
    );
    expect(handleSubmit).toMatch(/canSubmitState\(checkout\)/);
    // La guarda va antes del envío.
    expect(handleSubmit.indexOf('canSubmitState')).toBeLessThan(handleSubmit.indexOf('send('));
  });

  it('handleRetry solo envía la fotografía guardada', () => {
    const handleRetry = source.slice(
      source.indexOf('const handleRetry'),
      source.indexOf('const handleFieldChange'),
    );
    expect(handleRetry).toMatch(/checkout\.snapshot/);
    expect(handleRetry).not.toMatch(/cartItems|validateCheckoutForm/);
  });

  it('cart.clear() aparece una sola vez y dentro de la rama de éxito', () => {
    expect(source.match(/cart\.clear\(\)/g)).toHaveLength(1);
    const send = source.slice(source.indexOf('const send'), source.indexOf('const handleSubmit'));
    expect(send.indexOf('if (result.ok)')).toBeLessThan(send.indexOf('cart.clear()'));
  });

  it('canCheckout depende de isSessionBlocked', () => {
    expect(source).toMatch(/canCheckout\s*=\s*hasSession\s*&&\s*!isSessionBlocked\(checkout\)/);
  });

  it('los dos mensajes de bloqueo están diferenciados', () => {
    expect(source).toMatch(/sessionBlockReason === 'used'/);
    expect(source).toMatch(/sessionBlockReason === 'invalid'/);
  });
});
