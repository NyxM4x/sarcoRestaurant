import { describe, it, expect } from 'vitest';
import {
  openedAtMsOf,
  paymentDeadlineMsOf,
  paymentGateOf,
  shouldCancelForExpiry,
  PROOF_WINDOW_MS,
  REJECTION_GRACE_MS,
} from './payment-gate';
import type { AttemptView, PaymentView } from '@/lib/dashboard/attempt-review';
import type { PaymentReviewStatus } from '@/types';

const AHORA = Date.parse('2026-09-01T02:00:00.000Z');
const hace = (ms: number) => new Date(AHORA - ms).toISOString();

/**
 * Pedido abierto hace cinco minutos: dentro de su ventana de comprobante.
 *
 * Lo llevan los casos que NO van de esa ventana, para que sigan comprobando lo
 * suyo. La ventana tiene sus propios casos mas abajo.
 */
const ABIERTO_RECIEN = AHORA - 5 * 60 * 1000;

function intento(status: PaymentReviewStatus, reviewedAt: string | null = null): AttemptView {
  return {
    id: `att-${status}-${reviewedAt ?? 'x'}`,
    status,
    statusLabel: status,
    tone: 'amber',
    openedAt: hace(60 * 60 * 1000),
    reviewedAt,
    proofCount: 1,
    proofs: [],
    canDecide: status === 'pending_review',
  };
}

function pago(attempts: AttemptView[]): PaymentView {
  return {
    attempts,
    unlinkedProofs: [],
    hasPendingReview: attempts.some((a) => a.canDecide),
  };
}

describe('la puerta del pago — cuándo se puede cocinar', () => {
  it('un pago aceptado abre la plancha', () => {
    const g = paymentGateOf('qr', pago([intento('accepted', hace(1000))]), AHORA, ABIERTO_RECIEN);
    expect(g.state).toBe('accepted');
    expect(g.canStart).toBe(true);
  });

  it('un comprobante esperando revisión NO abre nada', () => {
    // El bug que esto corrige: se podía pulsar INICIAR sin mirar el comprobante.
    const g = paymentGateOf('qr', pago([intento('pending_review')]), AHORA, ABIERTO_RECIEN);
    expect(g.state).toBe('awaiting_review');
    expect(g.canStart).toBe(false);
  });

  it('un comprobante RECHAZADO no abre nada', () => {
    // El caso más grave del anterior: se podía cocinar un pago ya rechazado.
    const g = paymentGateOf('qr', pago([intento('rejected', hace(1000))]), AHORA, ABIERTO_RECIEN);
    expect(g.canStart).toBe(false);
  });

  it('sin ningún comprobante todavía, no se cocina', () => {
    expect(paymentGateOf('qr', pago([]), AHORA, ABIERTO_RECIEN).state).toBe('no_proof');
    expect(paymentGateOf('qr', pago([]), AHORA, ABIERTO_RECIEN).canStart).toBe(false);
  });

  it('efectivo y pedidos históricos entran como siempre', () => {
    // Exigirles comprobante los dejaría bloqueados para siempre.
    for (const metodo of ['cash', null] as const) {
      const g = paymentGateOf(metodo, null, AHORA, ABIERTO_RECIEN);
      expect(g.state, String(metodo)).toBe('not_required');
      expect(g.canStart, String(metodo)).toBe(true);
    }
  });
});

describe('la puerta del pago — ante la duda, se cocina', () => {
  it('si no se pudo consultar el pago, se permite iniciar', () => {
    // Cerrar aquí detendría el servicio entero por un fallo de la base, sin
    // ninguna forma de saltarse la puerta desde una tablet.
    const g = paymentGateOf('qr', null, AHORA, ABIERTO_RECIEN);
    expect(g.state).toBe('unknown');
    expect(g.canStart).toBe(true);
  });

  it('`unknown` NUNCA cancela un pedido', () => {
    // Abrir la puerta ante la duda y cancelar ante la duda son cosas opuestas.
    expect(shouldCancelForExpiry('qr', null, AHORA, ABIERTO_RECIEN)).toBe(false);
  });
});

describe('la ventana de gracia tras un rechazo', () => {
  it('dentro de los 15 minutos el pedido sigue vivo, sin poder cocinarse', () => {
    const g = paymentGateOf('qr', pago([intento('rejected', hace(5 * 60 * 1000))]), AHORA, ABIERTO_RECIEN);
    expect(g.state).toBe('rejected_grace');
    expect(g.canStart).toBe(false);
    expect(g.graceEndsAtMs).toBe(AHORA - 5 * 60 * 1000 + REJECTION_GRACE_MS);
  });

  it('pasados los 15 minutos sin reenvío, expira', () => {
    const g = paymentGateOf('qr', pago([intento('rejected', hace(16 * 60 * 1000))]), AHORA, ABIERTO_RECIEN);
    expect(g.state).toBe('expired');
    expect(g.canStart).toBe(false);
    expect(shouldCancelForExpiry('qr', pago([intento('rejected', hace(16 * 60 * 1000))]), AHORA, ABIERTO_RECIEN))
      .toBe(true);
  });

  it('justo en el minuto 15 ya venció: el plazo prometido es el plazo', () => {
    const g = paymentGateOf('qr', pago([intento('rejected', hace(REJECTION_GRACE_MS))]), AHORA, ABIERTO_RECIEN);
    expect(g.state).toBe('expired');
  });

  it('EL REENVÍO PARA EL RELOJ aunque nadie lo haya mirado', () => {
    // El cliente reenvió en el minuto 14. Aunque la cocina tarde otros diez en
    // abrirlo, el pedido no puede morir: cumplió su parte.
    const p = pago([intento('rejected', hace(20 * 60 * 1000)), intento('pending_review')]);
    const g = paymentGateOf('qr', p, AHORA, ABIERTO_RECIEN);
    expect(g.state).toBe('awaiting_review');
    expect(shouldCancelForExpiry('qr', p, AHORA, ABIERTO_RECIEN)).toBe(false);
  });

  it('cada rechazo abre una ventana LIMPIA', () => {
    // Dos rechazos: cuenta el más reciente, porque cada uno viene con su propio
    // aviso al cliente prometiéndole quince minutos.
    const p = pago([
      intento('rejected', hace(60 * 60 * 1000)),
      intento('rejected', hace(2 * 60 * 1000)),
    ]);
    expect(paymentGateOf('qr', p, AHORA, ABIERTO_RECIEN).state).toBe('rejected_grace');
  });

  it('un pago aceptado después de un rechazo manda: el pedido está pagado', () => {
    const p = pago([intento('rejected', hace(60 * 60 * 1000)), intento('accepted', hace(1000))]);
    const g = paymentGateOf('qr', p, AHORA, ABIERTO_RECIEN);
    expect(g.state).toBe('accepted');
    expect(g.canStart).toBe(true);
  });

  it('un rechazo sin fecha de revisión no vence nunca solo', () => {
    // La coherencia de 0021 lo impide en la base, pero si llegara una fila así
    // no se inventa un vencimiento: cancelar por una fecha ilegible sería
    // matar un pedido por un dato roto nuestro.
    const g = paymentGateOf('qr', pago([intento('rejected', null)]), AHORA, ABIERTO_RECIEN);
    expect(g.state).toBe('no_proof');
    expect(g.canStart).toBe(false);
  });
});

describe('la ventana del comprobante que nunca llegó', () => {
  it('dentro de las dos horas el pedido sigue vivo, con su cuenta atrás', () => {
    const g = paymentGateOf('qr', pago([]), AHORA, AHORA - 30 * 60 * 1000);
    expect(g.state).toBe('no_proof');
    expect(g.canStart).toBe(false);
    expect(g.graceEndsAtMs).toBe(AHORA - 30 * 60 * 1000 + PROOF_WINDOW_MS);
  });

  it('pasadas las dos horas sin comprobante, expira', () => {
    // EL CASO QUE TRAJO ESTA REGLA (09-09-2026): un pedido de las 00:32 seguía
    // pidiendo el comprobante a las 12:17 del día siguiente.
    const abierto = AHORA - 12 * 60 * 60 * 1000;
    const g = paymentGateOf('qr', pago([]), AHORA, abierto);
    expect(g.state).toBe('expired');
    expect(g.canStart).toBe(false);
    expect(g.graceEndsAtMs).toBe(null);
    expect(shouldCancelForExpiry('qr', pago([]), AHORA, abierto)).toBe(true);
  });

  it('justo en la hora dos ya venció', () => {
    expect(paymentGateOf('qr', pago([]), AHORA, AHORA - PROOF_WINDOW_MS).state).toBe('expired');
  });

  it('EL COMPROBANTE PARA EL RELOJ aunque nadie lo haya mirado', () => {
    // Mandó su pago dentro del plazo. Que la cocina tarde seis horas en abrirlo
    // no puede matarle el pedido: cumplió su parte.
    const p = pago([intento('pending_review')]);
    const abierto = AHORA - 6 * 60 * 60 * 1000;
    expect(paymentGateOf('qr', p, AHORA, abierto).state).toBe('awaiting_review');
    expect(shouldCancelForExpiry('qr', p, AHORA, abierto)).toBe(false);
  });

  it('un pago ACEPTADO no vence jamás, por viejo que sea el pedido', () => {
    const p = pago([intento('accepted', hace(1000))]);
    const g = paymentGateOf('qr', p, AHORA, AHORA - 48 * 60 * 60 * 1000);
    expect(g.state).toBe('accepted');
    expect(g.canStart).toBe(true);
  });

  it('el EFECTIVO no vence: no hay comprobante que esperar', () => {
    // Exigirle uno lo dejaría cancelándose solo a las dos horas de pedir.
    const g = paymentGateOf('cash', pago([]), AHORA, AHORA - 48 * 60 * 60 * 1000);
    expect(g.state).toBe('not_required');
    expect(g.canStart).toBe(true);
  });

  it('sin fecha de apertura NO se inventa un vencimiento', () => {
    // Es la misma abstención que ante un pago que no se pudo consultar: matar
    // un pedido por un dato roto nuestro sería peor que dejarlo vivo.
    const g = paymentGateOf('qr', pago([]), AHORA, null);
    expect(g.state).toBe('no_proof');
    expect(shouldCancelForExpiry('qr', pago([]), AHORA, null)).toBe(false);
  });

  it('un pago que no se pudo consultar sigue sin cancelar, por viejo que sea', () => {
    // `unknown` gana sobre la ventana: no sabemos si pagó.
    const viejo = AHORA - 48 * 60 * 60 * 1000;
    expect(paymentGateOf('qr', null, AHORA, viejo).state).toBe('unknown');
    expect(shouldCancelForExpiry('qr', null, AHORA, viejo)).toBe(false);
  });
});

describe('el reloj de apertura del pedido', () => {
  it('prefiere `confirmed_at`: es cuando el cliente supo cuánto pagar', () => {
    // El pedido web con delivery nace sin total ni QR y solo sella
    // `confirmed_at` al cotizarse. Contar desde `created_at` le descontaría el
    // rato que tardó en mandar su ubicación.
    const creado = '2026-09-01T00:00:00.000Z';
    const confirmado = '2026-09-01T01:00:00.000Z';
    expect(openedAtMsOf(confirmado, creado)).toBe(Date.parse(confirmado));
  });

  it('usa `created_at` cuando el pedido aún no se confirmó', () => {
    const creado = '2026-09-01T00:00:00.000Z';
    expect(openedAtMsOf(null, creado)).toBe(Date.parse(creado));
  });

  it('sin ninguna fecha legible devuelve null, y eso no cancela nada', () => {
    expect(openedAtMsOf(null, null)).toBe(null);
    expect(openedAtMsOf('no es una fecha', null)).toBe(null);
    // Una fecha rota no tapa a la buena que viene detrás.
    expect(openedAtMsOf('no es una fecha', '2026-09-01T00:00:00.000Z')).toBe(
      Date.parse('2026-09-01T00:00:00.000Z'),
    );
  });
});

describe('el plazo de pago — un solo cálculo para los dos relojes', () => {
  // Es la función que comparten la puerta del KDS y el intake de comprobantes.
  // Que sea la misma es lo que impide que un archivo tardío tenga un desenlace
  // distinto según por dónde se mire el pedido.

  it('sin nada llegado, el plazo son dos horas desde la apertura', () => {
    expect(paymentDeadlineMsOf(pago([]), ABIERTO_RECIEN)).toBe(ABIERTO_RECIEN + PROOF_WINDOW_MS);
  });

  it('tras un rechazo, el plazo son quince minutos desde ese rechazo', () => {
    const rechazado = hace(5 * 60 * 1000);
    expect(paymentDeadlineMsOf(pago([intento('rejected', rechazado)]), ABIERTO_RECIEN)).toBe(
      Date.parse(rechazado) + REJECTION_GRACE_MS,
    );
  });

  it('el rechazo MANDA sobre la ventana del pedido, aunque esta sea más larga', () => {
    // Quien ya pagó una vez cuenta desde su rechazo, no desde que pidió.
    const d = paymentDeadlineMsOf(pago([intento('rejected', hace(60 * 1000))]), AHORA - 1000);
    expect(d).toBe(AHORA - 60 * 1000 + REJECTION_GRACE_MS);
  });

  it('un comprobante esperando revisión NO tiene plazo: el reloj está parado', () => {
    expect(paymentDeadlineMsOf(pago([intento('pending_review')]), ABIERTO_RECIEN)).toBe(null);
  });

  it('un pago aceptado NO tiene plazo: el pedido está pagado', () => {
    expect(paymentDeadlineMsOf(pago([intento('accepted', hace(1000))]), ABIERTO_RECIEN)).toBe(null);
  });

  it('sin rechazos fechados ni apertura legible no hay plazo que contar', () => {
    expect(paymentDeadlineMsOf(pago([]), null)).toBe(null);
    expect(paymentDeadlineMsOf(pago([intento('rejected', null)]), null)).toBe(null);
  });

  it('es EXACTAMENTE el instante que la puerta pinta como cuenta atrás', () => {
    // Si estos dos se separaran, la pantalla contaría hacia un vencimiento y el
    // pedido moriría en otro.
    for (const p of [pago([]), pago([intento('rejected', hace(60 * 1000))])]) {
      const g = paymentGateOf('qr', p, AHORA, ABIERTO_RECIEN);
      expect(g.graceEndsAtMs).toBe(paymentDeadlineMsOf(p, ABIERTO_RECIEN));
    }
  });
});
