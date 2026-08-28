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
      { orderNumber: 'roto', enteredAt: 'no-fecha', stage: 'new', deliveryType: 'pickup', lines: [], notes: null, completedAt: null, amountDueByQr: 0, awaitingPaymentConfirmation: false, payment: null },
      { orderNumber: 'ok', enteredAt: iso(1), stage: 'new', deliveryType: 'pickup', lines: [], notes: null, completedAt: null, amountDueByQr: 0, awaitingPaymentConfirmation: false, payment: null },
    ]);
    expect(tickets.map((t) => t.orderNumber)).toEqual(['ok', 'roto']);
  });

  it('agrupa los ítems por pedido y los adjunta al ticket correcto', () => {
    const items = [item('a', 'Trancapecho', 2), item('b', 'Gaseosa 2 L', 1), item('a', 'Api', 3)];
    expect(groupItemsByOrder(items).a).toEqual([
      { name: 'Trancapecho', quantity: 2, modifiers: [] },
      { name: 'Api', quantity: 3, modifiers: [] },
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
