import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  closeStuckNotification,
  loadOrderLifecycle,
  NotificationPersistenceError,
} from './service';

/**
 * El cierre de avisos que ya no deben salir (14-09-2026), contra un Supabase
 * falso que registra la cadena de la consulta.
 *
 * Lo que se protege: que la escritura sea UNA, condicional sobre el estado leído
 * y sin claim, que no viole la coherencia estado ↔ columnas de 0005, y que la
 * alerta se apague en esa misma sentencia cuando corresponde.
 */

const ORDER_ID = '22222222-2222-4222-8222-222222222222';
const NOW_ISO = '2026-09-14T19:30:00.000Z';

type Filter = [op: 'eq' | 'is', column: string, value: unknown];

function fakeTable(result: { data: unknown; error: unknown }) {
  const calls = {
    table: '',
    update: null as Record<string, unknown> | null,
    selects: [] as string[],
    filters: [] as Filter[],
  };
  const chain = {
    update(values: Record<string, unknown>) {
      calls.update = values;
      return chain;
    },
    select(columns: string) {
      calls.selects.push(columns);
      return chain;
    },
    eq(column: string, value: unknown) {
      calls.filters.push(['eq', column, value]);
      return chain;
    },
    is(column: string, value: unknown) {
      calls.filters.push(['is', column, value]);
      return chain;
    },
    async maybeSingle() {
      return result;
    },
    then<T>(onFulfilled: (r: typeof result) => T, onRejected?: (e: unknown) => T) {
      return Promise.resolve(result).then(onFulfilled, onRejected);
    },
  };
  const client = {
    from(table: string) {
      calls.table = table;
      return chain;
    },
  };
  return { client: client as unknown as SupabaseClient, calls };
}

describe('closeStuckNotification', () => {
  it('pending de un pedido cerrado: failed + terminal, con código y alerta apagada', async () => {
    const sb = fakeTable({ data: [{ id: 'n1' }], error: null });
    const closed = await closeStuckNotification(
      sb.client,
      ORDER_ID,
      'order_received',
      { fromStatus: 'pending', code: 'order_already_closed', silenceAlert: true },
      NOW_ISO,
    );

    expect(closed).toBe(true);
    expect(sb.calls.table).toBe('order_notifications');
    expect(sb.calls.update).toEqual({
      status: 'failed',
      terminal_at: NOW_ISO,
      next_attempt_at: null,
      reconciliation_due_at: null,
      updated_at: NOW_ISO,
      // Un `failed` exige last_error_code (order_notifications_state_coherence).
      last_error_code: 'order_already_closed',
      alert_status: 'failed',
      alert_last_error_code: 'order_already_closed',
    });
  });

  it('solo se aplica sobre la fila en el estado leído, sin claim, sin cierre ni revisión', async () => {
    const sb = fakeTable({ data: [{ id: 'n1' }], error: null });
    await closeStuckNotification(
      sb.client,
      ORDER_ID,
      'confirmation',
      { fromStatus: 'failed', code: 'permanent_failure', silenceAlert: false },
      NOW_ISO,
    );

    expect(sb.calls.filters).toEqual([
      ['eq', 'order_id', ORDER_ID],
      ['eq', 'notification_type', 'confirmation'],
      ['eq', 'status', 'failed'],
      ['is', 'terminal_at', null],
      ['is', 'claim_token', null],
      ['eq', 'manual_review_required', false],
    ]);
    // Devuelve la fila para saber si de verdad se cerró.
    expect(sb.calls.selects).toEqual(['id']);
  });

  it('failed de un pedido vivo: conserva su código y deja la alerta encendida', async () => {
    const sb = fakeTable({ data: [{ id: 'n1' }], error: null });
    await closeStuckNotification(
      sb.client,
      ORDER_ID,
      'confirmation',
      { fromStatus: 'failed', code: 'permanent_failure', silenceAlert: false },
      NOW_ISO,
    );

    // El código original es el que mostrará la alerta: no se pisa.
    expect(sb.calls.update).not.toHaveProperty('last_error_code');
    expect(sb.calls.update).not.toHaveProperty('alert_status');
    expect(sb.calls.update).not.toHaveProperty('alert_last_error_code');
    expect(sb.calls.update).toMatchObject({ status: 'failed', terminal_at: NOW_ISO });
  });

  it('si otro proceso ganó la fila, no se cerró nada y lo dice', async () => {
    const sb = fakeTable({ data: [], error: null });
    const closed = await closeStuckNotification(
      sb.client,
      ORDER_ID,
      'order_received',
      { fromStatus: 'pending', code: 'notification_too_old', silenceAlert: true },
      NOW_ISO,
    );
    expect(closed).toBe(false);
  });

  it('un código fuera del formato de la columna se sustituye, no rompe el UPDATE', async () => {
    const sb = fakeTable({ data: [{ id: 'n1' }], error: null });
    await closeStuckNotification(
      sb.client,
      ORDER_ID,
      'order_received',
      { fromStatus: 'pending', code: 'con espacios y ñ', silenceAlert: true },
      NOW_ISO,
    );
    expect(sb.calls.update).toMatchObject({
      last_error_code: 'closed_stuck',
      alert_last_error_code: 'closed_stuck',
    });
  });

  it('un error de la base sale saneado', async () => {
    const sb = fakeTable({ data: null, error: { message: 'detalle interno' } });
    await expect(
      closeStuckNotification(
        sb.client,
        ORDER_ID,
        'order_received',
        { fromStatus: 'pending', code: 'order_already_closed', silenceAlert: true },
        NOW_ISO,
      ),
    ).rejects.toBeInstanceOf(NotificationPersistenceError);
  });
});

describe('loadOrderLifecycle', () => {
  it('lee solo estado y fecha de creación, por id', async () => {
    const sb = fakeTable({
      data: { status: 'ready', created_at: '2026-09-14T04:05:50.637Z' },
      error: null,
    });
    const lifecycle = await loadOrderLifecycle(sb.client, ORDER_ID);

    expect(lifecycle).toEqual({ status: 'ready', createdAt: '2026-09-14T04:05:50.637Z' });
    expect(sb.calls.table).toBe('orders');
    expect(sb.calls.selects).toEqual(['status, created_at']);
    expect(sb.calls.filters).toEqual([['eq', 'id', ORDER_ID]]);
  });

  it('pedido inexistente o con forma rara → null', async () => {
    expect(await loadOrderLifecycle(fakeTable({ data: null, error: null }).client, ORDER_ID)).toBeNull();
    expect(
      await loadOrderLifecycle(fakeTable({ data: { status: 1 }, error: null }).client, ORDER_ID),
    ).toBeNull();
  });

  it('un error de la base sale saneado', async () => {
    await expect(
      loadOrderLifecycle(fakeTable({ data: null, error: { message: 'x' } }).client, ORDER_ID),
    ).rejects.toBeInstanceOf(NotificationPersistenceError);
  });
});
