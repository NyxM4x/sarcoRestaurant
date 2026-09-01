import { describe, it, expect } from 'vitest';
import { normalizePhone } from '@/lib/phone';
import {
  attachLocation,
  attachLooseLocation,
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

  /**
   * Espeja la consulta real: solo devuelve un pedido de ESTE teléfono que siga
   * esperando ubicación y sin GPS. Lo que la consulta filtre es justo lo que la
   * capa pura no debería tener que suponer.
   */
  async findAwaitingLocationByPhone(digits: string): Promise<LocationOrderRow | null> {
    if (this.loseRace && this.attachCalls > 0 && this.raceWinnerRow !== undefined) {
      return this.raceWinnerRow;
    }
    if (!this.row) return null;
    if (normalizePhone(this.row.customer_phone) !== digits) return null;
    if (this.row.status !== 'awaiting_location') return null;
    if (this.row.delivery_latitude !== null || this.row.delivery_longitude !== null) return null;
    return { ...this.row };
  }

  /** Último confirmedAt que la capa pura pidió persistir (coalesce ya aplicado). */
  lastConfirmedAt: string | undefined;

  /** Último contextId que la capa pura usó como guard (`null` = pin suelto). */
  lastContextId: string | null | undefined;

  async attachIfPending(input: {
    orderId: string;
    contextId: string | null;
    latitude: number;
    longitude: number;
    address: string | null;
    name: string | null;
    confirmedAt: string;
  }): Promise<LocationOrderRow | null> {
    this.attachCalls += 1;
    this.lastConfirmedAt = input.confirmedAt;
    this.lastContextId = input.contextId;
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
    contextId: string | null;
    latitude: number;
    longitude: number;
    address: string | null;
    name: string | null;
  }): Promise<LocationOrderRow | null> {
    this.attachCalls += 1;
    this.lastContextId = input.contextId;
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

// ── El pin que no responde al botón (0028) ──────────────────────────────────

describe('attachLooseLocation', () => {
  /**
   * El caso real: el cliente armó su pedido, le mandamos el botón de ubicación
   * y contestó con el clip de WhatsApp de siempre. El pin llega sin
   * `context.id`, así que no hay wamid con el que correlacionar — pero el
   * pedido que lo espera existe y se encuentra por teléfono.
   */
  function looseInput(overrides: Partial<Parameters<typeof attachLooseLocation>[1]> = {}) {
    return {
      customerPhoneDigits: PHONE,
      latitude: -17.7833,
      longitude: -63.1821,
      address: 'Av. Siempre Viva 123',
      name: 'Casa',
      ...overrides,
    };
  }

  it('pedido esperando ubicación: el pin sin contexto se adjunta igual', async () => {
    const store = new FakeAttachStore(row());
    const res = await attachLooseLocation(store, looseInput());

    expect(res.result).toBe('attached');
    expect(store.row?.delivery_latitude).toBe(-17.7833);
    expect(store.row?.status).toBe('confirmed');
  });

  it('el UPDATE no exige wamid: el guard es el estado, no el contexto', async () => {
    // Exigir `location_request_message_id = ?` aquí no encontraría nada — el
    // pin no responde a ninguna petición nuestra. Lo que impide la doble
    // escritura sigue siendo `awaiting_location` + coordenadas NULL.
    const store = new FakeAttachStore(row());
    await attachLooseLocation(store, looseInput());

    expect(store.lastContextId).toBeNull();
  });

  it('dynamic: guarda el GPS y NO confirma (lo hará la cotización)', async () => {
    const store = new FakeAttachStore(row({ delivery_pricing: 'dynamic' }));
    const res = await attachLooseLocation(store, looseInput());

    expect(res.result).toBe('attached');
    if (res.result === 'attached') expect(res.order.status).toBe('awaiting_location');
    expect(store.row?.delivery_latitude).toBe(-17.7833);
    expect(store.row?.confirmed_at).toBeNull();
  });

  it('normaliza el teléfono guardado antes de comparar', async () => {
    // `orders.customer_phone` guarda lo que llegó del checkout; el webhook trae
    // dígitos pelados. Comparar los dos crudos no encontraría nunca el pedido, y
    // el fallo sería MUDO: nadie vería un error, el cliente solo silencio.
    const store = new FakeAttachStore(row({ customer_phone: '+591 7000-0001' }));
    const res = await attachLooseLocation(store, looseInput());

    expect(res.result).toBe('attached');
  });

  it('nadie esperaba este pin: not_found, y el llamador lo cotizará suelto', async () => {
    const store = new FakeAttachStore(null);
    const res = await attachLooseLocation(store, looseInput());

    expect(res).toEqual({ result: 'not_found' });
    expect(store.attachCalls).toBe(0);
  });

  it('un pedido ya confirmado no se toca: sigue siendo una consulta de tarifa', async () => {
    const store = new FakeAttachStore(row({ status: 'confirmed' }));
    const res = await attachLooseLocation(store, looseInput());

    expect(res).toEqual({ result: 'not_found' });
    expect(store.attachCalls).toBe(0);
  });

  it('sin búsqueda por teléfono en el store: not_found, comportamiento previo', async () => {
    // El store puede no implementarla (es opcional). Entonces esto no puede
    // hacer nada, y decirlo con `not_found` es lo que deja al pin seguir su
    // camino de antes en vez de romper la entrega.
    const store = new FakeAttachStore(row());
    const sinBusqueda: AttachLocationStore = {
      findByLocationRequestMessageId: () => store.findByLocationRequestMessageId(),
      attachIfPending: (i) => store.attachIfPending(i),
      attachIfPendingDynamic: (i) => store.attachIfPendingDynamic(i),
    };

    const res = await attachLooseLocation(sinBusqueda, looseInput());
    expect(res).toEqual({ result: 'not_found' });
    expect(store.attachCalls).toBe(0);
  });

  it('sin teléfono no se adivina a quién adjuntar', async () => {
    const store = new FakeAttachStore(row());
    const res = await attachLooseLocation(store, looseInput({ customerPhoneDigits: '' }));

    expect(res).toEqual({ result: 'not_found' });
    expect(store.attachCalls).toBe(0);
  });

  it('carrera perdida con las MISMAS coordenadas -> already_attached', async () => {
    const store = new FakeAttachStore(row());
    store.loseRace = true;
    store.raceWinnerRow = row({
      status: 'confirmed',
      delivery_latitude: -17.7833,
      delivery_longitude: -63.1821,
    });

    const res = await attachLooseLocation(store, looseInput());
    expect(res.result).toBe('already_attached');
  });

  it('carrera perdida con coordenadas DIFERENTES -> location_conflict', async () => {
    const store = new FakeAttachStore(row());
    store.loseRace = true;
    store.raceWinnerRow = row({
      status: 'confirmed',
      delivery_latitude: 5,
      delivery_longitude: 5,
    });

    const res = await attachLooseLocation(store, looseInput());
    expect(res).toEqual({ result: 'location_conflict' });
  });

  it('carrera perdida sin ganador visible -> concurrent_update (reintentable)', async () => {
    const store = new FakeAttachStore(row());
    store.loseRace = true;
    store.raceWinnerRow = null;

    const res = await attachLooseLocation(store, looseInput());
    expect(res).toEqual({ result: 'concurrent_update' });
  });
});
