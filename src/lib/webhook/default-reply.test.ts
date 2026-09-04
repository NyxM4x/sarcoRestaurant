import { describe, expect, it } from 'vitest';
import {
  decideDefaultReply,
  OPEN_ORDER_STATUSES,
  type CustomerStateSnapshot,
  type OpenOrderSnapshot,
} from './default-reply';

/**
 * LA RESPUESTA POR DEFECTO (03-09-2026).
 *
 * Lo que se prueba aquí es la inversión de la política: el botón dejó de salir
 * por lista blanca y pasó a ser lo que se hace cuando nada más encajó. Así que
 * los casos importantes NO son los que reciben el botón —esos son casi todos—
 * sino las cuatro excepciones, porque cada una nació de un cliente concreto.
 */

/**
 * El caso base: un texto que NADIE reconoció, el último de su entrega, sin que
 * haya salido ya un botón. Lo que cambia en cada test es lo que se le pone
 * encima.
 */
const AUTOMATICO = {
  text: 'a cuanto',
  isBatchAnchor: true,
  menuAlreadySent: false,
  explicitIntent: false,
} as const;

/** Lo mismo, pero el cliente lo pidió con todas las letras ("quiero pedir"). */
const EXPLICITO = { ...AUTOMATICO, explicitIntent: true } as const;

const SIN_NADA: CustomerStateSnapshot = {
  paused: false,
  openOrder: null,
  proofRemindedRecently: false,
};

function pedido(over: Partial<OpenOrderSnapshot> = {}): OpenOrderSnapshot {
  return {
    orderId: 'order-uuid',
    orderNumber: 'ORD-260903-007',
    status: 'confirmed',
    totalAmount: 95,
    payment: 'no_proof',
    proofReceived: false,
    ...over,
  };
}

describe('decideDefaultReply — el botón es el default', () => {
  it('un texto cualquiera recibe el menú, aunque no diga ninguna palabra clave', () => {
    // "a cuanto" es literalmente el mensaje de la conversación del 03-09-2026
    // que terminó con el cliente pidiendo que no le contestara la IA.
    expect(decideDefaultReply({ ...AUTOMATICO, state: SIN_NADA })).toEqual({
      action: 'menu',
    });
  });

  it('el que no es texto no recibe nada: una foto o un audio no piden un menú', () => {
    expect(decideDefaultReply({ ...AUTOMATICO, text: null, state: SIN_NADA })).toEqual({
      action: 'none',
      reason: 'no_text',
    });
  });

  it('dentro de una ráfaga solo contesta el último: un botón, no tres', () => {
    expect(decideDefaultReply({ ...AUTOMATICO, isBatchAnchor: false, state: SIN_NADA })).toEqual({
      action: 'none',
      reason: 'not_anchor',
    });
  });
});

describe('decideDefaultReply — las excepciones', () => {
  it('no se sabe en qué estado está: no se manda nada', () => {
    // `null` no es "despejado", es "no lo sabemos". Y lo que no se puede
    // descartar a ciegas es que haya una persona escribiéndole ahora mismo.
    expect(decideDefaultReply({ ...AUTOMATICO, state: null })).toEqual({
      action: 'none',
      reason: 'unknown_state',
    });
  });

  it('con un humano atendiendo, el bot calla', () => {
    const state: CustomerStateSnapshot = { ...SIN_NADA, paused: true };
    expect(decideDefaultReply({ ...AUTOMATICO, state })).toEqual({
      action: 'none',
      reason: 'paused',
    });
  });

  it('la pausa gana incluso con un pedido esperando comprobante', () => {
    // El orden de las guardas es el argumento: pisar a quien está atendiendo es
    // peor que dejar de recordar un pago que puede esperar un mensaje más.
    const state: CustomerStateSnapshot = { paused: true, openOrder: pedido(), proofRemindedRecently: false };
    expect(decideDefaultReply({ ...AUTOMATICO, state })).toEqual({
      action: 'none',
      reason: 'paused',
    });
  });

  it('con el pedido cotizado y sin comprobante, se le recuerda el comprobante', () => {
    const order = pedido();
    const state: CustomerStateSnapshot = { ...SIN_NADA, openOrder: order };
    expect(decideDefaultReply({ ...AUTOMATICO, state })).toEqual({
      action: 'proof_reminder',
      order,
    });
  });

  it('el recordatorio no se repite mensaje a mensaje', () => {
    const state: CustomerStateSnapshot = {
      paused: false,
      openOrder: pedido(),
      proofRemindedRecently: true,
    };
    expect(decideDefaultReply({ ...AUTOMATICO, state })).toEqual({
      action: 'none',
      reason: 'reminded_recently',
    });
  });

  it('el pago ya está en revisión: ni menú ni recordatorio', () => {
    const state: CustomerStateSnapshot = {
      ...SIN_NADA,
      openOrder: pedido({ payment: 'awaiting_review' }),
    };
    expect(decideDefaultReply({ ...AUTOMATICO, state })).toEqual({
      action: 'none',
      reason: 'open_order',
    });
  });

  it('un pedido en efectivo no espera ningún comprobante', () => {
    // `not_required` es lo que devuelve la puerta del pago para efectivo. Pedirle
    // un comprobante a quien paga al repartidor sería inventarse un paso.
    const state: CustomerStateSnapshot = {
      ...SIN_NADA,
      openOrder: pedido({ payment: 'not_required' }),
    };
    expect(decideDefaultReply({ ...AUTOMATICO, state })).toEqual({
      action: 'none',
      reason: 'open_order',
    });
  });

  it('no se pudo mirar el pago: no se le reclama nada', () => {
    // `unknown` es "no lo sabemos", y reclamarle un comprobante a quien quizá ya
    // pagó es el peor mensaje posible.
    const state: CustomerStateSnapshot = { ...SIN_NADA, openOrder: pedido({ payment: 'unknown' }) };
    expect(decideDefaultReply({ ...AUTOMATICO, state })).toEqual({
      action: 'none',
      reason: 'open_order',
    });
  });

  it('quien está esperando su comida no recibe un menú', () => {
    for (const status of ['preparing', 'ready', 'on_the_way'] as const) {
      const state: CustomerStateSnapshot = {
        ...SIN_NADA,
        openOrder: pedido({ status, payment: 'accepted' }),
      };
      expect(decideDefaultReply({ ...AUTOMATICO, state })).toEqual({
        action: 'none',
        reason: 'open_order',
      });
    }
  });
});

describe('OPEN_ORDER_STATUSES', () => {
  it('un pedido entregado o cancelado ya no cuenta: ese cliente vuelve a empezar', () => {
    expect(OPEN_ORDER_STATUSES).not.toContain('delivered');
    expect(OPEN_ORDER_STATUSES).not.toContain('cancelled');
  });

  it('un borrador del Flow tampoco: nadie lo está esperando', () => {
    expect(OPEN_ORDER_STATUSES).not.toContain('draft');
  });

  it('el pedido que espera ubicación sí cuenta', () => {
    expect(OPEN_ORDER_STATUSES).toContain('awaiting_location');
  });
});

describe('decideDefaultReply — quien lo pidió con todas las letras', () => {
  it('lo recibe aunque no se sepa nada de él: es el comportamiento de siempre', () => {
    // Sin esta rama, un fallo de consulta dejaría sin menú a quien escribe
    // "quiero pedir" — una regresión de lo que ya funcionaba.
    expect(decideDefaultReply({ ...EXPLICITO, state: null })).toEqual({ action: 'menu' });
  });

  it('lo recibe aunque tenga un pedido en camino: querrá encargar algo más', () => {
    const state: CustomerStateSnapshot = {
      ...SIN_NADA,
      openOrder: pedido({ status: 'on_the_way', payment: 'accepted' }),
    };
    expect(decideDefaultReply({ ...EXPLICITO, state })).toEqual({ action: 'menu' });
  });

  it('NO lo recibe si hay un humano atendiendo', () => {
    // El cliente no sabe que hay alguien escribiéndole. Quien tiene que
    // mandarle el menú en ese momento es esa persona.
    const state: CustomerStateSnapshot = { ...SIN_NADA, paused: true };
    expect(decideDefaultReply({ ...EXPLICITO, state })).toEqual({
      action: 'none',
      reason: 'paused',
    });
  });

  it('si su pedido espera comprobante, recibe el recordatorio y no el menú', () => {
    const order = pedido();
    const state: CustomerStateSnapshot = { ...SIN_NADA, openOrder: order };
    expect(decideDefaultReply({ ...EXPLICITO, state })).toEqual({
      action: 'proof_reminder',
      order,
    });
  });

  it('contesta aunque no sea el último de su ráfaga: su frase ES la petición', () => {
    expect(decideDefaultReply({ ...EXPLICITO, isBatchAnchor: false, state: SIN_NADA })).toEqual({
      action: 'menu',
    });
  });
});

describe('decideDefaultReply — un botón por entrega', () => {
  it('si otro mensaje del lote ya recibió el botón, este no manda otro', () => {
    for (const base of [AUTOMATICO, EXPLICITO]) {
      expect(decideDefaultReply({ ...base, menuAlreadySent: true, state: SIN_NADA })).toEqual({
        action: 'none',
        reason: 'already_sent',
      });
    }
  });
});
