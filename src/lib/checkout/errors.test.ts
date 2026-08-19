import { describe, it, expect } from 'vitest';
import {
  mapCheckoutFailure,
  networkFailure,
  timeoutFailure,
  unreadableResponseFailure,
} from './errors';

describe('mapCheckoutFailure — errores terminales', () => {
  it('401 invalid_session es terminal', () => {
    const failure = mapCheckoutFailure(401, {
      error: 'invalid_session',
      message: 'Este enlace ya no es válido. Vuelve a WhatsApp y solicita nuevamente el menú.',
    });
    expect(failure.kind).toBe('invalid_session');
    expect(failure.recovery).toBe('none');
    expect(failure.ambiguous).toBe(false);
    expect(failure.message).toContain('WhatsApp');
  });

  it('409 session_already_used es terminal', () => {
    const failure = mapCheckoutFailure(409, {
      error: 'session_already_used',
      message: 'Este enlace ya fue utilizado. Vuelve a WhatsApp para solicitar un nuevo enlace.',
    });
    expect(failure.kind).toBe('session_already_used');
    expect(failure.recovery).toBe('none');
    expect(failure.ambiguous).toBe(false);
  });

  it('401 sin body usa el mensaje por defecto', () => {
    const failure = mapCheckoutFailure(401, null);
    expect(failure.kind).toBe('invalid_session');
    expect(failure.recovery).toBe('none');
    expect(failure.message).toBeTruthy();
  });
});

describe('mapCheckoutFailure — recuperables', () => {
  it('422 validation_error permite corregir el formulario', () => {
    const failure = mapCheckoutFailure(422, {
      error: 'validation_error',
      message: 'El nombre es obligatorio.',
      issues: [{ field: 'customer_name', message: 'El nombre es obligatorio.' }],
    });
    expect(failure.kind).toBe('validation_error');
    expect(failure.recovery).toBe('fix_form');
    expect(failure.ambiguous).toBe(false);
    expect(failure.issues).toEqual([
      { field: 'customer_name', message: 'El nombre es obligatorio.' },
    ]);
  });

  it('422 product_unavailable permite volver al carrito', () => {
    const failure = mapCheckoutFailure(422, {
      error: 'product_unavailable',
      message: 'Uno de los productos ya no está disponible. Revisa tu pedido.',
    });
    expect(failure.kind).toBe('product_unavailable');
    expect(failure.recovery).toBe('fix_cart');
    expect(failure.ambiguous).toBe(false);
  });

  it('422 sin código conocido cae en validation_error', () => {
    const failure = mapCheckoutFailure(422, { error: 'algo_raro' });
    expect(failure.kind).toBe('validation_error');
    expect(failure.recovery).toBe('fix_form');
  });
});

describe('mapCheckoutFailure — resultados ambiguos', () => {
  it('400 invalid_json es ambiguo', () => {
    const failure = mapCheckoutFailure(400, { error: 'invalid_json' });
    expect(failure.kind).toBe('invalid_json');
    expect(failure.recovery).toBe('retry_same');
    expect(failure.ambiguous).toBe(true);
  });

  it('500 internal_error es ambiguo', () => {
    const failure = mapCheckoutFailure(500, { error: 'internal_error' });
    expect(failure.kind).toBe('internal_error');
    expect(failure.recovery).toBe('retry_same');
    expect(failure.ambiguous).toBe(true);
  });

  it('502 también es ambiguo', () => {
    const failure = mapCheckoutFailure(502, null);
    expect(failure.recovery).toBe('retry_same');
    expect(failure.ambiguous).toBe(true);
  });

  it('un status desconocido es ambiguo', () => {
    const failure = mapCheckoutFailure(418, null);
    expect(failure.kind).toBe('unknown_error');
    expect(failure.recovery).toBe('retry_same');
    expect(failure.ambiguous).toBe(true);
  });

  it('error de red es ambiguo', () => {
    const failure = networkFailure();
    expect(failure.kind).toBe('network_error');
    expect(failure.recovery).toBe('retry_same');
    expect(failure.ambiguous).toBe(true);
  });

  it('timeout es ambiguo', () => {
    const failure = timeoutFailure();
    expect(failure.kind).toBe('timeout');
    expect(failure.recovery).toBe('retry_same');
    expect(failure.ambiguous).toBe(true);
  });

  it('respuesta no interpretable es ambigua', () => {
    const failure = unreadableResponseFailure();
    expect(failure.kind).toBe('unreadable_response');
    expect(failure.recovery).toBe('retry_same');
    expect(failure.ambiguous).toBe(true);
  });
});

describe('mapCheckoutFailure — saneamiento de mensajes', () => {
  it('descarta un mensaje que no es string', () => {
    const failure = mapCheckoutFailure(500, { error: 'internal_error', message: { sql: '42P01' } });
    expect(typeof failure.message).toBe('string');
    expect(failure.message).not.toContain('42P01');
  });

  it('descarta un mensaje vacío', () => {
    const failure = mapCheckoutFailure(500, { error: 'internal_error', message: '   ' });
    expect(failure.message.trim()).not.toBe('');
  });

  it('descarta un mensaje excesivamente largo (posible volcado)', () => {
    const dump = 'x'.repeat(5000);
    const failure = mapCheckoutFailure(500, { error: 'internal_error', message: dump });
    expect(failure.message).not.toBe(dump);
    expect(failure.message.length).toBeLessThan(200);
  });

  it('nunca expone SQLSTATE ni stack traces', () => {
    const failure = mapCheckoutFailure(500, {
      error: 'internal_error',
      message: 'P0001: relation "public.orders" does not exist\n  at Object.<anonymous>',
      sqlstate: 'P0001',
      stack: 'Error: boom\n at foo',
    });
    const serialized = JSON.stringify(failure);
    expect(serialized).not.toContain('P0001');
    expect(serialized).not.toContain('public.orders');
    expect(serialized).not.toContain('at Object');
  });

  it('descarta issues malformados', () => {
    const failure = mapCheckoutFailure(422, {
      error: 'validation_error',
      issues: [
        { field: 'customer_name', message: 'ok' },
        { field: 123, message: 'no' },
        'basura',
        null,
        { field: 'notes' },
      ],
    });
    expect(failure.issues).toEqual([{ field: 'customer_name', message: 'ok' }]);
  });

  it('issues no-array se ignora', () => {
    const failure = mapCheckoutFailure(422, { error: 'validation_error', issues: 'nope' });
    expect(failure.issues).toBeUndefined();
  });

  it('un body que no es objeto no rompe el mapeo', () => {
    expect(mapCheckoutFailure(500, 'texto plano').kind).toBe('internal_error');
    expect(mapCheckoutFailure(422, null).kind).toBe('validation_error');
    expect(mapCheckoutFailure(409, []).kind).toBe('session_already_used');
  });
});
