import { describe, it, expect } from 'vitest';
import { isAbandonedCart, UNQUOTED_CART_WINDOW_MS } from './abandoned-cart';
import { openedAtMsOf } from './opened-at';
import type { OrderStatus } from '@/types';

const AHORA = Date.parse('2026-09-09T04:00:00.000Z');
const hace = (ms: number) => new Date(AHORA - ms).toISOString();

/** Un carrito recién nacido, esperando la ubicación de su cliente. */
const carrito = (over: Partial<Parameters<typeof isAbandonedCart>[0]> = {}) =>
  isAbandonedCart({
    status: 'awaiting_location',
    deliveryQuoteStatus: 'pending',
    confirmedAt: null,
    createdAt: hace(60 * 1000),
    nowMs: AHORA,
    ...over,
  });

describe('el carrito que nunca llegó a cotizarse', () => {
  it('dentro de los 45 minutos sigue vivo: el cliente aún puede mandar su ubicación', () => {
    expect(carrito({ createdAt: hace(30 * 60 * 1000) })).toBe(false);
  });

  it('pasados los 45 minutos, vence', () => {
    expect(carrito({ createdAt: hace(46 * 60 * 1000) })).toBe(true);
  });

  it('justo en el minuto 45 ya venció', () => {
    expect(carrito({ createdAt: hace(UNQUOTED_CART_WINDOW_MS) })).toBe(true);
  });

  it('NO mira el método de pago: ese es todo el punto de esta regla', () => {
    // El carrito en efectivo es el que la puerta del pago no puede vencer nunca
    // —le responde `not_required`— y el que trajo esta regla.
    expect(carrito({ createdAt: hace(3 * 60 * 60 * 1000) })).toBe(true);
  });
});

describe('el carrito abandonado — qué NO se toca', () => {
  it('un pedido ya cotizado no es un carrito abandonado', () => {
    // Tiene total y QR: lo que le pase a partir de ahí es asunto del pago.
    expect(carrito({ deliveryQuoteStatus: 'quoted', createdAt: hace(12 * 60 * 60 * 1000) })).toBe(
      false,
    );
  });

  it('el FALLO DE MAPBOX no mata el pedido, por viejo que sea', () => {
    // El cliente mandó su ubicación e hizo todo bien; lo que falló fue nuestro.
    // Cancelárselo sería cobrarle a él nuestra avería.
    expect(carrito({ deliveryQuoteStatus: 'failed', createdAt: hace(24 * 60 * 60 * 1000) })).toBe(
      false,
    );
  });

  it('fuera de cobertura SÍ vence: ese pedido no se va a servir nunca', () => {
    // Ya se le dijo que está fuera de los 18 km. Dejarlo abierto solo le tapa
    // el menú para volver a pedir.
    expect(carrito({ deliveryQuoteStatus: 'out_of_coverage', createdAt: hace(60 * 60 * 1000) }))
      .toBe(true);
  });

  it('solo alcanza a `awaiting_location`', () => {
    const otros: OrderStatus[] = [
      'draft',
      'confirmed',
      'preparing',
      'ready',
      'on_the_way',
      'delivered',
      'cancelled',
    ];
    for (const status of otros) {
      expect(carrito({ status, createdAt: hace(12 * 60 * 60 * 1000) }), status).toBe(false);
    }
  });

  it('sin fecha legible NO se inventa un vencimiento', () => {
    // La misma abstención que en la puerta del pago: matar un pedido por un
    // dato roto nuestro sería peor que dejarlo vivo.
    expect(carrito({ confirmedAt: null, createdAt: null })).toBe(false);
    expect(carrito({ confirmedAt: null, createdAt: 'no es una fecha' })).toBe(false);
  });
});

describe('los carritos REALES que trajeron la regla (consulta del 09-09-2026)', () => {
  // 17 pedidos colgados en `awaiting_location` en seis días, ninguno visible
  // para nadie: no entran al tablero de cocina y le tapan el menú al cliente.

  it('los 14 `pending` por QR, el grueso del problema', () => {
    // El más antiguo era del 03-09: seis días abierto.
    expect(carrito({ createdAt: '2026-09-03T22:00:00.000Z' })).toBe(true);
  });

  it('el `pending` en efectivo, que hoy no lo cancelaba nada', () => {
    expect(carrito({ createdAt: '2026-09-07T23:00:00.000Z' })).toBe(true);
  });

  it('los 2 `out_of_coverage` en efectivo', () => {
    expect(
      carrito({ deliveryQuoteStatus: 'out_of_coverage', createdAt: '2026-09-06T21:00:00.000Z' }),
    ).toBe(true);
  });

  it('pero un carrito de HACE UN RATO se salva, sea del método que sea', () => {
    // El cliente que está buscando su ubicación ahora mismo no puede morir.
    expect(carrito({ createdAt: hace(10 * 60 * 1000) })).toBe(false);
  });
});

describe('el instante de apertura del pedido', () => {
  it('prefiere `confirmed_at`: es cuando el cliente supo cuánto pagar', () => {
    const creado = '2026-09-09T00:00:00.000Z';
    const confirmado = '2026-09-09T01:00:00.000Z';
    expect(openedAtMsOf(confirmado, creado)).toBe(Date.parse(confirmado));
  });

  it('usa `created_at` cuando el pedido aún no se confirmó', () => {
    // Es el caso del carrito abandonado: nunca llega a tener `confirmed_at`.
    const creado = '2026-09-09T00:00:00.000Z';
    expect(openedAtMsOf(null, creado)).toBe(Date.parse(creado));
  });

  it('sin ninguna fecha legible devuelve null', () => {
    expect(openedAtMsOf(null, null)).toBe(null);
    expect(openedAtMsOf('no es una fecha', null)).toBe(null);
  });

  it('una fecha rota no tapa a la buena que viene detrás', () => {
    const creado = '2026-09-09T00:00:00.000Z';
    expect(openedAtMsOf('no es una fecha', creado)).toBe(Date.parse(creado));
  });
});
