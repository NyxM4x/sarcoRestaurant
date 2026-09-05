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
    paymentMethod: null,
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
      variant: 'missing',
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
      variant: 'missing',
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

describe('decideDefaultReply — cuando la foto YA llegó (04-09-2026)', () => {
  const conFoto = (over: Partial<OpenOrderSnapshot> = {}): CustomerStateSnapshot => ({
    paused: false,
    proofRemindedRecently: false,
    catalogTerms: ['hamburguesa', 'gaseosa'],
    openOrder: {
      orderId: 'order-uuid',
      orderNumber: 'ORD-260904-002',
      status: 'confirmed',
      totalAmount: 28,
      payment: 'no_proof',
      proofReceived: true,
      paymentMethod: null,
      ...over,
    },
  });

  const decidir = (texto: string, state: CustomerStateSnapshot) =>
    decideDefaultReply({ text: texto, isBatchAnchor: true, menuAlreadySent: false, explicitIntent: false, state });

  it('se le dice que la tenemos, en vez de pedírsela otra vez', () => {
    expect(decidir('ya le envie el comprobante', conFoto())).toEqual({
      action: 'proof_reminder',
      order: conFoto().openOrder,
      variant: 'received',
    });
  });

  it('no se le ofrece rehacer el pedido: ese pago ya está hecho', () => {
    // Es el caso exacto del 04-09: comprobante mandado y, un minuto después,
    // "me olvidé". Antes salía el botón y el cliente acababa con dos pedidos.
    expect(decidir('me olvide, quiero armar de nuevo', conFoto()).action).toBe('proof_reminder');
  });

  it('una preferencia se sigue anotando: no toca el total', () => {
    expect(decidir('sin cebolla porfa', conFoto()).action).toBe('kitchen_note');
  });

  it('con el pago ya aceptado no se le dice nada de comprobantes', () => {
    const decision = decidir('gracias', conFoto({ payment: 'accepted', status: 'preparing' }));
    expect(decision.action).not.toBe('proof_reminder');
  });

  it('si ya se le contestó hace poco, no se repite', () => {
    const state = { ...conFoto(), proofRemindedRecently: true };
    expect(decidir('ya mande el comprobante', state)).toEqual({
      action: 'none',
      reason: 'reminded_recently',
    });
  });
});

/**
 * EL PEDIDO #20: "QUE SEAN 3" (05-09-2026).
 *
 * El cliente armó 2 en el menú, pagó el importe de 3 y lo avisó por chat. Su
 * mensaje pasó por esta función y salió por la puerta del comprobante, que era
 * la única que quedaba: la cocina recibió una comanda de 2 con un pago de 3.
 */
describe('decideDefaultReply — corregir la cantidad', () => {
  const conPedido = (over: Partial<OpenOrderSnapshot> = {}): CustomerStateSnapshot => ({
    paused: false,
    proofRemindedRecently: false,
    catalogTerms: ['trancapecho', 'hamburguesa', 'gaseosa'],
    openOrder: pedido({ orderNumber: 'ORD-260904-020', ...over }),
  });

  const decidir = (texto: string, state: CustomerStateSnapshot) =>
    decideDefaultReply({
      text: texto,
      isBatchAnchor: true,
      menuAlreadySent: false,
      explicitIntent: false,
      state,
    });

  it('"que sean 3" abre la pregunta con su pedido delante', () => {
    // No nombra el producto —acaba de decirlo— y ninguna de las tres puertas
    // anteriores lo veía: terminaba en el recordatorio del comprobante. Ahora
    // recibe su desglose y la pregunta; el botón llega si contesta que sí.
    for (const frase of ['que sean 3', 'son 3 no 2', 'mejor 2', 'en realidad quiero 3']) {
      expect(decidir(frase, conPedido()).action, frase).toBe('order_review');
    }
  });

  it('y contestando que le falta algo, llega el botón', () => {
    const yaPreguntado = { ...conPedido(), awaitingReviewReply: true };
    for (const frase of ['1', 'si', 'quiero agregar', 'que sean 3']) {
      expect(decidir(frase, yaPreguntado).action, frase).toBe('order_change');
    }
  });

  it('y contestando que está bien, se le confirma y no se toca nada', () => {
    const yaPreguntado = { ...conPedido(), awaitingReviewReply: true };
    for (const frase of ['2', 'no', 'asi esta bien', 'listo']) {
      expect(decidir(frase, yaPreguntado).action, frase).toBe('order_review_kept');
    }
  });

  it('una respuesta que no contesta a la pregunta NO se repregunta', () => {
    // Insistir con la misma pregunta es lo que acaba llevando a una persona al
    // chat: aquel cliente escribió "??" tras el tercer mensaje idéntico.
    const yaPreguntado = { ...conPedido(), awaitingReviewReply: true };
    for (const frase of ['??', 'cuanto tarda', 'ya pague']) {
      expect(decidir(frase, yaPreguntado).action, frase).not.toBe('order_review');
    }
  });

  it('el producto partido en dos también', () => {
    expect(decidir('Que sean 3 tranca pecho', conPedido()).action).toBe('order_review');
  });

  it('un olvido no acaba anotado en la comanda', () => {
    // Antes ganaba la puerta de la preferencia —va primero— y la frase se
    // imprimía en la comanda con el total sin tocar.
    expect(decidir('me olvide agregame esto', conPedido()).action).toBe('order_review');
  });

  it('la preferencia se sigue anotando igual que ayer', () => {
    expect(decidir('sin cebolla', conPedido()).action).toBe('kitchen_note');
    expect(decidir('con harta mayonesa', conPedido()).action).toBe('kitchen_note');
  });

  it('con el comprobante ya mandado NO se rehace nada', () => {
    // Hay dinero contra un total concreto: esa guarda va antes y sigue mandando.
    const state = conPedido({ proofReceived: true });
    expect(decidir('que sean 3', state).action).toBe('proof_reminder');
  });

  it('contestar una hora o una distancia no reabre el pedido', () => {
    for (const frase of ['llego en 20 minutos', 'estoy a 3 cuadras', 'son 50 bs']) {
      expect(decidir(frase, conPedido()).action, frase).not.toBe('order_change');
    }
  });
});

/**
 * EL PEDIDO #26: EL EFECTIVO NO PODÍA CAMBIARSE (05-09-2026).
 *
 * `paymentGateOf` devuelve `not_required` para todo lo que no sea QR, y la
 * puerta del cambio exigía `no_proof`. Resultado: ningún pedido en efectivo
 * llegaba nunca al botón de "MODIFICAR MI PEDIDO".
 *
 * Aquel cliente escribió "un vaso de limonada también" sobre un pedido en
 * efectivo ya cotizado, el turno se lo quedó el modelo, le mandó el menú normal
 * y armó un SEGUNDO pedido: dos comandas y el envío cobrado dos veces.
 */
describe('decideDefaultReply — el pedido en efectivo también se cambia', () => {
  const enEfectivo = (over: Partial<OpenOrderSnapshot> = {}): CustomerStateSnapshot => ({
    paused: false,
    proofRemindedRecently: false,
    catalogTerms: ['trancapecho', 'vaso', 'limonada', 'gaseosa'],
    openOrder: pedido({
      orderNumber: 'ORD-260904-026',
      // Lo que devuelve `paymentGateOf` para un pedido en efectivo: no hay
      // comprobante que esperar, así que la puerta del pago no aplica.
      payment: 'not_required',
      paymentMethod: 'cash',
      totalAmount: 28,
      ...over,
    }),
  });

  const decidir = (texto: string, state: CustomerStateSnapshot) =>
    decideDefaultReply({
      text: texto,
      isBatchAnchor: true,
      menuAlreadySent: false,
      explicitIntent: false,
      state,
    });

  it('le contesta con su pedido delante, en vez de callarse', () => {
    expect(decidir('un vaso de limonada también', enEfectivo()).action).toBe('order_review');
  });

  it('y el botón llega cuando contesta que sí', () => {
    const yaPreguntado = { ...enEfectivo(), awaitingReviewReply: true };
    expect(decidir('1', yaPreguntado).action).toBe('order_change');
  });

  it('vale para las tres formas de pedirlo', () => {
    for (const frase of ['quiero modificar', 'me olvidé algo', 'que sean 3']) {
      expect(decidir(frase, enEfectivo()).action, frase).toBe('order_review');
    }
  });

  it('también antes de mandar la ubicación', () => {
    // `awaiting_location` es el momento MÁS seguro para rehacerlo: no hay total
    // final, ni QR, ni nada en la plancha.
    const state = enEfectivo({ status: 'awaiting_location' });
    expect(decidir('quiero modificar', state).action).toBe('order_review');
  });

  it('el QR sigue comportándose exactamente igual que antes', () => {
    const porQr = (): CustomerStateSnapshot => ({
      ...enEfectivo(),
      openOrder: pedido({ payment: 'no_proof', paymentMethod: 'qr' }),
    });
    expect(decidir('quiero modificar', porQr()).action).toBe('order_review');
  });

  it('con el pago ya aceptado no se rehace nada, sea como sea que pague', () => {
    for (const metodo of ['cash', 'qr'] as const) {
      const state = enEfectivo({ payment: 'accepted', paymentMethod: metodo, status: 'preparing' });
      const accion = decidir('quiero modificar', state).action;
      expect(accion, metodo).not.toBe('order_change');
      expect(accion, metodo).not.toBe('order_review');
    }
  });

  it('si ese cliente mandó una foto igualmente, gana el comprobante', () => {
    // Un pedido en efectivo puede recibir un comprobante —alguien que decide
    // pagar por QR después—. Ahí hay algo que mirar antes de tocar el pedido.
    const state = enEfectivo({ proofReceived: true });
    expect(decidir('quiero modificar', state).action).toBe('proof_reminder');
  });

  it('con la comida ya hecha no se rehace: solo estados rearmables', () => {
    for (const estado of ['preparing', 'ready', 'on_the_way'] as const) {
      const state = enEfectivo({ status: estado });
      const accion = decidir('quiero modificar', state).action;
      expect(accion, estado).not.toBe('order_change');
      expect(accion, estado).not.toBe('order_review');
    }
  });
});

/**
 * LA RÁFAGA DEL #26: EL MENSAJE BUENO NO ERA EL ÚLTIMO (05-09-2026).
 *
 * "Un vaso de lims" / "Grande" / "También" / "Xfa". La petición va en el primer
 * mensaje y la cortesía en el último, y solo se leía el último: "Xfa" no
 * dispara nada, así que aquel cliente no recibió respuesta y acabó armando un
 * segundo pedido con su segundo envío.
 */
describe('decideDefaultReply — la entrega entera, no solo el ancla', () => {
  const conPedido = (over: Partial<OpenOrderSnapshot> = {}): CustomerStateSnapshot => ({
    paused: false,
    proofRemindedRecently: false,
    catalogTerms: ['trancapecho', 'vaso', 'limonada', 'gaseosa', 'papas'],
    openOrder: pedido({ orderNumber: 'ORD-260904-026', paymentMethod: 'cash', ...over }),
  });

  const decidirLote = (textos: string[], state: CustomerStateSnapshot) =>
    decideDefaultReply({
      // El ancla es el ÚLTIMO, como en producción.
      text: textos[textos.length - 1],
      batchTexts: textos,
      isBatchAnchor: true,
      menuAlreadySent: false,
      explicitIntent: false,
      state,
    });

  it('la ráfaga literal del #26 recibe el botón de cambiar', () => {
    const decision = decidirLote(
      ['Un vaso de lims', 'Grande', 'También', 'Xfa'],
      conPedido(),
    );
    expect(decision.action).toBe('order_review');
  });

  it('sin los otros textos del lote, el ancla sola sigue sin decir nada', () => {
    // La prueba de que el arreglo es el lote y no otra cosa.
    const decision = decideDefaultReply({
      text: 'Xfa',
      isBatchAnchor: true,
      menuAlreadySent: false,
      explicitIntent: false,
      state: conPedido(),
    });
    expect(decision.action).not.toBe('order_review');
  });

  it('un cambio en el lote gana a una preferencia de cocina', () => {
    // "sin cebolla" junto a "un vaso más" no es una preferencia: es un cambio
    // con una preferencia dentro. Anotarlo y callar lo segundo deja el total
    // viejo con comida nueva, que es la mitad cara del error.
    const decision = decidirLote(['sin cebolla', 'y un vaso de limonada'], conPedido());
    expect(decision.action).toBe('order_review');
  });

  it('una preferencia sola se sigue anotando, venga en el lote donde venga', () => {
    const decision = decidirLote(['hola', 'sin cebolla porfa', 'gracias'], conPedido());
    expect(decision).toMatchObject({ action: 'kitchen_note', note: 'sin cebolla porfa' });
  });

  it('el lote no multiplica las respuestas: sale UNA', () => {
    // Dos frases de cambio en la misma ráfaga siguen siendo un solo botón.
    const decision = decidirLote(['me olvidé algo', 'que sean 3'], conPedido());
    expect(decision.action).toBe('order_review');
  });

  it('un lote sin nada reconocible sigue su camino de hoy', () => {
    const decision = decidirLote(['hola', 'gracias', 'ok'], conPedido());
    expect(decision.action).not.toBe('order_change');
    expect(decision.action).not.toBe('order_review');
    expect(decision.action).not.toBe('kitchen_note');
  });

  it('quien no es el ancla sigue sin contestar por su cuenta', () => {
    // El lote se lee entero, pero responde uno solo: si no, "Un vaso de lims" y
    // "Xfa" mandarían cada uno el suyo.
    const decision = decideDefaultReply({
      text: 'Un vaso de lims',
      batchTexts: ['Un vaso de lims', 'Grande', 'También', 'Xfa'],
      isBatchAnchor: false,
      menuAlreadySent: false,
      explicitIntent: false,
      state: conPedido(),
    });
    expect(decision).toEqual({ action: 'none', reason: 'not_anchor' });
  });

  it('también atiende "paso a recogerlo" cuando no es el último', () => {
    const decision = decidirLote(['mejor paso a recogerlo', 'gracias'], conPedido());
    expect(decision.action).toBe('pickup_switch');
  });
});

/**
 * EL PEDIDO EN EFECTIVO ESPERA UN "CONFIRMO" (05-09-2026).
 *
 * Dos clientes de la misma madrugada vieron el precio del envío en el mensaje
 * de la cotización y dijeron que no —"muy caro su moto", "cancelar pedido"— con
 * el pedido ya en el grupo de reparto. Ahora ese pedido no sale ni entra a
 * cocina hasta que el cliente lo confirme.
 */
describe('decideDefaultReply — CONFIRMO / CANCELAR en efectivo', () => {
  const esperandoConfirmacion = (
    over: Partial<OpenOrderSnapshot> = {},
  ): CustomerStateSnapshot => ({
    paused: false,
    proofRemindedRecently: false,
    catalogTerms: ['trancapecho', 'lomito', 'gaseosa'],
    openOrder: pedido({
      orderNumber: 'ORD-260904-040',
      payment: 'not_required',
      paymentMethod: 'cash',
      totalAmount: 63,
      awaitingCashConfirm: true,
      ...over,
    }),
  });

  const decidir = (texto: string, state: CustomerStateSnapshot) =>
    decideDefaultReply({
      text: texto,
      isBatchAnchor: true,
      menuAlreadySent: false,
      explicitIntent: false,
      state,
    });

  it('CONFIRMO agenda el pedido', () => {
    for (const frase of ['CONFIRMO', 'confirmo', 'si', 'dale']) {
      expect(decidir(frase, esperandoConfirmacion()).action, frase).toBe('cash_confirm');
    }
  });

  it('CANCELAR lo cierra', () => {
    // Es lo que escribió el cliente del #39, palabra por palabra.
    for (const frase of ['Cancelar pedido', 'cancelar', 'ya no quiero']) {
      expect(decidir(frase, esperandoConfirmacion()).action, frase).toBe('cash_cancel');
    }
  });

  it('una queja por el precio NO cancela nada', () => {
    // "Muy caro su moto" es lo que escribió el del #40. No es un CANCELAR: su
    // pedido se queda esperando, y el barrido lo caduca solo si no vuelve.
    const decision = decidir('Muy caro su moto', esperandoConfirmacion());
    expect(decision.action).not.toBe('cash_cancel');
    expect(decision.action).not.toBe('cash_confirm');
  });

  it('va antes que todo lo demás del pedido abierto', () => {
    // Ese pedido no está en cocina ni en el grupo: lo que decide este mensaje es
    // si entra o desaparece, y eso manda sobre cualquier otra lectura.
    expect(decidir('confirmo', esperandoConfirmacion()).action).toBe('cash_confirm');
  });

  it('ya confirmado, esas palabras dejan de decidir nada', () => {
    const yaConfirmado = esperandoConfirmacion({ awaitingCashConfirm: false });
    const decision = decidir('cancelar', yaConfirmado);
    expect(decision.action).not.toBe('cash_cancel');
  });

  it('nunca hay DOS preguntas abiertas a la vez', () => {
    // A ese cliente acabamos de preguntarle CONFIRMO o CANCELAR. Si además le
    // mandáramos "¿querés agregar algo? 1 / 2", un "1" suyo ya no sabríamos a
    // cuál de las dos iba. El botón sale directo: reabre su pedido con lo que
    // eligió dentro, que es justo lo que la otra pregunta iba a enseñarle.
    const decision = decidir('una gaseosa también', esperandoConfirmacion());
    expect(decision.action).toBe('order_change');
    expect(decision.action).not.toBe('order_review');
  });

  it('con el pedido ya confirmado, la pregunta del cambio vuelve', () => {
    const yaConfirmado = esperandoConfirmacion({ awaitingCashConfirm: false });
    expect(decidir('una gaseosa también', yaConfirmado).action).toBe('order_review');
  });

  it('un pedido por QR no pasa por aquí', () => {
    // Ahí lo que confirma el pedido es el comprobante.
    const porQr: CustomerStateSnapshot = {
      ...esperandoConfirmacion(),
      openOrder: pedido({ payment: 'no_proof', paymentMethod: 'qr' }),
    };
    expect(decidir('confirmo', porQr).action).not.toBe('cash_confirm');
  });
});
