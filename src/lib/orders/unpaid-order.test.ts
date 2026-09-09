import { describe, it, expect } from 'vitest';
import { isUnpaidAbandonedOrder, UNPAID_ORDER_WINDOW_MS } from './unpaid-order';
import type { OrderStatus, PaymentMethod } from '@/types';

const AHORA = Date.parse('2026-09-09T16:17:00.000Z');
const hace = (ms: number) => new Date(AHORA - ms).toISOString();

/** Un pedido cotizado por QR al que todavía no le llegó nada. */
const pedido = (over: Partial<Parameters<typeof isUnpaidAbandonedOrder>[0]> = {}) =>
  isUnpaidAbandonedOrder({
    status: 'confirmed',
    paymentMethod: 'qr',
    confirmedAt: hace(60 * 1000),
    hasAnyPaymentRow: false,
    nowMs: AHORA,
    ...over,
  });

describe('el pedido por QR que nunca se pagó', () => {
  it('dentro de las dos horas sigue vivo: el cliente aún puede ir al banco', () => {
    expect(pedido({ confirmedAt: hace(90 * 60 * 1000) })).toBe(false);
  });

  it('pasadas las dos horas, vence', () => {
    expect(pedido({ confirmedAt: hace(3 * 60 * 60 * 1000) })).toBe(true);
  });

  it('justo en la hora dos ya venció', () => {
    expect(pedido({ confirmedAt: hace(UNPAID_ORDER_WINDOW_MS) })).toBe(true);
  });
});

describe('EL CASO QUE ABRIÓ TODA ESTA SERIE (09-09-2026)', () => {
  // 00:32  pedido #21 cotizado  →  "Total: Bs. 73" + el QR (no manda nada)
  // 12:17  escribe "Mande menu" →  "Tu pedido #21 está guardado por Bs. 73 🙌
  //                                 Falta que nos mandes la foto del comprobante"
  const COTIZADO = '2026-09-09T04:32:00.000Z'; // 00:32 hora de Bolivia (UTC-4)

  it('a las 12:17 ese pedido lleva doce horas y está muerto', () => {
    expect(pedido({ confirmedAt: COTIZADO, nowMs: AHORA })).toBe(true);
  });

  it('pero a las 01:00, media hora después, seguía vivo', () => {
    // Ese cliente puede estar abriendo la app del banco. El recordatorio del
    // comprobante es exactamente lo que necesita en ese momento.
    const mediaHora = Date.parse('2026-09-09T05:00:00.000Z');
    expect(pedido({ confirmedAt: COTIZADO, nowMs: mediaHora })).toBe(false);
  });

  it('y a las 02:32 —cumplidas las dos horas— ya no', () => {
    const dosHoras = Date.parse('2026-09-09T06:32:00.000Z');
    expect(pedido({ confirmedAt: COTIZADO, nowMs: dosHoras })).toBe(true);
  });
});

describe('el pedido impagado — qué NO se toca', () => {
  it('si llegó CUALQUIER cosa, no es este caso', () => {
    // Un intento en revisión, uno aceptado, uno rechazado, o un comprobante que
    // no se pudo capturar: todas significan que el cliente hizo algo.
    expect(pedido({ hasAnyPaymentRow: true, confirmedAt: hace(24 * 60 * 60 * 1000) })).toBe(false);
  });

  it('el EFECTIVO no se toca: no espera ningún comprobante', () => {
    // A ese pedido lo cierra el barrido del CONFIRMO, con su plazo y su aviso.
    for (const metodo of ['cash', null] as (PaymentMethod | null)[]) {
      expect(pedido({ paymentMethod: metodo, confirmedAt: hace(24 * 60 * 60 * 1000) }), String(metodo))
        .toBe(false);
    }
  });

  it('lo que ya está en la plancha se queda, por viejo que sea', () => {
    // Cancelar algo empezado no devuelve la comida al refrigerador: solo deja a
    // quien cocina sin saber qué estaba haciendo.
    const otros: OrderStatus[] = [
      'draft',
      'awaiting_location',
      'preparing',
      'ready',
      'on_the_way',
      'delivered',
      'cancelled',
    ];
    for (const status of otros) {
      expect(pedido({ status, confirmedAt: hace(24 * 60 * 60 * 1000) }), status).toBe(false);
    }
  });

  it('sin `confirmed_at` NO se inventa un vencimiento', () => {
    // No se le pidió pagar nada todavía, o el dato está roto. En los dos casos,
    // abstenerse: matar un pedido por un dato nuestro sería peor.
    expect(pedido({ confirmedAt: null })).toBe(false);
    expect(pedido({ confirmedAt: 'no es una fecha' })).toBe(false);
  });
});

describe('los tres barridos no se pisan', () => {
  // Cada pedido cae en uno y solo uno. Se comprueba aquí porque los tres corren
  // en el mismo tick y un solapamiento haría que dos reglas se disputaran la
  // misma fila con plazos distintos.

  it('el carrito sin cotizar no es asunto de esta regla', () => {
    // Ese vive en `awaiting_location` y lo cierra `isAbandonedCart` a los 45.
    expect(pedido({ status: 'awaiting_location', confirmedAt: hace(3 * 60 * 60 * 1000) })).toBe(
      false,
    );
  });

  it('el pedido en efectivo sin CONFIRMO tampoco', () => {
    // Ese está `confirmed` como este, pero es `cash`: lo cierra el barrido del
    // CONFIRMO a los 20 minutos.
    expect(pedido({ paymentMethod: 'cash', confirmedAt: hace(3 * 60 * 60 * 1000) })).toBe(false);
  });

  it('esta regla se queda SOLO con `confirmed` + `qr` + sin nada pagado', () => {
    expect(pedido({ confirmedAt: hace(3 * 60 * 60 * 1000) })).toBe(true);
  });
});
