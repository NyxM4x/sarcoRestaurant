import { describe, it, expect } from 'vitest';
import {
  confirmOrderDraft,
  type ConfirmIfDraftResult,
  type DraftOrderRow,
  type OrderConfirmationStore,
} from './confirm';

const DRAFT_ID = '9f1c8f2e-1a2b-4c3d-8e4f-5a6b7c8d9e0f';
const FLOW_TOKEN = `order_${DRAFT_ID}`;
const PHONE = '59170000000';
const MSG_ID = 'wamid.AAA';

function draft(overrides: Partial<DraftOrderRow> = {}): DraftOrderRow {
  return {
    id: DRAFT_ID,
    order_number: 'ORD-000001',
    flow_token: FLOW_TOKEN,
    customer_phone: PHONE,
    delivery_type: 'pickup',
    status: 'draft',
    source_message_id: null,
    ...overrides,
  };
}

/** Store en memoria configurable para probar la lógica de confirmación. */
class FakeConfirmStore implements OrderConfirmationStore {
  row: DraftOrderRow | null;
  itemCount = 1;
  /** Fuerza el resultado del UPDATE atómico para simular carreras. */
  forceConfirm?: 'null' | 'unique';
  /** Fila devuelta por findById tras un confirm forzado a 'null' (re-lectura). */
  reReadRow: DraftOrderRow | null | undefined;
  confirmCalls = 0;

  constructor(row: DraftOrderRow | null) {
    this.row = row;
  }

  /** Último confirmedAt solicitado al store (para verificar el sellado). */
  lastConfirmedAt: string | undefined;

  async findById(id: string): Promise<DraftOrderRow | null> {
    if (this.confirmCalls > 0 && this.reReadRow !== undefined) return this.reReadRow;
    return this.row && this.row.id === id ? { ...this.row } : null;
  }

  async countItems(): Promise<number> {
    return this.itemCount;
  }

  async confirmIfDraft(input: {
    orderId: string;
    newStatus: 'confirmed' | 'awaiting_location';
    sourceMessageId: string;
    confirmedAt: string;
  }): Promise<ConfirmIfDraftResult> {
    this.confirmCalls += 1;
    this.lastConfirmedAt = input.confirmedAt;
    if (this.forceConfirm === 'unique') return { uniqueViolation: true };
    if (this.forceConfirm === 'null') return null;
    if (this.row && this.row.status === 'draft' && this.row.source_message_id === null) {
      this.row = {
        ...this.row,
        status: input.newStatus,
        source_message_id: input.sourceMessageId,
      };
      return { ...this.row };
    }
    return null;
  }
}

function input(overrides: Partial<Parameters<typeof confirmOrderDraft>[1]> = {}) {
  return {
    orderDraftId: DRAFT_ID,
    flowToken: FLOW_TOKEN,
    customerPhoneDigits: PHONE,
    sourceMessageId: MSG_ID,
    ...overrides,
  };
}

describe('confirmOrderDraft', () => {
  it('confirma un pickup -> confirmed', async () => {
    const store = new FakeConfirmStore(draft({ delivery_type: 'pickup' }));
    const res = await confirmOrderDraft(store, input());
    expect(res.result).toBe('confirmed');
    if (res.result === 'confirmed') {
      expect(res.order.status).toBe('confirmed');
      expect(res.order.order_number).toBe('ORD-000001');
    }
    expect(store.row?.source_message_id).toBe(MSG_ID);
  });

  it('pickup sigue sellando confirmed_at al confirmar (sin cambios en 5.2D.5A.1)', async () => {
    const store = new FakeConfirmStore(draft({ delivery_type: 'pickup' }));
    const before = Date.now();
    const res = await confirmOrderDraft(store, input());
    const after = Date.now();

    expect(res.result).toBe('confirmed');
    expect(store.lastConfirmedAt).toBeDefined();
    const stamped = Date.parse(store.lastConfirmedAt!);
    expect(stamped).toBeGreaterThanOrEqual(before);
    expect(stamped).toBeLessThanOrEqual(after);
  });

  it('deja un delivery en awaiting_location', async () => {
    const store = new FakeConfirmStore(draft({ delivery_type: 'delivery' }));
    const res = await confirmOrderDraft(store, input());
    expect(res.result).toBe('confirmed');
    if (res.result === 'confirmed') expect(res.order.status).toBe('awaiting_location');
  });

  it('borrador inexistente -> not_found', async () => {
    const store = new FakeConfirmStore(null);
    const res = await confirmOrderDraft(store, input());
    expect(res.result).toBe('not_found');
  });

  it('flow_token distinto -> flow_token_mismatch', async () => {
    const store = new FakeConfirmStore(draft({ flow_token: `order_${'0'.repeat(8)}-0000-4000-8000-000000000000` }));
    const res = await confirmOrderDraft(store, input());
    expect(res.result).toBe('flow_token_mismatch');
  });

  it('teléfono distinto -> phone_mismatch', async () => {
    const store = new FakeConfirmStore(draft({ customer_phone: '59171111111' }));
    const res = await confirmOrderDraft(store, input());
    expect(res.result).toBe('phone_mismatch');
  });

  it('pedido sin order_items -> empty_order', async () => {
    const store = new FakeConfirmStore(draft());
    store.itemCount = 0;
    const res = await confirmOrderDraft(store, input());
    expect(res.result).toBe('empty_order');
  });

  it('mismo source_message_id -> already_confirmed', async () => {
    const store = new FakeConfirmStore(
      draft({ status: 'confirmed', source_message_id: MSG_ID }),
    );
    const res = await confirmOrderDraft(store, input());
    expect(res.result).toBe('already_confirmed');
  });

  it('ya confirmado con otro source_message_id -> already_confirmed_by_another_message', async () => {
    const store = new FakeConfirmStore(
      draft({ status: 'confirmed', source_message_id: 'wamid.OTHER' }),
    );
    const res = await confirmOrderDraft(store, input());
    expect(res.result).toBe('already_confirmed_by_another_message');
  });

  it('conflicto por source_message_id usado en otro pedido -> conflict', async () => {
    const store = new FakeConfirmStore(draft());
    store.forceConfirm = 'unique';
    const res = await confirmOrderDraft(store, input());
    expect(res.result).toBe('conflict');
    if (res.result === 'conflict') expect(res.reason).toBe('source_message_id_conflict');
  });

  it('carrera perdida con mismo mensaje -> already_confirmed (relee)', async () => {
    const store = new FakeConfirmStore(draft());
    store.forceConfirm = 'null';
    store.reReadRow = draft({ status: 'confirmed', source_message_id: MSG_ID });
    const res = await confirmOrderDraft(store, input());
    expect(res.result).toBe('already_confirmed');
  });

  it('carrera perdida con otro mensaje -> already_confirmed_by_another_message', async () => {
    const store = new FakeConfirmStore(draft());
    store.forceConfirm = 'null';
    store.reReadRow = draft({ status: 'confirmed', source_message_id: 'wamid.OTHER' });
    const res = await confirmOrderDraft(store, input());
    expect(res.result).toBe('already_confirmed_by_another_message');
  });
});
