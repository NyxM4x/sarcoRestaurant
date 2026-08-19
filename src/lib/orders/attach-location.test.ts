import { describe, it, expect } from 'vitest';
import {
  attachLocation,
  type AttachLocationStore,
  type LocationOrderRow,
} from './attach-location';

const ORDER_ID = '9f1c8f2e-1a2b-4c3d-8e4f-5a6b7c8d9e0f';
const CONTEXT_ID = 'wamid.LOCATION_REQUEST_1';
const PHONE = '59170000001';

function row(overrides: Partial<LocationOrderRow> = {}): LocationOrderRow {
  return {
    id: ORDER_ID,
    order_number: 'ORD-000002',
    status: 'awaiting_location',
    customer_phone: PHONE,
    location_request_message_id: CONTEXT_ID,
    delivery_latitude: null,
    delivery_longitude: null,
    confirmed_at: null,
    delivery_pricing: null,
    ...overrides,
  };
}

function input(overrides: Partial<Parameters<typeof attachLocation>[1]> = {}) {
  return {
    contextId: CONTEXT_ID,
    customerPhoneDigits: PHONE,
    latitude: -17.7833,
    longitude: -63.1821,
    address: 'Av. Siempre Viva 123',
    name: 'Casa',
    ...overrides,
  };
}

class FakeAttachStore implements AttachLocationStore {
  row: LocationOrderRow | null;
  /** Fuerza 'no_rows' (pierde la carrera) en el guardado atómico. */
  loseRace = false;
  /** Fila que verá la relectura tras perder la carrera. */
  raceWinnerRow: LocationOrderRow | null | undefined;
  attachCalls = 0;

  constructor(r: LocationOrderRow | null) {
    this.row = r;
  }

  async findByLocationRequestMessageId(): Promise<LocationOrderRow | null> {
    if (this.loseRace && this.attachCalls > 0 && this.raceWinnerRow !== undefined) {
      return this.raceWinnerRow;
    }
    return this.row ? { ...this.row } : null;
  }

  /** Último confirmedAt que la capa pura pidió persistir (coalesce ya aplicado). */
  lastConfirmedAt: string | undefined;

  async attachIfPending(input: {
    orderId: string;
    contextId: string;
    latitude: number;
    longitude: number;
    address: string | null;
    name: string | null;
    confirmedAt: string;
  }): Promise<LocationOrderRow | null> {
    this.attachCalls += 1;
    this.lastConfirmedAt = input.confirmedAt;
    if (this.loseRace) return null;
    if (
      this.row &&
      this.row.status === 'awaiting_location' &&
      this.row.delivery_latitude === null &&
      this.row.delivery_longitude === null
    ) {
      this.row = {
        ...this.row,
        delivery_latitude: input.latitude,
        delivery_longitude: input.longitude,
        status: 'confirmed',
        // Espeja el UPDATE atómico real: SET …, confirmed_at = input.confirmedAt.
        confirmed_at: input.confirmedAt,
      };
      return { ...this.row };
    }
    return null;
  }

  /** 6D.2C: guarda GPS SIN confirmar (status permanece awaiting_location). */
  async attachIfPendingDynamic(input: {
    orderId: string;
    contextId: string;
    latitude: number;
    longitude: number;
    address: string | null;
    name: string | null;
  }): Promise<LocationOrderRow | null> {
    this.attachCalls += 1;
    if (this.loseRace) return null;
    if (
      this.row &&
      this.row.status === 'awaiting_location' &&
      this.row.delivery_latitude === null &&
      this.row.delivery_longitude === null
    ) {
      this.row = {
        ...this.row,
        delivery_latitude: input.latitude,
        delivery_longitude: input.longitude,
        // NO toca status ni confirmed_at: sigue awaiting_location.
      };
      return { ...this.row };
    }
    return null;
  }
}

describe('attachLocation', () => {
  it('ubicación válida correlacionada por context.id: attached, status confirmed', async () => {
    const store = new FakeAttachStore(row());
    const res = await attachLocation(store, input());
    expect(res.result).toBe('attached');
    if (res.result === 'attached') {
      expect(res.order).toEqual({ id: ORDER_ID, order_number: 'ORD-000002', status: 'confirmed' });
    }
    expect(store.row?.delivery_latitude).toBe(-17.7833);
    expect(store.row?.status).toBe('confirmed');
  });

  it('normaliza teléfono con +, espacios y guiones antes de comparar', async () => {
    const store = new FakeAttachStore(row({ customer_phone: '+591 7000-0001' }));
    const res = await attachLocation(store, input({ customerPhoneDigits: '59170000001' }));
    expect(res.result).toBe('attached');
  });

  it('pedido no encontrado -> not_found', async () => {
    const store = new FakeAttachStore(null);
    const res = await attachLocation(store, input());
    expect(res).toEqual({ result: 'not_found' });
  });

  it('teléfono distinto -> phone_mismatch', async () => {
    const store = new FakeAttachStore(row({ customer_phone: '59179999999' }));
    const res = await attachLocation(store, input());
    expect(res).toEqual({ result: 'phone_mismatch' });
  });

  it('status distinto de awaiting_location -> invalid_status', async () => {
    const store = new FakeAttachStore(row({ status: 'confirmed', delivery_latitude: null }));
    const res = await attachLocation(store, input());
    expect(res).toEqual({ result: 'invalid_status' });
  });

  it('ubicación ya guardada con las MISMAS coordenadas -> already_attached (idempotente)', async () => {
    const store = new FakeAttachStore(
      row({ status: 'confirmed', delivery_latitude: -17.7833, delivery_longitude: -63.1821 }),
    );
    const res = await attachLocation(store, input());
    expect(res.result).toBe('already_attached');
    expect(store.attachCalls).toBe(0); // no se intenta reescribir
  });

  it('segunda ubicación con coordenadas DIFERENTES -> location_conflict, sin sobrescribir', async () => {
    const store = new FakeAttachStore(
      row({ status: 'confirmed', delivery_latitude: -17.7833, delivery_longitude: -63.1821 }),
    );
    const res = await attachLocation(store, input({ latitude: 1, longitude: 1 }));
    expect(res).toEqual({ result: 'location_conflict' });
    expect(store.row?.delivery_latitude).toBe(-17.7833); // sin cambios
  });

  it('carrera perdida: releída muestra la MISMA ubicación ganadora -> already_attached', async () => {
    const store = new FakeAttachStore(row());
    store.loseRace = true;
    store.raceWinnerRow = row({
      status: 'confirmed',
      delivery_latitude: -17.7833,
      delivery_longitude: -63.1821,
    });
    const res = await attachLocation(store, input());
    expect(res.result).toBe('already_attached');
  });

  it('carrera perdida: releída muestra ubicación DIFERENTE -> location_conflict', async () => {
    const store = new FakeAttachStore(row());
    store.loseRace = true;
    store.raceWinnerRow = row({
      status: 'confirmed',
      delivery_latitude: 5,
      delivery_longitude: 5,
    });
    const res = await attachLocation(store, input());
    expect(res).toEqual({ result: 'location_conflict' });
  });

  it('carrera perdida sin ganador visible (estado inconsistente) -> concurrent_update', async () => {
    const store = new FakeAttachStore(row());
    store.loseRace = true;
    store.raceWinnerRow = row(); // sigue sin ubicación
    const res = await attachLocation(store, input());
    expect(res).toEqual({ result: 'concurrent_update' });
  });

  it('nueva idempotency key para ubicación ya adjuntada: coincide -> already_attached', async () => {
    // Simula el reproceso con un nfm/location distinto pero mismos datos guardados.
    const store = new FakeAttachStore(
      row({ status: 'confirmed', delivery_latitude: -17.7833, delivery_longitude: -63.1821 }),
    );
    const res = await attachLocation(store, input());
    expect(res.result).toBe('already_attached');
  });
});

describe('attachLocation — consistencia de confirmed_at (Fase 5.2D.5A.1)', () => {
  const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

  it('delivery awaiting_location + ubicación válida: confirmed + confirmed_at sellado + coords', async () => {
    const store = new FakeAttachStore(row()); // confirmed_at: null
    const before = Date.now();
    const res = await attachLocation(store, input());
    const after = Date.now();

    expect(res.result).toBe('attached');
    expect(store.row?.status).toBe('confirmed');
    expect(store.row?.delivery_latitude).toBe(-17.7833);
    expect(store.row?.delivery_longitude).toBe(-63.1821);

    // confirmed_at pasó de NULL a un timestamp real (no nulo, ISO, ~ahora).
    expect(store.row?.confirmed_at).not.toBeNull();
    expect(store.row?.confirmed_at).toMatch(ISO_RE);
    const stamped = Date.parse(store.row!.confirmed_at!);
    expect(stamped).toBeGreaterThanOrEqual(before);
    expect(stamped).toBeLessThanOrEqual(after);
  });

  it('pedido con confirmed_at previo (camino Flow) + ubicación: CONSERVA el timestamp original', async () => {
    const original = '2026-07-21T14:00:00.000Z';
    const store = new FakeAttachStore(row({ confirmed_at: original }));

    const res = await attachLocation(store, input());

    expect(res.result).toBe('attached');
    // Coalesce: nunca se sobrescribe un confirmed_at existente.
    expect(store.lastConfirmedAt).toBe(original);
    expect(store.row?.confirmed_at).toBe(original);
    // Y aun así las coordenadas quedan guardadas.
    expect(store.row?.delivery_latitude).toBe(-17.7833);
  });

  it('webhook duplicado (ubicación ya adjunta): confirmed_at intacto, sin reescritura', async () => {
    const original = '2026-07-21T14:00:00.000Z';
    const store = new FakeAttachStore(
      row({
        status: 'confirmed',
        delivery_latitude: -17.7833,
        delivery_longitude: -63.1821,
        confirmed_at: original,
      }),
    );

    const res = await attachLocation(store, input()); // mismas coords
    expect(res.result).toBe('already_attached');
    expect(store.attachCalls).toBe(0); // no toca la fila
    expect(store.row?.confirmed_at).toBe(original); // sin cambios
  });

  it('context.id incorrecto (no matchea ningún pedido): no confirma, no sella confirmed_at', async () => {
    const store = new FakeAttachStore(null); // findByLocationRequestMessageId -> null
    const res = await attachLocation(store, input());
    expect(res).toEqual({ result: 'not_found' });
    expect(store.attachCalls).toBe(0);
    expect(store.lastConfirmedAt).toBeUndefined();
  });

  it('teléfono incorrecto: no confirma, confirmed_at permanece null', async () => {
    const store = new FakeAttachStore(row({ customer_phone: '59179999999' }));
    const res = await attachLocation(store, input());
    expect(res).toEqual({ result: 'phone_mismatch' });
    expect(store.attachCalls).toBe(0);
    expect(store.row?.confirmed_at).toBeNull();
  });

  it('status inválido (no awaiting_location): no confirma, confirmed_at permanece null', async () => {
    const store = new FakeAttachStore(row({ status: 'draft' }));
    const res = await attachLocation(store, input());
    expect(res).toEqual({ result: 'invalid_status' });
    expect(store.attachCalls).toBe(0);
    expect(store.row?.confirmed_at).toBeNull();
  });
});

describe('attachLocation — delivery DINÁMICO (6D.2C): GPS sin confirmar', () => {
  it('dynamic: guarda coordenadas pero MANTIENE awaiting_location (no confirma)', async () => {
    const store = new FakeAttachStore(row({ delivery_pricing: 'dynamic' }));
    const res = await attachLocation(store, input());

    expect(res.result).toBe('attached');
    if (res.result === 'attached') {
      expect(res.order.status).toBe('awaiting_location');
    }
    expect(store.row?.delivery_latitude).toBe(-17.7833);
    expect(store.row?.delivery_longitude).toBe(-63.1821);
    // Clave: NO confirma ni sella confirmed_at (lo hará la cotización).
    expect(store.row?.status).toBe('awaiting_location');
    expect(store.row?.confirmed_at).toBeNull();
  });

  it('dynamic con quote failed: reenvío con MISMAS coords → already_attached (sigue awaiting_location)', async () => {
    // GPS ya guardado; el pedido dinámico sigue esperando (quote failed).
    const store = new FakeAttachStore(
      row({
        delivery_pricing: 'dynamic',
        status: 'awaiting_location',
        delivery_latitude: -17.7833,
        delivery_longitude: -63.1821,
      }),
    );
    const res = await attachLocation(store, input());
    expect(res.result).toBe('already_attached');
    if (res.result === 'already_attached') {
      expect(res.order.status).toBe('awaiting_location');
    }
    expect(store.attachCalls).toBe(0); // no reescribe el GPS
  });

  it('legacy (pricing null) conserva el comportamiento: GPS + confirmed', async () => {
    const store = new FakeAttachStore(row({ delivery_pricing: null }));
    const res = await attachLocation(store, input());
    expect(res.result).toBe('attached');
    expect(store.row?.status).toBe('confirmed');
  });
});
