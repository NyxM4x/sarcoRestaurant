import { describe, it, expect } from 'vitest';
import { createKitchenRepository, type KitchenDataSource } from './tickets-repository';
import { kitchenErrorMessage } from './errors';
import type { RawKitchenItemRow, RawKitchenOrderRow } from './ticket-view';
import type { OrderStatus } from '@/types';

const NOW = Date.parse('2026-08-22T18:00:00Z');

interface FakeOptions {
  rows?: RawKitchenOrderRow[];
  items?: RawKitchenItemRow[];
  status?: OrderStatus | null;
  updateResult?: 'updated' | 'conflict' | 'not_found';
}

function fakeSource(opts: FakeOptions = {}) {
  const calls: Array<{ orderNumber: string; from: OrderStatus; to: OrderStatus }> = [];
  const bounds: Array<{ since: string | null; until: string | null }> = [];
  const source: KitchenDataSource = {
    async listBoard(since, until) {
      bounds.push({ since, until });
      return { rows: opts.rows ?? [], items: opts.items ?? [] };
    },
    async getStatus() {
      return opts.status === undefined ? 'confirmed' : opts.status;
    },
    async updateStatus(orderNumber, from, to) {
      calls.push({ orderNumber, from, to });
      return opts.updateResult ?? 'updated';
    },
  };
  return { source, calls, bounds };
}

const row = (
  status: OrderStatus,
  over: Partial<RawKitchenOrderRow> = {},
): RawKitchenOrderRow => ({
  id: 'id-1',
  order_number: 'ORD-000001',
  status,
  delivery_type: 'delivery',
  notes: null,
  created_at: new Date(NOW - 600_000).toISOString(),
  confirmed_at: null,
  updated_at: new Date(NOW).toISOString(),
  ...over,
});

/**
 * Un pedido hecho a las 09:10 hora de Bolivia del mismo día del calendario.
 *
 * Antes del corte del mediodía, así que pertenece a la JORNADA ANTERIOR aunque
 * el cliente lo escribiera esta mañana. Es el caso exacto de `ORD-260902-036`.
 */
const ESTA_MANANA = '2026-08-22T13:10:00.000Z';

describe('repositorio de cocina — lectura del tablero', () => {
  it('consulta desde la jornada ANTERIOR y devuelve el reloj del servidor', async () => {
    // NOW = 18:00 UTC = 14:00 en Bolivia, ya pasado el corte del mediodía: la
    // jornada vigente empezó ese mismo día a las 12:00 local (16:00 UTC).
    //
    // Antes esto cortaba por medianoche UTC —las 20:00 hora de Bolivia— y el
    // tablero perdía cada noche los pedidos de las dos primeras horas del
    // servicio justo al dar las 20:00, con la comida todavía sin salir.
    //
    // Y desde el 03-09-2026 la ventana empieza una jornada antes: el corte se
    // aplica al filtrar, no al consultar, para poder distinguir un pedido vivo
    // de anoche de uno ya despachado. Ver `getBoard`.
    const { source, bounds } = fakeSource({ rows: [row('confirmed')] });
    const board = await createKitchenRepository(source).getBoard(NOW);
    expect(board.serverNow).toBe(NOW);
    expect(bounds[0].since).toBe('2026-08-21T16:00:00.000Z');
    // Abierto por el final: un pedido recién entrado no puede quedarse fuera
    // por un desfase de reloj.
    expect(bounds[0].until).toBeNull();
    expect(board.tickets).toHaveLength(1);
  });

  it('un pedido VIVO de la jornada anterior sigue en el tablero, y se dice', async () => {
    // El fallo que trajo esto: `ORD-260902-036`, pedido y pagado a las 09:10 —
    // antes del corte del mediodía, con el local cerrado—. Se le prometió que
    // sería el primero en salir al abrir a las 18:00, y a esa hora el KDS ya no
    // lo tenía: había cambiado la jornada y con ella la ventana del tablero.
    const { source } = fakeSource({
      rows: [row('confirmed', { created_at: ESTA_MANANA })],
    });
    const board = await createKitchenRepository(source).getBoard(NOW);
    expect(board.tickets).toHaveLength(1);
    expect(board.tickets[0].fromPreviousDay).toBe(true);
  });

  it('lo YA LISTO de la jornada anterior no vuelve a "Pedidos listos"', async () => {
    // El historial dice "completados hoy" y tiene que seguir diciendo la verdad:
    // arrastrar los de anoche lo convertiría en otra cosa. Solo vuelve lo que
    // todavía no ha salido de cocina.
    const { source } = fakeSource({
      rows: [row('ready', { created_at: ESTA_MANANA })],
    });
    const board = await createKitchenRepository(source).getBoard(NOW);
    expect(board.tickets).toEqual([]);
  });

  it('lo de esta jornada no se marca como arrastrado', async () => {
    const { source } = fakeSource({ rows: [row('confirmed')] });
    const board = await createKitchenRepository(source).getBoard(NOW);
    expect(board.tickets[0].fromPreviousDay).toBeUndefined();
  });

  it('una fecha de creación ilegible NO saca el pedido del tablero', async () => {
    // Ante la duda, entra: ver una comanda de más es molesto, perderla no se
    // recupera.
    const { source } = fakeSource({ rows: [row('ready', { created_at: 'no-es-fecha' })] });
    const board = await createKitchenRepository(source).getBoard(NOW);
    expect(board.tickets).toHaveLength(1);
  });
});

describe('repositorio de cocina — escritura con guarda optimista', () => {
  it('INICIAR escribe confirmed → preparing usando el estado leído como guarda', async () => {
    const { source, calls } = fakeSource({ status: 'confirmed' });
    const res = await createKitchenRepository(source).applyAction('ORD-000001', 'start');
    expect(res).toEqual({ ok: true, stage: 'in_progress' });
    expect(calls).toEqual([{ orderNumber: 'ORD-000001', from: 'confirmed', to: 'preparing' }]);
  });

  it('COMPLETAR deja el pedido en `ready`, nunca en on_the_way', async () => {
    const { source, calls } = fakeSource({ status: 'preparing' });
    const res = await createKitchenRepository(source).applyAction('ORD-000001', 'complete');
    expect(res).toEqual({ ok: true, stage: 'done' });
    expect(calls[0].to).toBe('ready');
  });

  it('los retrocesos que el panel del encargado prohíbe aquí sí funcionan', async () => {
    const retorno = fakeSource({ status: 'preparing' });
    expect(await createKitchenRepository(retorno.source).applyAction('ORD-1', 'return')).toEqual({
      ok: true,
      stage: 'new',
    });
    expect(retorno.calls[0].to).toBe('confirmed');

    const recall = fakeSource({ status: 'ready' });
    expect(await createKitchenRepository(recall.source).applyAction('ORD-1', 'recall')).toEqual({
      ok: true,
      stage: 'in_progress',
    });
    expect(recall.calls[0].to).toBe('preparing');
  });

  it('un conflicto (otro cocinero se adelantó) no rompe nada y se comunica', async () => {
    const { source } = fakeSource({ status: 'confirmed', updateResult: 'conflict' });
    const res = await createKitchenRepository(source).applyAction('ORD-1', 'start');
    expect(res).toEqual({ ok: false, reason: 'conflict' });
  });
});

describe('repositorio de cocina — fallos traducidos al cocinero', () => {
  it('devolver a cocina un pedido ya despachado dice "El pedido ya salió a reparto"', async () => {
    for (const status of ['on_the_way', 'delivered'] as const) {
      const { source, calls } = fakeSource({ status });
      const res = await createKitchenRepository(source).applyAction('ORD-1', 'recall');
      expect(res).toEqual({ ok: false, reason: 'dispatched' });
      expect(kitchenErrorMessage('dispatched')).toBe('El pedido ya salió a reparto');
      // Y no se intenta ninguna escritura sobre un pedido que ya salió.
      expect(calls).toEqual([]);
    }
  });

  it('un pedido cancelado es terminal y un inexistente se reporta como tal', async () => {
    const cancelado = fakeSource({ status: 'cancelled' });
    expect(await createKitchenRepository(cancelado.source).applyAction('ORD-1', 'start')).toEqual({
      ok: false,
      reason: 'cancelled',
    });

    const ausente = fakeSource({ status: null });
    expect(await createKitchenRepository(ausente.source).applyAction('ORD-1', 'start')).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });

  it('un pedido que aún no es cocinable no se toca desde la cocina', async () => {
    for (const status of ['draft', 'awaiting_location'] as const) {
      const { source, calls } = fakeSource({ status });
      expect(await createKitchenRepository(source).applyAction('ORD-1', 'start')).toEqual({
        ok: false,
        reason: 'not_found',
      });
      expect(calls).toEqual([]);
    }
  });

  it('una acción inventada o un número de pedido inválido se rechazan antes de tocar la base', async () => {
    const invalida = fakeSource({ status: 'confirmed' });
    expect(await createKitchenRepository(invalida.source).applyAction('ORD-1', 'deliver')).toEqual({
      ok: false,
      reason: 'invalid_action',
    });
    expect(invalida.calls).toEqual([]);

    const raro = fakeSource({ status: 'confirmed' });
    expect(await createKitchenRepository(raro.source).applyAction("ORD'; DROP--", 'start')).toEqual({
      ok: false,
      reason: 'not_found',
    });
    expect(raro.calls).toEqual([]);
  });

  it('saltar etapas se rechaza contra el estado real leído en ese momento', async () => {
    const { source, calls } = fakeSource({ status: 'confirmed' });
    expect(await createKitchenRepository(source).applyAction('ORD-1', 'complete')).toEqual({
      ok: false,
      reason: 'invalid_transition',
    });
    expect(calls).toEqual([]);
  });
});

// ── La puerta del pago sobre INICIAR (0028) ─────────────────────────────────
//
// Antes, `applyAction` no consultaba el pago en ningún punto: se podía pulsar
// INICIAR sin haber mirado el comprobante, o después de haberlo rechazado. El
// agente, mientras tanto, le prometía al cliente que "la cocina empieza cuando
// el pago está confirmado".

import type { PaymentAttempt, PaymentMethod } from '@/types';
import { REJECTION_GRACE_MS } from '@/lib/payment-proof/payment-gate';

/** Fuente con pago: `paymentFor` responde de verdad. */
function fuenteConPago(
  attempts: Array<Partial<PaymentAttempt>>,
  paymentMethod: PaymentMethod | null = 'qr',
  fallar = false,
) {
  const escrituras: Array<{ from: OrderStatus; to: OrderStatus }> = [];
  const source: KitchenDataSource = {
    async listBoard() {
      return { rows: [], items: [] };
    },
    async listPayments() {
      return {
        attempts: attempts.map((a, i) => ({
          id: `att-${i}`,
          order_id: 'id-1',
          review_status: 'pending_review',
          opened_at: new Date(NOW - 600_000).toISOString(),
          reviewed_at: null,
          ...a,
        })) as unknown as PaymentAttempt[],
        proofs: [],
      };
    },
    async paymentFor() {
      if (fallar) throw new Error('supabase caído');
      return { orderId: 'id-1', paymentMethod, rows: await this.listPayments!(['id-1']) };
    },
    async getStatus() {
      return 'confirmed';
    },
    async updateStatus(_n, from, to) {
      escrituras.push({ from, to });
      return 'updated';
    },
  };
  return { source, escrituras };
}

describe('repositorio de cocina — la puerta del pago', () => {
  it('con el pago ACEPTADO, INICIAR arranca', async () => {
    const { source, escrituras } = fuenteConPago([
      { review_status: 'accepted', reviewed_at: new Date(NOW - 1000).toISOString() },
    ]);
    const res = await createKitchenRepository(source).applyAction('ORD-000001', 'start', NOW);
    expect(res).toEqual({ ok: true, stage: 'in_progress' });
    expect(escrituras).toEqual([{ from: 'confirmed', to: 'preparing' }]);
  });

  it('con el comprobante SIN revisar, INICIAR se bloquea y no escribe nada', async () => {
    const { source, escrituras } = fuenteConPago([{ review_status: 'pending_review' }]);
    const res = await createKitchenRepository(source).applyAction('ORD-000001', 'start', NOW);
    expect(res).toEqual({ ok: false, reason: 'payment_pending' });
    expect(escrituras).toEqual([]);
  });

  it('con el comprobante RECHAZADO, INICIAR se bloquea', async () => {
    const { source, escrituras } = fuenteConPago([
      { review_status: 'rejected', reviewed_at: new Date(NOW - 60_000).toISOString() },
    ]);
    const res = await createKitchenRepository(source).applyAction('ORD-000001', 'start', NOW);
    expect(res).toEqual({ ok: false, reason: 'payment_rejected' });
    expect(escrituras).toEqual([]);
  });

  it('vencida la ventana de gracia, el motivo lo dice', async () => {
    const { source } = fuenteConPago([
      {
        review_status: 'rejected',
        reviewed_at: new Date(NOW - REJECTION_GRACE_MS - 1000).toISOString(),
      },
    ]);
    const res = await createKitchenRepository(source).applyAction('ORD-000001', 'start', NOW);
    expect(res).toEqual({ ok: false, reason: 'payment_expired' });
  });

  it('un pedido en EFECTIVO arranca sin pedir comprobante', async () => {
    const { source, escrituras } = fuenteConPago([], 'cash');
    const res = await createKitchenRepository(source).applyAction('ORD-000001', 'start', NOW);
    expect(res).toEqual({ ok: true, stage: 'in_progress' });
    expect(escrituras).toHaveLength(1);
  });

  it('si la consulta del pago FALLA, se permite iniciar', async () => {
    // Cerrar aquí detendría la cocina entera por un fallo de la base. El aviso
    // vive en el tablero; la puerta no puede ser la que pare el servicio.
    const { source, escrituras } = fuenteConPago([{ review_status: 'pending_review' }], 'qr', true);
    const res = await createKitchenRepository(source).applyAction('ORD-000001', 'start', NOW);
    expect(res).toEqual({ ok: true, stage: 'in_progress' });
    expect(escrituras).toHaveLength(1);
  });

  it('la puerta NO frena las demás acciones de un pedido ya empezado', async () => {
    // `complete` sobre algo que ya está en la plancha: bloquearlo dejaría la
    // comida hecha y el ticket sin poder cerrarse.
    const { source, escrituras } = fuenteConPago([{ review_status: 'pending_review' }]);
    const repo = createKitchenRepository({ ...source, getStatus: async () => 'preparing' });
    const res = await repo.applyAction('ORD-000001', 'complete', NOW);
    expect(res).toEqual({ ok: true, stage: 'done' });
    expect(escrituras).toEqual([{ from: 'preparing', to: 'ready' }]);
  });

  it('sin `paymentFor` cableado, el KDS se comporta como antes', async () => {
    // Compatibilidad: un adaptador viejo no bloquea nada.
    const { source, calls } = fakeSource();
    const res = await createKitchenRepository(source).applyAction('ORD-000001', 'start', NOW);
    expect(res).toEqual({ ok: true, stage: 'in_progress' });
    expect(calls).toHaveLength(1);
  });
});
