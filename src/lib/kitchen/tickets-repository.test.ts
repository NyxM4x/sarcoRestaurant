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

const row = (status: OrderStatus): RawKitchenOrderRow => ({
  id: 'id-1',
  order_number: 'ORD-000001',
  status,
  delivery_type: 'delivery',
  notes: null,
  created_at: new Date(NOW - 600_000).toISOString(),
  confirmed_at: null,
  updated_at: new Date(NOW).toISOString(),
});

describe('repositorio de cocina — lectura del tablero', () => {
  it('acota la consulta a la jornada de SERVICIO y devuelve el reloj del servidor', async () => {
    // NOW = 18:00 UTC = 14:00 en Bolivia, ya pasado el corte del mediodía: la
    // jornada vigente empezó ese mismo día a las 12:00 local (16:00 UTC).
    //
    // Antes esto cortaba por medianoche UTC —las 20:00 hora de Bolivia— y el
    // tablero perdía cada noche los pedidos de las dos primeras horas del
    // servicio justo al dar las 20:00, con la comida todavía sin salir.
    const { source, bounds } = fakeSource({ rows: [row('confirmed')] });
    const board = await createKitchenRepository(source).getBoard(NOW);
    expect(board.serverNow).toBe(NOW);
    expect(bounds[0].since).toBe('2026-08-22T16:00:00.000Z');
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
