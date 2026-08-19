import { describe, it, expect } from 'vitest';
import {
  ensureLocationRequest,
  type LocationOrderRow,
  type LocationRequestStore,
  type LocationSender,
} from './location';

const ORDER_ID = '9f1c8f2e-1a2b-4c3d-8e4f-5a6b7c8d9e0f';

function row(overrides: Partial<LocationOrderRow> = {}): LocationOrderRow {
  return {
    id: ORDER_ID,
    status: 'awaiting_location',
    customer_phone: '59170000001',
    location_request_message_id: null,
    ...overrides,
  };
}

class FakeLocationStore implements LocationRequestStore {
  row: LocationOrderRow | null;
  /** Fuerza 'no_rows' en el guardado para simular carrera perdida. */
  loseSaveRace = false;
  /** Fila que verá la relectura tras perder la carrera. */
  raceWinnerRow: LocationOrderRow | null = null;
  saveCalls = 0;

  constructor(r: LocationOrderRow | null) {
    this.row = r;
  }

  async findForLocationRequest(): Promise<LocationOrderRow | null> {
    if (this.loseSaveRace && this.saveCalls > 0) return this.raceWinnerRow;
    return this.row ? { ...this.row } : null;
  }

  async saveLocationRequestMessageId(_orderId: string, wamid: string) {
    this.saveCalls += 1;
    if (this.loseSaveRace) return 'no_rows' as const;
    if (
      this.row &&
      this.row.status === 'awaiting_location' &&
      this.row.location_request_message_id === null
    ) {
      this.row = { ...this.row, location_request_message_id: wamid };
      return 'saved' as const;
    }
    return 'no_rows' as const;
  }
}

/** Sender falso que registra llamadas. */
function fakeSender(
  result: Awaited<ReturnType<LocationSender>>,
): { fn: LocationSender; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    fn: async (phone: string) => {
      calls.push(phone);
      return result;
    },
  };
}

const SENT_OK = { ok: true as const, wamid: 'wamid.LOC_REQ_1' };

describe('ensureLocationRequest', () => {
  it('delivery awaiting_location: envía una vez y guarda el wamid', async () => {
    const store = new FakeLocationStore(row());
    const sender = fakeSender(SENT_OK);
    const res = await ensureLocationRequest(store, sender.fn, ORDER_ID);
    expect(res).toEqual({ result: 'requested' });
    expect(sender.calls).toEqual(['59170000001']); // teléfono del pedido, no del Flow
    expect(store.row?.location_request_message_id).toBe('wamid.LOC_REQ_1');
    expect(store.saveCalls).toBe(1);
  });

  it('pedido no awaiting_location (pickup confirmado): not_applicable, sin llamar al sender', async () => {
    const store = new FakeLocationStore(row({ status: 'confirmed' }));
    const sender = fakeSender(SENT_OK);
    const res = await ensureLocationRequest(store, sender.fn, ORDER_ID);
    expect(res).toEqual({ result: 'not_applicable' });
    expect(sender.calls).toHaveLength(0);
  });

  it('pedido inexistente: not_applicable', async () => {
    const store = new FakeLocationStore(null);
    const sender = fakeSender(SENT_OK);
    const res = await ensureLocationRequest(store, sender.fn, ORDER_ID);
    expect(res).toEqual({ result: 'not_applicable' });
    expect(sender.calls).toHaveLength(0);
  });

  it('ya tiene location_request_message_id: already_requested, sin reenviar', async () => {
    const store = new FakeLocationStore(row({ location_request_message_id: 'wamid.PREV' }));
    const sender = fakeSender(SENT_OK);
    const res = await ensureLocationRequest(store, sender.fn, ORDER_ID);
    expect(res).toEqual({ result: 'already_requested' });
    expect(sender.calls).toHaveLength(0);
    expect(store.row?.location_request_message_id).toBe('wamid.PREV'); // no sobrescrito
  });

  it('fallo de envío: send_failed, sin guardar nada', async () => {
    const store = new FakeLocationStore(row());
    const sender = fakeSender({ ok: false, error: 'http_error', status: 500 });
    const res = await ensureLocationRequest(store, sender.fn, ORDER_ID);
    expect(res).toEqual({ result: 'send_failed', error: 'http_error' });
    expect(store.saveCalls).toBe(0);
    expect(store.row?.location_request_message_id).toBeNull();
  });

  it('timeout del envío: send_failed', async () => {
    const store = new FakeLocationStore(row());
    const sender = fakeSender({ ok: false, error: 'timeout' });
    const res = await ensureLocationRequest(store, sender.fn, ORDER_ID);
    expect(res).toEqual({ result: 'send_failed', error: 'timeout' });
  });

  it('carrera perdida en el guardado: relee, no sobrescribe y devuelve already_requested', async () => {
    const store = new FakeLocationStore(row());
    store.loseSaveRace = true;
    store.raceWinnerRow = row({ location_request_message_id: 'wamid.WINNER' });
    const sender = fakeSender(SENT_OK);
    const res = await ensureLocationRequest(store, sender.fn, ORDER_ID);
    expect(res).toEqual({ result: 'already_requested' });
    // El wamid del ganador no fue sobrescrito por esta ejecución.
    expect(store.raceWinnerRow.location_request_message_id).toBe('wamid.WINNER');
  });

  it('guardado en no_rows sin ganador visible: send_failed (save_conflict)', async () => {
    const store = new FakeLocationStore(row());
    store.loseSaveRace = true;
    store.raceWinnerRow = row(); // relee sin wamid (estado inconsistente)
    const sender = fakeSender(SENT_OK);
    const res = await ensureLocationRequest(store, sender.fn, ORDER_ID);
    expect(res).toEqual({ result: 'send_failed', error: 'save_conflict' });
  });
});
