import { describe, it, expect } from 'vitest';
import { toOrderListItem, toOrderDetail, summarize, isLocationPending, type RawOrderRow } from './order-view';

function raw(over: Partial<RawOrderRow> = {}): RawOrderRow {
  return {
    id: '11111111-2222-3333-4444-555555555555',
    order_number: 'ORD-000123',
    customer_name: 'Ana',
    customer_phone: '59170000000',
    delivery_type: 'delivery',
    status: 'confirmed',
    subtotal_amount: 50,
    delivery_amount: 0,
    total_amount: 50,
    currency: 'BOB',
    notes: 'sin cebolla',
    payment_method: null,
    delivery_address: 'Calle Falsa 123',
    delivery_location_name: 'Casa',
    delivery_latitude: null,
    delivery_longitude: null,
    delivery_pricing: null,
    delivery_quote_status: null,
    delivery_distance_meters: null,
    created_at: '2026-08-06T15:00:00.000Z',
    updated_at: '2026-08-06T15:05:00.000Z',
    confirmed_at: null,
    ...over,
  };
}

const TECHNICAL = ['11111111-2222-3333-4444-555555555555', 'claim_token', 'wamid', 'external_message_id'];

describe('order-view — sanitización', () => {
  it('8. la vista de lista NO expone datos técnicos (id UUID, wamid, etc.)', () => {
    const item = toOrderListItem(raw(), 3, { manualReview: false, notificationIssue: false });
    const dump = JSON.stringify(item);
    for (const t of TECHNICAL) expect(dump).not.toContain(t);
    expect(dump).not.toContain('59170000000'); // teléfono NO va en la lista
    expect(item).not.toHaveProperty('id');
  });

  it('la lista incluye solo campos operativos', () => {
    const item = toOrderListItem(raw({ status: 'preparing' }), 2);
    expect(item.orderNumber).toBe('ORD-000123');
    expect(item.itemCount).toBe(2);
    expect(item.total).toBe(50);
    expect(item.status).toBe('preparing');
  });

  it('el detalle expone contacto operativo pero nunca id/wamid/claim_token', () => {
    const detail = toOrderDetail(raw(), [
      { product_name_snapshot: 'Hamburguesa', unit_price_snapshot: 25, quantity: 2, subtotal: 50 },
    ]);
    const dump = JSON.stringify(detail);
    for (const t of TECHNICAL) expect(dump).not.toContain(t);
    expect(detail).not.toHaveProperty('id');
    expect(detail.contactPhone).toBe('59170000000'); // permitido en detalle
    expect(detail.items[0]).toEqual({ name: 'Hamburguesa', quantity: 2, unitPrice: 25, subtotal: 50 });
  });

  it('la dirección solo aparece en pedidos de delivery', () => {
    expect(toOrderDetail(raw({ delivery_type: 'pickup' }), []).deliveryAddress).toBeNull();
    expect(toOrderDetail(raw({ delivery_type: 'delivery' }), []).deliveryAddress).toBe('Calle Falsa 123');
  });

  it('las coordenadas solo aparecen en delivery (para el enlace a mapa)', () => {
    const pickup = toOrderDetail(raw({ delivery_type: 'pickup', delivery_latitude: -17.7, delivery_longitude: -63.1 }), []);
    expect(pickup.deliveryLatitude).toBeNull();
    expect(pickup.deliveryLongitude).toBeNull();
    const delivery = toOrderDetail(raw({ delivery_type: 'delivery', delivery_latitude: -17.7, delivery_longitude: -63.1 }), []);
    expect(delivery.deliveryLatitude).toBe(-17.7);
    expect(delivery.deliveryLongitude).toBe(-63.1);
  });

  it('ubicación pendiente se deriva de delivery sin coordenadas / awaiting_location', () => {
    expect(isLocationPending(raw({ delivery_type: 'delivery', status: 'awaiting_location' }))).toBe(true);
    expect(isLocationPending(raw({ delivery_type: 'delivery', delivery_latitude: null }))).toBe(true);
    expect(isLocationPending(raw({ delivery_type: 'delivery', delivery_latitude: -17.7, delivery_longitude: -63.1, status: 'confirmed' }))).toBe(false);
    expect(isLocationPending(raw({ delivery_type: 'pickup' }))).toBe(false);
  });

  it('17. resumen con estado vacío es todo cero', () => {
    expect(summarize({}, 0)).toEqual({ today: 0, preparing: 0, ready: 0, completed: 0 });
  });

  it('el resumen agrupa en etapas operativas (sin tarjeta "Confirmados")', () => {
    const s = summarize(
      { awaiting_location: 1, confirmed: 2, preparing: 3, ready: 1, on_the_way: 1, delivered: 4, cancelled: 2 },
      14,
    );
    // En preparación = awaiting_location + confirmed + preparing = 6
    // En camino / Listos = ready + on_the_way = 2 ; Entregados = 4
    expect(s).toEqual({ today: 14, preparing: 6, ready: 2, completed: 4 });
  });

  it('summarize NUNCA cuenta borradores (draft) en ninguna etapa', () => {
    // Aunque llegaran counts con draft, no suman en preparación ni en otra etapa.
    const s = summarize({ draft: 9, confirmed: 1 }, 1);
    expect(s).toEqual({ today: 1, preparing: 1, ready: 0, completed: 0 });
    expect(summarize({ draft: 5 }, 0)).toEqual({ today: 0, preparing: 0, ready: 0, completed: 0 });
  });
});

describe('order-view — método de pago (6D.1)', () => {
  it('la lista expone paymentMethod (cash/qr/null)', () => {
    expect(toOrderListItem(raw({ payment_method: 'cash' }), 1).paymentMethod).toBe('cash');
    expect(toOrderListItem(raw({ payment_method: 'qr' }), 1).paymentMethod).toBe('qr');
    // Histórico / WhatsApp Flow: sin método → null (sin chip).
    expect(toOrderListItem(raw({ payment_method: null }), 1).paymentMethod).toBeNull();
  });

  it('el detalle expone paymentMethod (cash/qr/null)', () => {
    expect(toOrderDetail(raw({ payment_method: 'qr' }), []).paymentMethod).toBe('qr');
    expect(toOrderDetail(raw({ payment_method: 'cash' }), []).paymentMethod).toBe('cash');
    expect(toOrderDetail(raw({ payment_method: null }), []).paymentMethod).toBeNull();
  });
});

describe('order-view — estado de envío dinámico (6D.2D)', () => {
  const dynamic = (over: Partial<RawOrderRow> = {}) =>
    raw({ delivery_type: 'delivery', delivery_pricing: 'dynamic', status: 'awaiting_location', ...over });

  it('lista: dynamic pending sin GPS → deliveryState "Esperando ubicación"', () => {
    const item = toOrderListItem(dynamic({ delivery_quote_status: 'pending' }), 1);
    expect(item.deliveryState?.key).toBe('awaiting_location');
    expect(item.deliveryState?.label).toBe('Esperando ubicación');
  });

  it('lista: dynamic quoted → deliveryState "Envío cotizado"', () => {
    const item = toOrderListItem(
      dynamic({ status: 'confirmed', delivery_quote_status: 'quoted', delivery_latitude: -17.7, delivery_longitude: -63.1 }),
      1,
    );
    expect(item.deliveryState?.key).toBe('quoted');
  });

  it('pickup → deliveryState null (sin chip)', () => {
    expect(toOrderListItem(raw({ delivery_type: 'pickup' }), 1).deliveryState).toBeNull();
    expect(toOrderDetail(raw({ delivery_type: 'pickup' }), []).deliveryState).toBeNull();
  });

  it('legacy delivery (pricing NULL) → deliveryState null', () => {
    expect(toOrderListItem(raw({ delivery_type: 'delivery', delivery_pricing: null }), 1).deliveryState).toBeNull();
    expect(toOrderDetail(raw({ delivery_type: 'delivery', delivery_pricing: null }), []).deliveryState).toBeNull();
  });

  it('isLocationPending: dynamic CON GPS → false (el chip comunica el estado)', () => {
    expect(
      isLocationPending(
        dynamic({ delivery_quote_status: 'pending', delivery_latitude: -17.7, delivery_longitude: -63.1 }),
      ),
    ).toBe(false);
  });

  it('isLocationPending: dynamic SIN GPS → true', () => {
    expect(isLocationPending(dynamic({ delivery_quote_status: 'pending' }))).toBe(true);
  });

  it('isLocationPending: legacy conserva el comportamiento anterior', () => {
    // awaiting_location legacy → true aunque no sea dynamic.
    expect(isLocationPending(raw({ delivery_type: 'delivery', delivery_pricing: null, status: 'awaiting_location' }))).toBe(true);
    // legacy con coords y confirmado → false.
    expect(
      isLocationPending(raw({ delivery_type: 'delivery', delivery_pricing: null, status: 'confirmed', delivery_latitude: -17.7, delivery_longitude: -63.1 })),
    ).toBe(false);
  });

  it('toOrderDetail incluye deliveryDistanceMeters y deliveryState (regresión ORD-000027)', () => {
    const detail = toOrderDetail(
      dynamic({ status: 'confirmed', delivery_quote_status: 'quoted', delivery_distance_meters: 1627, delivery_amount: 10, delivery_latitude: -17.7, delivery_longitude: -63.1 }),
      [],
    );
    expect(detail.deliveryState?.key).toBe('quoted');
    expect(detail.deliveryDistanceMeters).toBe(1627);
  });

  it('detalle: distancia solo en delivery (pickup no la expone)', () => {
    expect(toOrderDetail(raw({ delivery_type: 'pickup', delivery_distance_meters: 999 }), []).deliveryDistanceMeters).toBeNull();
  });
});
