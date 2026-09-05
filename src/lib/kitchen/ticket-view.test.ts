import { describe, it, expect } from 'vitest';
import {
  enteredAtOf,
  groupItemsByOrder,
  sortByAge,
  toKitchenTickets,
  type RawKitchenItemRow,
  type RawKitchenOrderRow,
} from './ticket-view';
import type { OrderStatus } from '@/types';

const BASE = Date.parse('2026-08-22T12:00:00Z');
/** Puerta abierta: el orden del grid no depende del pago. */
const ABIERTA = { state: 'not_required' as const, canStart: true, graceEndsAtMs: null };

const iso = (min: number) => new Date(BASE + min * 60_000).toISOString();

function row(
  id: string,
  status: OrderStatus,
  overrides: Partial<RawKitchenOrderRow> = {},
): RawKitchenOrderRow {
  return {
    id,
    order_number: `ORD-${id}`,
    status,
    delivery_type: 'delivery',
    notes: null,
    created_at: iso(0),
    confirmed_at: null,
    updated_at: iso(0),
    ...overrides,
  };
}

const item = (orderId: string, name: string, quantity: number): RawKitchenItemRow => ({
  order_id: orderId,
  product_name_snapshot: name,
  quantity,
});

describe('ticket — antigüedad medida en cocina', () => {
  it('usa `confirmed_at` cuando existe, y `created_at` como respaldo', () => {
    expect(enteredAtOf(row('1', 'confirmed', { created_at: iso(0), confirmed_at: iso(20) }))).toBe(
      iso(20),
    );
    expect(enteredAtOf(row('2', 'confirmed', { created_at: iso(0), confirmed_at: null }))).toBe(
      iso(0),
    );
  });

  it('el ticket lleva el instante de entrada a cocina, no el del chat', () => {
    const [ticket] = toKitchenTickets(
      [row('1', 'confirmed', { created_at: iso(0), confirmed_at: iso(35) })],
      [],
    );
    expect(ticket.enteredAt).toBe(iso(35));
  });
});

describe('ticket — orden y contenido', () => {
  it('ordena por antigüedad: lo que más espera va primero', () => {
    const rows = [
      row('a', 'confirmed', { confirmed_at: iso(30) }),
      row('b', 'preparing', { confirmed_at: iso(5) }),
      row('c', 'ready', { confirmed_at: iso(15) }),
    ];
    expect(toKitchenTickets(rows, []).map((t) => t.orderNumber)).toEqual([
      'ORD-b',
      'ORD-c',
      'ORD-a',
    ]);
  });

  it('las fechas ilegibles se van al final sin romper el orden', () => {
    const tickets = sortByAge([
      { orderNumber: 'roto', enteredAt: 'no-fecha', stage: 'new', deliveryType: 'pickup', lines: [], notes: null, paysCash: false, completedAt: null, amountDueByQr: 0, awaitingPaymentConfirmation: false, payment: null, gate: ABIERTA, amountLabel: null, deliveryCollect: null },
      { orderNumber: 'ok', enteredAt: iso(1), stage: 'new', deliveryType: 'pickup', lines: [], notes: null, paysCash: false, completedAt: null, amountDueByQr: 0, awaitingPaymentConfirmation: false, payment: null, gate: ABIERTA, amountLabel: null, deliveryCollect: null },
    ]);
    expect(tickets.map((t) => t.orderNumber)).toEqual(['ok', 'roto']);
  });

  it('agrupa los ítems por pedido y los adjunta al ticket correcto', () => {
    const items = [item('a', 'Trancapecho', 2), item('b', 'Gaseosa 2 L', 1), item('a', 'Api', 3)];
    expect(groupItemsByOrder(items).a).toEqual([
      // `category: null` porque el helper de este test no la trae: una línea
      // sin categoría resuelta cae en "Otros" del resumen, nunca en Comidas.
      { name: 'Trancapecho', quantity: 2, modifiers: [], category: null },
      { name: 'Api', quantity: 3, modifiers: [], category: null },
    ]);

    const tickets = toKitchenTickets([row('a', 'confirmed'), row('b', 'preparing')], items);
    expect(tickets.find((t) => t.orderNumber === 'ORD-a')?.lines).toHaveLength(2);
    expect(tickets.find((t) => t.orderNumber === 'ORD-b')?.lines).toHaveLength(1);
  });

  it('un pedido sin ítems no rompe el tablero', () => {
    expect(toKitchenTickets([row('a', 'confirmed')], [])[0].lines).toEqual([]);
  });

  it('los modificadores llegan vacíos pero el campo existe, listo para pintarlos', () => {
    const [ticket] = toKitchenTickets([row('a', 'confirmed')], [item('a', 'Trancapecho', 1)]);
    expect(ticket.lines[0].modifiers).toEqual([]);
  });
});

describe('ticket — qué entra y qué no', () => {
  it('solo entran los estados cocinables; draft y despachados quedan fuera', () => {
    const rows: RawKitchenOrderRow[] = [
      row('1', 'draft'),
      row('2', 'awaiting_location'),
      row('3', 'confirmed'),
      row('4', 'preparing'),
      row('5', 'ready'),
      row('6', 'on_the_way'),
      row('7', 'delivered'),
    ];
    expect(toKitchenTickets(rows, []).map((t) => t.stage)).toEqual([
      'new',
      'in_progress',
      'done',
    ]);
  });

  it('la hora de completado solo viaja en los tickets listos', () => {
    const rows = [
      row('1', 'ready', { updated_at: iso(40) }),
      row('2', 'preparing', { updated_at: iso(40) }),
    ];
    const tickets = toKitchenTickets(rows, []);
    expect(tickets.find((t) => t.stage === 'done')?.completedAt).toBe(iso(40));
    expect(tickets.find((t) => t.stage === 'in_progress')?.completedAt).toBeNull();
  });

  it('las notas del pedido viajan tal cual (texto libre a nivel de pedido)', () => {
    const [ticket] = toKitchenTickets([row('1', 'confirmed', { notes: 'Tocar el timbre' })], []);
    expect(ticket.notes).toBe('Tocar el timbre');
  });
});

describe('el pedido entra a cocina con el COMPROBANTE, no con el QR', () => {
  /**
   * Antes entraba al cotizar, que es cuando se le manda el QR al cliente. La
   * comanda aparecía vacía —sin nada que revisar— y quien cocinaba tenía delante
   * un pedido que nadie había pagado todavía. El aviso al reparto salía en ese
   * mismo momento, así que alguien podía salir a llevar algo sin cobrar.
   */
  function pedido(over: Partial<RawKitchenOrderRow> = {}): RawKitchenOrderRow {
    return {
      id: 'order-1',
      order_number: 'ORD-000100',
      status: 'confirmed',
      delivery_type: 'delivery',
      notes: null,
      created_at: '2026-08-27T20:00:00.000Z',
      confirmed_at: '2026-08-27T20:01:00.000Z',
      updated_at: '2026-08-27T20:01:00.000Z',
      payment_method: 'qr',
      subtotal_amount: 48,
      total_amount: 64,
      ...over,
    };
  }

  /** Vista de pago con un comprobante ya asociado a un intento. */
  const CON_COMPROBANTE = {
    attempts: [
      {
        id: 'a1',
        status: 'pending_review' as const,
        statusLabel: 'Pendiente de revisión',
        tone: 'amber' as const,
        openedAt: '2026-08-27T20:05:00.000Z',
        reviewedAt: null,
        proofCount: 1,
        proofs: [{ id: 'p1' }],
        canDecide: true,
      },
    ],
    unlinkedProofs: [],
    hasPendingReview: true,
  } as never;

  it('sin comprobante NO aparece: el QR enviado no es un pago', () => {
    expect(toKitchenTickets([pedido()], [], {}, true)).toEqual([]);
  });

  it('con comprobante aparece, y ya trae qué revisar', () => {
    const tickets = toKitchenTickets([pedido()], [], { 'order-1': CON_COMPROBANTE }, true);
    expect(tickets).toHaveLength(1);
    expect(tickets[0].payment).not.toBeNull();
  });

  it('un comprobante que no se pudo guardar TAMBIÉN lo hace entrar', () => {
    // Llegó algo y no pudimos traerlo: eso es justo lo que cocina tiene que ver,
    // no un motivo para ocultarle el pedido.
    const sinArchivo = {
      attempts: [],
      unlinkedProofs: [{ id: 'p1', isAvailable: false }],
      hasPendingReview: false,
    } as never;
    expect(toKitchenTickets([pedido()], [], { 'order-1': sinArchivo }, true)).toHaveLength(1);
  });

  it('ya empezado, se queda aunque el pago se rechace después', () => {
    // La regla frena la ENTRADA, no saca de la pantalla lo que ya está en la
    // plancha: hacerlo desaparecer no devuelve la hamburguesa al refrigerador.
    for (const status of ['preparing', 'ready'] as const) {
      const tickets = toKitchenTickets([pedido({ status })], [], {}, true);
      expect(tickets, status).toHaveLength(1);
    }
  });

  it('los históricos en efectivo entran como siempre', () => {
    // No tienen comprobante que esperar; exigirles uno los dejaría invisibles.
    expect(toKitchenTickets([pedido({ payment_method: 'cash' })], [], {}, true)).toHaveLength(1);
    expect(toKitchenTickets([pedido({ payment_method: null })], [], {}, true)).toHaveLength(1);
  });
});

describe('si no se pudo consultar el pago, entran TODOS', () => {
  /**
   * "No hay comprobantes" y "no pude consultar los comprobantes" dejaron de ser
   * lo mismo en cuanto el comprobante decide la entrada al tablero.
   *
   * Confundirlos vacía la cocina: sin datos de pago, todo pedido por QR parece
   * impagado y se filtra entero. Una consulta caída dejaría la pantalla en
   * blanco en plena noche, que es exactamente el fallo que el tablero no puede
   * permitirse. Ante la duda entran todos: ver un pedido de más es preferible a
   * perder la pantalla.
   */
  function porQr(): RawKitchenOrderRow {
    return {
      id: 'order-1',
      order_number: 'ORD-000200',
      status: 'confirmed',
      delivery_type: 'delivery',
      notes: null,
      created_at: '2026-08-27T20:00:00.000Z',
      confirmed_at: '2026-08-27T20:01:00.000Z',
      updated_at: '2026-08-27T20:01:00.000Z',
      payment_method: 'qr',
    };
  }

  it('sin poder consultar el pago, el pedido se ve igualmente', () => {
    // `pagosConsultados = false`: la consulta falló.
    expect(toKitchenTickets([porQr()], [], {}, false)).toHaveLength(1);
  });

  it('y con la consulta OK sin comprobante, se filtra como debe', () => {
    expect(toKitchenTickets([porQr()], [], {}, true)).toEqual([]);
  });

  it('por defecto no filtra: quien no pasa el dato no puede vaciar el tablero', () => {
    // El parámetro es opcional y su default es el seguro. Un llamador que aún no
    // sepa de pagos —o un test antiguo— no puede dejar la cocina sin comandas.
    expect(toKitchenTickets([porQr()], [])).toHaveLength(1);
  });
});

describe('el pedido solo SUMA al resumen cuando el pago está confirmado', () => {
  /**
   * El comprobante decide la ENTRADA al tablero desde antes; esto decide algo
   * distinto: cuándo sus unidades entran en el total de la barra derecha. El
   * planchero cocina contra ese número, y un pago que después se rechaza le
   * hacía cocinar de más.
   */
  function pedido(over: Partial<RawKitchenOrderRow> = {}): RawKitchenOrderRow {
    return {
      id: 'order-1',
      order_number: 'ORD-000300',
      status: 'confirmed',
      delivery_type: 'delivery',
      notes: null,
      created_at: '2026-08-27T20:00:00.000Z',
      confirmed_at: '2026-08-27T20:01:00.000Z',
      updated_at: '2026-08-27T20:01:00.000Z',
      payment_method: 'qr',
      subtotal_amount: 48,
      total_amount: 64,
      ...over,
    };
  }

  /** Vista de pago con un único intento en el estado que pida el test. */
  const conIntento = (...estados: Array<'pending_review' | 'accepted' | 'rejected'>) =>
    ({
      attempts: estados.map((status, i) => ({
        id: `a${i}`,
        status,
        statusLabel: status,
        tone: 'amber' as const,
        openedAt: '2026-08-27T20:05:00.000Z',
        reviewedAt: null,
        proofCount: 1,
        proofs: [{ id: `p${i}` }],
        canDecide: status === 'pending_review',
      })),
      unlinkedProofs: [],
      hasPendingReview: estados.includes('pending_review'),
    }) as never;

  it('con el comprobante pendiente de revisión, el pedido espera', () => {
    const [ticket] = toKitchenTickets(
      [pedido()],
      [],
      { 'order-1': conIntento('pending_review') },
      true,
    );
    expect(ticket.awaitingPaymentConfirmation).toBe(true);
  });

  it('con el pago aceptado, deja de esperar', () => {
    const [ticket] = toKitchenTickets([pedido()], [], { 'order-1': conIntento('accepted') }, true);
    expect(ticket.awaitingPaymentConfirmation).toBe(false);
  });

  it('con el pago rechazado, sigue esperando', () => {
    const [ticket] = toKitchenTickets(
      [pedido({ status: 'preparing' })],
      [],
      { 'order-1': conIntento('rejected') },
      true,
    );
    expect(ticket.awaitingPaymentConfirmation).toBe(true);
  });

  it('un intento aceptado basta, aunque llegue otro comprobante después', () => {
    // Una vez que un pago se acepta, el pedido está pagado: un duplicado o un
    // reenvío del cliente no puede volver a dejarlo a deber.
    const [ticket] = toKitchenTickets(
      [pedido({ status: 'preparing' })],
      [],
      { 'order-1': conIntento('pending_review', 'accepted') },
      true,
    );
    expect(ticket.awaitingPaymentConfirmation).toBe(false);
  });

  it('los pedidos en efectivo no esperan nada: no hay comprobante que aceptar', () => {
    for (const metodo of ['cash', null] as const) {
      const [ticket] = toKitchenTickets([pedido({ payment_method: metodo })], [], {}, true);
      expect(ticket.awaitingPaymentConfirmation, String(metodo)).toBe(false);
    }
  });

  it('si no se pudo consultar el pago, NO se afirma que falte confirmar', () => {
    // Mismo criterio que el filtro de entrada: un fallo de consulta no puede
    // vaciar el resumen entero. Ante la duda, cuenta.
    const [ticket] = toKitchenTickets([pedido()], [], {}, false);
    expect(ticket.awaitingPaymentConfirmation).toBe(false);
  });
});

describe('ticket — qué se cobra en la puerta', () => {
  const cobro = (over: Partial<RawKitchenOrderRow>) =>
    toKitchenTickets([row('x', 'confirmed', over)], [])[0].deliveryCollect;

  it('delivery por QR: falta el envío, y dice cuánto', () => {
    // El caso normal. La comida se pagó por QR y el envío se cobra al entregar.
    // Sin comprobante leído es una DEDUCCIÓN, no un dato: `basis: 'pedido'`.
    expect(cobro({ delivery_type: 'delivery', payment_method: 'qr', subtotal_amount: 44, total_amount: 54 }))
      .toEqual({ kind: 'envio', amount: 10, basis: 'pedido', canOverride: true });
  });

  it('delivery en efectivo: se cobra todo, y no hay nada que confirmar', () => {
    // 05-09-2026, el pedido #25 —el primero que eligió efectivo—. Salía con
    // `basis: 'pedido'` y `canOverride: true`, o sea con los dos botones de
    // marcar el envío y con "Sin confirmar: no se pudo leer el comprobante"
    // debajo. Las tres cosas falsas: no hay comprobante que leer, no hay envío
    // pagado por adelantado, y no hay duda que zanjar.
    expect(cobro({ delivery_type: 'delivery', payment_method: 'cash', subtotal_amount: 44, total_amount: 54 }))
      .toEqual({ kind: 'todo', amount: 54, basis: 'efectivo', canOverride: false });
  });

  it('una marca vieja del envío no sobrevive en un pedido en efectivo', () => {
    // Los botones existieron para estos tickets antes del 05-09. Lo que alguien
    // tocara entonces no puede seguir mandando ahora: en efectivo el envío no
    // tiene ningún camino por el que constar pagado de antemano.
    expect(
      cobro({
        delivery_type: 'delivery',
        payment_method: 'cash',
        subtotal_amount: 44,
        total_amount: 54,
        delivery_fee_paid: true,
      }),
    ).toEqual({ kind: 'todo', amount: 54, basis: 'efectivo', canOverride: false });
  });

  it('un pedido en efectivo sin importes no inventa una cifra que cobrar', () => {
    expect(cobro({ delivery_type: 'delivery', payment_method: 'cash', subtotal_amount: 0, total_amount: 0 }))
      .toBeNull();
  });

  it('en recojo no hay puerta donde cobrar', () => {
    expect(cobro({ delivery_type: 'pickup', payment_method: 'qr', subtotal_amount: 44, total_amount: 44 }))
      .toBeNull();
  });

  it('sin método de pago registrado no se afirma nada', () => {
    // Pedido histórico. Mandar cobrar a quien quizá ya pagó es peor que callar:
    // el repartidor siempre puede preguntar, pero no puede deshacer un cobro.
    expect(cobro({ delivery_type: 'delivery', subtotal_amount: 44, total_amount: 54 })).toBeNull();
  });

  it('delivery sin costo de envío no manda cobrar cero', () => {
    expect(cobro({ delivery_type: 'delivery', payment_method: 'qr', subtotal_amount: 44, total_amount: 44 }))
      .toEqual({ kind: 'pagado', basis: 'pedido', canOverride: true });
  });

  it('lo que dice una PERSONA gana sobre todo lo demás', () => {
    // Debajo de toda regla automática queda un caso que solo se resuelve
    // mirando la imagen, y quien la mira es quien empaca. Su palabra manda.
    expect(
      cobro({
        delivery_type: 'delivery',
        payment_method: 'qr',
        subtotal_amount: 44,
        total_amount: 54,
        delivery_fee_paid: true,
      }),
    ).toEqual({ kind: 'pagado', basis: 'persona', canOverride: true });

    expect(
      cobro({
        delivery_type: 'delivery',
        payment_method: 'qr',
        subtotal_amount: 44,
        total_amount: 54,
        delivery_fee_paid: false,
      }),
    ).toEqual({ kind: 'envio', amount: 10, basis: 'persona', canOverride: true });
  });

  it('una marca de persona se puede corregir mientras el pago siga sin aceptar', () => {
    // Quien marca esto lo hace con el pedido en la mano y prisa. Equivocarse es
    // parte del trabajo; no poder desandarlo obliga a llamar por teléfono, que
    // es justo lo que esto vino a evitar.
    //
    // La ventana se cierra al aceptar el comprobante, que es cuando la
    // instrucción sale al grupo de reparto: ver el describe del congelado.
    for (const marca of [true, false]) {
      const c = cobro({
        delivery_type: 'delivery',
        payment_method: 'qr',
        subtotal_amount: 44,
        total_amount: 54,
        delivery_fee_paid: marca,
      });
      expect(c?.canOverride, String(marca)).toBe(true);
    }
  });

  it('el ticket señala el efectivo sin llegar a decir cómo se paga', () => {
    // La pantalla necesita saber que este pedido no espera comprobante —si no,
    // le escribe "A cobrar por QR" y "Sin comprobante" encima—, pero la palabra
    // sigue sin viajar: lo que cruza es un booleano.
    const cash = toKitchenTickets(
      [row('x', 'confirmed', { delivery_type: 'delivery', payment_method: 'cash', subtotal_amount: 44, total_amount: 54 })],
      [],
    )[0];
    expect(cash.paysCash).toBe(true);
    expect(JSON.stringify(cash)).not.toContain('cash');

    const qr = toKitchenTickets(
      [row('y', 'confirmed', { delivery_type: 'delivery', payment_method: 'qr', subtotal_amount: 44, total_amount: 54 })],
      [],
    )[0];
    expect(qr.paysCash).toBe(false);

    // Un pedido histórico sin método registrado no es un pedido en efectivo.
    const viejo = toKitchenTickets([row('z', 'confirmed', { delivery_type: 'delivery' })], [])[0];
    expect(viejo.paysCash).toBe(false);
  });

  it('la instrucción no filtra el método de pago', () => {
    // Dice QUÉ HACER, no cómo se pagó. El método sigue sin viajar al ticket.
    const ticket = toKitchenTickets(
      [row('x', 'confirmed', { delivery_type: 'delivery', payment_method: 'cash', subtotal_amount: 44, total_amount: 54 })],
      [],
    )[0];
    expect(JSON.stringify(ticket)).not.toContain('cash');
  });
});

describe('ticket — la etiqueta del comprobante decide el cobro (03-09-2026)', () => {
  const pedido = (over: Partial<RawKitchenOrderRow> = {}): RawKitchenOrderRow => ({
    id: 'order-1',
    order_number: 'ORD-000900',
    status: 'confirmed',
    delivery_type: 'delivery',
    notes: null,
    created_at: '2026-09-03T02:00:00.000Z',
    confirmed_at: '2026-09-03T02:01:00.000Z',
    updated_at: '2026-09-03T02:01:00.000Z',
    payment_method: 'qr',
    subtotal_amount: 60,
    total_amount: 79,
    ...over,
  });

  /** Vista de pago con UN comprobante y la etiqueta que se le puso. */
  const conEtiqueta = (code: string | null, receivedAt = '2026-09-03T02:05:00.000Z') =>
    ({
      attempts: [
        {
          id: 'a1',
          status: 'pending_review',
          proofs: [
            {
              id: 'p1',
              receivedAt,
              amountLabel: code === null ? null : { code, text: code, hint: code },
            },
          ],
        },
      ],
      unlinkedProofs: [],
      hasPendingReview: true,
    }) as never;

  const cobro = (code: string | null) =>
    toKitchenTickets([pedido()], [], { 'order-1': conEtiqueta(code) }, true)[0].deliveryCollect;

  /**
   * EL fallo que trajo esto (03-09-2026).
   *
   * `analysis_amount_label` se añadió en 0028 a la consulta del panel del
   * encargado y NO a la de cocina. Sin ese dato la etiqueta llegaba siempre
   * `null`, así que esta rama no se ejecutaba nunca y TODOS los deliveries
   * salían con COBRAR ENVÍO — incluidos los de quien ya lo había pagado. Se
   * detectó porque el repartidor empezó a cobrar dos veces.
   *
   * La lógica de aquí estaba bien; lo que faltaba era el dato. Por eso el que
   * de verdad protege esto es el test de columnas de `proof-alert.test.ts`, y
   * este solo fija qué debe pasar cuando el dato llega.
   */
  it('pagó el total: no se cobra nada en la puerta', () => {
    expect(cobro('pago_total')).toEqual({
      kind: 'pagado',
      basis: 'comprobante',
      canOverride: false,
    });
  });

  it('pagó solo los productos: se cobra el envío, y es un dato', () => {
    // `basis: 'comprobante'` y no `'pedido'`: la deducción y la lectura
    // coinciden, pero aquí hay una lectura que lo confirma. Sin el matiz, el
    // chip se vería igual que una suposición.
    expect(cobro('pago_productos')).toEqual({
      kind: 'envio',
      amount: 19,
      basis: 'comprobante',
      canOverride: false,
    });
  });

  it('sin etiqueta o con el monto en duda, NO se afirma: se deduce y se dice', () => {
    // Los dos casos que salían con la misma seguridad que un dato confirmado.
    for (const code of [null, 'revisar_monto']) {
      expect(cobro(code), String(code)).toEqual({
        kind: 'envio',
        amount: 19,
        basis: 'pedido',
        canOverride: true,
      });
    }
  });

  it('un dato confirmado NO ofrece el botón de corregir', () => {
    // Un botón junto a una lectura clara solo invita a contradecir un dato
    // bueno. Se ofrece donde hay duda, que es donde sirve.
    expect(cobro('pago_total')?.canOverride).toBe(false);
    expect(cobro('pago_productos')?.canOverride).toBe(false);
    expect(cobro(null)?.canOverride).toBe(true);
  });

  it('con varios intentos manda el comprobante MÁS RECIENTE', () => {
    // `toPaymentView` devuelve los intentos del más reciente al más viejo y los
    // comprobantes de dentro en orden de llegada. Recorrer el array aplanado al
    // revés cogía el más ANTIGUO: un cliente que reenvía porque le rechazaron
    // el primer pago se llevaba en el ticket la etiqueta del pago rechazado.
    const dosIntentos = {
      attempts: [
        {
          id: 'a2',
          status: 'pending_review',
          proofs: [
            {
              id: 'p2',
              receivedAt: '2026-09-03T02:30:00.000Z',
              amountLabel: { code: 'pago_total', text: 'PAGO TOTAL', hint: '' },
            },
          ],
        },
        {
          id: 'a1',
          status: 'rejected',
          proofs: [
            {
              id: 'p1',
              receivedAt: '2026-09-03T02:05:00.000Z',
              amountLabel: { code: 'pago_productos', text: 'PAGO PRODUCTOS', hint: '' },
            },
          ],
        },
      ],
      unlinkedProofs: [],
      hasPendingReview: true,
    } as never;

    const [ticket] = toKitchenTickets([pedido()], [], { 'order-1': dosIntentos }, true);
    expect(ticket.amountLabel?.code).toBe('pago_total');
    expect(ticket.deliveryCollect).toMatchObject({ kind: 'pagado' });
  });
});

describe('ticket — la instrucción de cobro se congela al aceptar el pago (03-09-2026)', () => {
  /**
   * El problema real: los botones de "Ya pagó envío / Cobrar envío" seguían
   * vivos en "Pedidos listos", que es la pantalla abierta mientras se empaca.
   * Dos dianas grandes, a un toque de decir lo contrario de lo que el grupo de
   * reparto ya tenía escrito — porque el aviso sale al ACEPTAR el pago, y
   * cambiar la marca después no reescribe el mensaje enviado.
   */
  const pedido = (over: Partial<RawKitchenOrderRow> = {}): RawKitchenOrderRow =>
    row('order-1', 'confirmed', {
      delivery_type: 'delivery',
      payment_method: 'qr',
      subtotal_amount: 60,
      total_amount: 79,
      ...over,
    });

  /** Vista de pago con un intento en el estado que se pida y su comprobante. */
  const pago = (status: string) =>
    ({
      attempts: [
        {
          id: 'a1',
          status,
          proofs: [{ id: 'p1', receivedAt: '2026-09-03T02:05:00.000Z', amountLabel: null }],
        },
      ],
      unlinkedProofs: [],
      hasPendingReview: status === 'pending_review',
    }) as never;

  const cobro = (status: string, over: Partial<RawKitchenOrderRow> = {}, consultados = true) =>
    toKitchenTickets([pedido(over)], [], { 'order-1': pago(status) }, consultados)[0]
      .deliveryCollect;

  it('con el comprobante en revisión todavía se puede marcar', () => {
    expect(cobro('pending_review')).toEqual({
      kind: 'envio',
      amount: 19,
      basis: 'pedido',
      canOverride: true,
    });
  });

  it('aceptado el comprobante, la instrucción deja de ser tocable', () => {
    // Dice exactamente lo mismo —no cambia lo que hay que cobrar— pero ya no
    // ofrece botón: es lo que salió al grupo de reparto, y en pantalla pasa a
    // ser un título.
    expect(cobro('accepted')).toEqual({
      kind: 'envio',
      amount: 19,
      basis: 'pedido',
      canOverride: false,
    });
  });

  it('la marca de una persona también queda congelada al aceptar', () => {
    for (const marca of [true, false]) {
      expect(cobro('accepted', { delivery_fee_paid: marca })?.canOverride, String(marca)).toBe(
        false,
      );
    }
  });

  it('un pago rechazado no congela nada: todavía no salió ningún aviso', () => {
    expect(cobro('rejected')?.canOverride).toBe(true);
  });

  it('si no se pudieron consultar los pagos, NO se congela', () => {
    // Mismo criterio que el resto del archivo: sin dato no se afirma. Congelar
    // por un fallo de consulta dejaría a quien empaca sin forma de corregir una
    // deducción equivocada, que es lo contrario de lo que el candado protege.
    expect(cobro('accepted', {}, false)?.canOverride).toBe(true);
  });
});

describe('ticket — un pago rechazado saca la comanda del tablero (03-09-2026)', () => {
  /**
   * Rechazar ya bloqueaba INICIAR, pero el ticket se quedaba ocupando su celda
   * con el cartel de por qué no se podía cocinar. En hora punta es una comanda
   * muerta entre las vivas: se lee, se interpreta y se descarta una y otra vez,
   * por cada persona que pasa por la pantalla.
   */
  const AHORA = Date.parse('2026-09-03T22:00:00.000Z');
  const haceMinutos = (n: number) => new Date(AHORA - n * 60_000).toISOString();

  const rechazado = (reviewedAt: string) =>
    ({
      attempts: [
        {
          id: 'a1',
          status: 'rejected',
          reviewedAt,
          proofs: [{ id: 'p1', receivedAt: reviewedAt, amountLabel: null }],
        },
      ],
      unlinkedProofs: [],
      hasPendingReview: false,
    }) as never;

  const tablero = (status: OrderStatus, reviewedAt: string, consultados = true) =>
    toKitchenTickets(
      [row('order-1', status, { payment_method: 'qr' })],
      [],
      { 'order-1': rechazado(reviewedAt) },
      consultados,
      AHORA,
    );

  it('dentro de la ventana de gracia ya no ocupa sitio', () => {
    expect(tablero('confirmed', haceMinutos(1))).toEqual([]);
  });

  it('vencida la ventana, tampoco', () => {
    expect(tablero('confirmed', haceMinutos(60))).toEqual([]);
  });

  it('pero NO se saca lo que ya está en la plancha', () => {
    // Mismo criterio que el filtro de entrada: hacer desaparecer de la pantalla
    // una hamburguesa que ya se está haciendo no la devuelve al refrigerador,
    // solo deja a quien cocina sin saber qué estaba haciendo.
    const tickets = tablero('preparing', haceMinutos(1));
    expect(tickets).toHaveLength(1);
    expect(tickets[0].stage).toBe('in_progress');
  });

  it('si no se pudieron consultar los pagos, la comanda se queda', () => {
    // La puerta lee `unknown` y abre: un fallo de consulta no puede vaciar el
    // tablero. Es el mismo criterio de todo el archivo.
    expect(tablero('confirmed', haceMinutos(1), false)).toHaveLength(1);
  });

  it('el pedido sigue vivo en la base: esto es la VISTA, no una cancelación', () => {
    // La comanda vuelve sola en cuanto el cliente reenvía y se abre un intento
    // nuevo. Por eso se filtra al pintar y no se toca `orders.status`.
    const conReenvio = toKitchenTickets(
      [row('order-1', 'confirmed', { payment_method: 'qr' })],
      [],
      {
        'order-1': {
          attempts: [
            {
              id: 'a2',
              status: 'pending_review',
              reviewedAt: null,
              proofs: [{ id: 'p2', receivedAt: haceMinutos(0), amountLabel: null }],
            },
            {
              id: 'a1',
              status: 'rejected',
              reviewedAt: haceMinutos(5),
              proofs: [{ id: 'p1', receivedAt: haceMinutos(6), amountLabel: null }],
            },
          ],
          unlinkedProofs: [],
          hasPendingReview: true,
        } as never,
      },
      true,
      AHORA,
    );
    expect(conReenvio).toHaveLength(1);
  });
});

/**
 * EL PEDIDO EN EFECTIVO SIN CONFIRMAR NO SE PINTA (05-09-2026).
 *
 * En efectivo el cliente ve el precio del envío DESPUÉS de armar su pedido, y a
 * veces dice que no. Hasta que escribe CONFIRMO, ese pedido no ocupa una celda
 * del tablero: alguien podría empezarlo sin saber que nadie lo va a pagar.
 */
describe('ticket — el efectivo espera su confirmación', () => {
  const filaEfectivo = (over: Partial<RawKitchenOrderRow> = {}): RawKitchenOrderRow =>
    row('x', 'confirmed', {
      delivery_type: 'delivery',
      payment_method: 'cash',
      subtotal_amount: 36,
      total_amount: 63,
      ...over,
    });

  it('sin confirmar, no entra al tablero', () => {
    const tickets = toKitchenTickets([filaEfectivo({ cash_confirmed_at: null })], []);
    expect(tickets).toHaveLength(0);
  });

  it('en cuanto confirma, aparece', () => {
    const tickets = toKitchenTickets(
      [filaEfectivo({ cash_confirmed_at: '2026-09-05T02:00:00.000Z' })],
      [],
    );
    expect(tickets).toHaveLength(1);
  });

  it('una fila anterior a 0036 se sigue viendo', () => {
    // Sin la columna, el pedido nunca tuvo ese paso: tratarlo como pendiente
    // borraría del historial los pedidos en efectivo de las noches anteriores.
    const tickets = toKitchenTickets([filaEfectivo()], []);
    expect(tickets).toHaveLength(1);
  });

  it('el de QR no espera nada: se pinta igual que siempre', () => {
    const tickets = toKitchenTickets(
      [filaEfectivo({ payment_method: 'qr', cash_confirmed_at: null })],
      [],
    );
    expect(tickets).toHaveLength(1);
  });

  it('con la comida ya en la plancha no desaparece', () => {
    // Si ya está en marcha, hacerlo desaparecer no devuelve nada al refrigerador.
    const tickets = toKitchenTickets(
      [filaEfectivo({ status: 'preparing', cash_confirmed_at: null })],
      [],
    );
    expect(tickets).toHaveLength(1);
  });
});
