import { describe, it, expect } from 'vitest';
import { boardToShow, DEGRADED_GRACE_MS, type LastGoodBoard } from './degraded-board';
import type { KitchenTicket } from './ticket-view';
import type { KdsStage } from './kds-status';

const NOW = Date.parse('2026-09-14T03:00:00Z');

function ticket(orderNumber: string, over: Partial<KitchenTicket> = {}): KitchenTicket {
  return {
    orderNumber,
    enteredAt: new Date(NOW - 600_000).toISOString(),
    stage: 'new' as KdsStage,
    deliveryType: 'delivery',
    paysCash: false,
    lines: [{ name: 'Trancapecho', quantity: 1, modifiers: [], category: 'plato' as const }],
    notes: null,
    completedAt: null,
    amountDueByQr: 18,
    awaitingPaymentConfirmation: false,
    payment: null,
    gate: { state: 'not_required' as const, canStart: true, graceEndsAtMs: null },
    amountLabel: null,
    deliveryCollect: null,
    ...over,
  };
}

/** Lo que devuelve el servidor sin pagos: la puerta abre con `unknown`. */
const sinVerificar = { state: 'unknown' as const, canStart: true, graceEndsAtMs: null };

const bueno = (tickets: KitchenTicket[], haceMs = 10_000): LastGoodBoard => ({
  tickets,
  atMs: NOW - haceMs,
});

const numeros = (tickets: KitchenTicket[]) => tickets.map((t) => t.orderNumber);

describe('tablero degradado — lo que pinta la tablet', () => {
  it('con los pagos leídos, la respuesta se pinta tal cual', () => {
    const board = { tickets: [ticket('ORD-260913-020')], paymentsAvailable: true };
    expect(boardToShow(board, null, NOW)).toEqual({ tickets: board.tickets, paymentsAvailable: true });
  });

  it('un QR sin comprobante que no estaba a la vista NO aparece por una respuesta degradada', () => {
    // El caso de `ORD-260913-017` y `-021`: nunca pagados, fuera del tablero en
    // cada ciclo bueno, y dentro en cada ciclo sin pagos.
    const antes = bueno([ticket('ORD-260913-020')]);
    const degradada = {
      tickets: [ticket('ORD-260913-017', { gate: sinVerificar }), ticket('ORD-260913-020', { gate: sinVerificar })],
      paymentsAvailable: false,
    };
    const visto = boardToShow(degradada, antes, NOW);
    expect(numeros(visto.tickets)).toEqual(['ORD-260913-020']);
    expect(visto.paymentsAvailable).toBe(true);
  });

  it('lo que ya estaba sigue, con la etapa de ahora y el pago que se le conocía', () => {
    const pagado = ticket('ORD-260913-020', {
      gate: { state: 'accepted' as never, canStart: true, graceEndsAtMs: null },
      awaitingPaymentConfirmation: false,
    });
    const degradada = {
      tickets: [ticket('ORD-260913-020', { stage: 'in_progress', gate: sinVerificar, awaitingPaymentConfirmation: false })],
      paymentsAvailable: false,
    };
    const [t] = boardToShow(degradada, bueno([pagado]), NOW).tickets;
    expect(t.stage).toBe('in_progress');
    expect(t.gate).toEqual(pagado.gate);
  });

  it('en efectivo o ya empezado entra aunque no estuviera: no depende de un comprobante', () => {
    const degradada = {
      tickets: [
        ticket('ORD-260913-023', { paysCash: true }),
        ticket('ORD-260913-024', { stage: 'in_progress' }),
        ticket('ORD-260913-029'),
      ],
      paymentsAvailable: false,
    };
    const visto = boardToShow(degradada, bueno([]), NOW);
    expect(numeros(visto.tickets)).toEqual(['ORD-260913-023', 'ORD-260913-024']);
  });

  it('lo que el servidor ya no devuelve no se resucita desde la lectura anterior', () => {
    const degradada = { tickets: [], paymentsAvailable: false };
    expect(boardToShow(degradada, bueno([ticket('ORD-260913-020')]), NOW).tickets).toEqual([]);
  });

  it('sin ninguna respuesta buena todavía, entra todo y se avisa', () => {
    // Carga inicial ya degradada: no hay nada conocido que proteger, y quedarse
    // sin comandas es peor que ver una de más.
    const degradada = { tickets: [ticket('ORD-260913-017')], paymentsAvailable: false };
    expect(boardToShow(degradada, null, NOW)).toEqual({
      tickets: degradada.tickets,
      paymentsAvailable: false,
    });
  });

  it('con la última respuesta buena más vieja que la gracia, vuelve la regla de siempre', () => {
    const degradada = { tickets: [ticket('ORD-260913-017')], paymentsAvailable: false };
    const viejo = bueno([], DEGRADED_GRACE_MS + 1);
    expect(boardToShow(degradada, viejo, NOW)).toEqual({
      tickets: degradada.tickets,
      paymentsAvailable: false,
    });
  });
});
