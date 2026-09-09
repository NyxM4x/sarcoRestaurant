import { describe, it, expect } from 'vitest';
import { isAbandonedCart, UNQUOTED_CART_WINDOW_MS } from './abandoned-cart';
import type { OrderStatus } from '@/types';

const AHORA = Date.parse('2026-09-09T22:20:00.000Z');
const hace = (ms: number) => new Date(AHORA - ms).toISOString();

/** Un carrito esperando la ubicación de su cliente. */
const carrito = (over: Partial<Parameters<typeof isAbandonedCart>[0]> = {}) =>
  isAbandonedCart({
    status: 'awaiting_location',
    deliveryQuoteStatus: 'pending',
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
    // La firma ni siquiera lo acepta. El carrito en efectivo y el de QR mueren
    // por la misma razón y con el mismo reloj, porque ninguno de los dos llegó a
    // deber nada.
    expect(carrito({ createdAt: hace(3 * 60 * 60 * 1000) })).toBe(true);
  });
});

describe('EL CASO REAL que trajo la regla (09-09-2026)', () => {
  // 12:19  el cliente rearma su pedido → #1 creado, se le pide la ubicación
  //        (nunca la manda)
  // 18:20  escribe "Hola Zarco menu"   → "Tu pedido #1 está guardado 🙌 Para
  //                                       seguir nos falta tu ubicación"
  const CREADO = '2026-09-09T16:19:00.000Z'; // 12:19 hora de Bolivia (UTC-4)

  it('a las 18:20 ese carrito lleva seis horas y está muerto', () => {
    const seisHorasDespues = Date.parse('2026-09-09T22:20:00.000Z');
    expect(carrito({ createdAt: CREADO, nowMs: seisHorasDespues })).toBe(true);
  });

  it('pero a las 12:30, once minutos después, seguía vivo', () => {
    // El cliente que se levanta a buscar el GPS y vuelve no puede perder su
    // pedido. A esa hora el recordatorio de la ubicación es lo correcto.
    const onceMinutos = Date.parse('2026-09-09T16:30:00.000Z');
    expect(carrito({ createdAt: CREADO, nowMs: onceMinutos })).toBe(false);
  });

  it('y a las 13:04 —cumplidos los 45— ya no', () => {
    const cuarentaYCinco = Date.parse('2026-09-09T17:04:00.000Z');
    expect(carrito({ createdAt: CREADO, nowMs: cuarentaYCinco })).toBe(true);
  });
});

describe('el carrito abandonado — qué NO se toca', () => {
  it('un pedido ya cotizado no es un carrito abandonado', () => {
    // Tiene total y QR: lo que le pase a partir de ahí es asunto del pago o del
    // CONFIRMO, no de esta regla.
    expect(carrito({ deliveryQuoteStatus: 'quoted', createdAt: hace(12 * 60 * 60 * 1000) })).toBe(
      false,
    );
  });

  it('el FALLO DE MAPBOX no mata el pedido, por viejo que sea', () => {
    // El cliente mandó su ubicación e hizo todo bien; lo que falló fue nuestro.
    // Cancelárselo —y encima en silencio— sería cobrarle a él nuestra avería.
    expect(carrito({ deliveryQuoteStatus: 'failed', createdAt: hace(24 * 60 * 60 * 1000) })).toBe(
      false,
    );
  });

  it('fuera de cobertura SÍ vence: ese pedido no se va a servir nunca', () => {
    // Ya se le dijo que está fuera de los 18 km. Dejarlo abierto solo le tapa el
    // menú para volver a pedir.
    expect(
      carrito({ deliveryQuoteStatus: 'out_of_coverage', createdAt: hace(60 * 60 * 1000) }),
    ).toBe(true);
  });

  it('un pedido legacy sin cotización dinámica también vence', () => {
    expect(carrito({ deliveryQuoteStatus: null, createdAt: hace(60 * 60 * 1000) })).toBe(true);
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
    // La misma abstención que en la puerta del pago: matar un pedido por un dato
    // roto nuestro sería peor que dejarlo vivo.
    expect(carrito({ createdAt: null })).toBe(false);
    expect(carrito({ createdAt: 'no es una fecha' })).toBe(false);
  });
});

describe('los carritos REALES de producción (consulta del 09-09-2026)', () => {
  // 17 pedidos colgados en `awaiting_location` en seis días. No entran al
  // tablero de cocina, así que nadie los ve, y le tapan el menú al cliente.

  it('los 14 `pending` por QR, el grueso del problema', () => {
    expect(carrito({ createdAt: '2026-09-03T22:00:00.000Z' })).toBe(true);
  });

  it('el `pending` en efectivo, que hoy no lo cancelaba nada', () => {
    // El barrido del CONFIRMO no puede tocarlo: filtra `status='confirmed'`.
    expect(carrito({ createdAt: '2026-09-07T23:00:00.000Z' })).toBe(true);
  });

  it('los 2 `out_of_coverage`', () => {
    expect(
      carrito({ deliveryQuoteStatus: 'out_of_coverage', createdAt: '2026-09-06T21:00:00.000Z' }),
    ).toBe(true);
  });
});
