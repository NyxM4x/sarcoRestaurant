import { describe, it, expect } from 'vitest';
import {
  quoteDynamicOrder,
  type QuoteApplyResult,
  type QuoteMarkResult,
  type QuoteOrchestratorDeps,
  type QuoteOrderRow,
} from './quote-order';
import type { MapboxDistanceResult } from './mapbox';

const ORDER_ID = '33333333-3333-4333-8333-333333333333';

function order(overrides: Partial<QuoteOrderRow> = {}): QuoteOrderRow {
  return {
    id: ORDER_ID,
    order_number: 'ORD-000100',
    delivery_type: 'delivery',
    delivery_pricing: 'dynamic',
    delivery_quote_status: 'pending',
    status: 'awaiting_location',
    delivery_latitude: -17.8405,
    delivery_longitude: -63.1818,
    customer_phone: '59170000000',
    phone_number_id: 'pnid-1',
    ...overrides,
  };
}

interface Rec {
  distances: Array<{ lat: number; lng: number }>;
  applies: Array<{ orderId: string; distanceMeters: number; deliveryAmount: number }>;
  marks: Array<{ orderId: string; status: string; distanceMeters: number | null }>;
  outOfCoverageSent: number;
  confirmationDispatched: number;
  alerts: string[];
}

function harness(opts: {
  loaded?: QuoteOrderRow | null;
  distances?: MapboxDistanceResult[];
  apply?: QuoteApplyResult;
  mark?: QuoteMarkResult;
  withAlert?: boolean;
}) {
  const rec: Rec = {
    distances: [],
    applies: [],
    marks: [],
    outOfCoverageSent: 0,
    confirmationDispatched: 0,
    alerts: [],
  };
  const distanceQueue = [...(opts.distances ?? [])];

  const deps: QuoteOrchestratorDeps = {
    async loadForQuote() {
      return opts.loaded === undefined ? order() : opts.loaded;
    },
    async getDistanceMeters(dest) {
      rec.distances.push(dest);
      const next = distanceQueue.shift();
      if (!next) throw new Error('unexpected extra getDistanceMeters call');
      return next;
    },
    async applyQuote(orderId, distanceMeters, deliveryAmount) {
      rec.applies.push({ orderId, distanceMeters, deliveryAmount });
      return opts.apply ?? { result: 'applied' };
    },
    async markQuoteResult(orderId, status, distanceMeters) {
      rec.marks.push({ orderId, status, distanceMeters });
      return opts.mark ?? { result: 'applied' };
    },
    async sendOutOfCoverageMessage() {
      rec.outOfCoverageSent += 1;
    },
    async dispatchConfirmation() {
      rec.confirmationDispatched += 1;
    },
    alert: opts.withAlert
      ? async (text: string) => {
          rec.alerts.push(text);
        }
      : undefined,
  };

  return { deps, rec };
}

const ok = (m: number): MapboxDistanceResult => ({ ok: true, distanceMeters: m });

describe('quoteDynamicOrder — cotización exitosa', () => {
  it('cotiza, aplica y dispara la confirmación', async () => {
    // 5027 m cae en el tramo 5.1–6 km del tarifario → Bs 17.
    const { deps, rec } = harness({ distances: [ok(5027)], apply: { result: 'applied' } });
    const res = await quoteDynamicOrder(deps, ORDER_ID);

    expect(res).toEqual({ result: 'quoted', distanceMeters: 5027, amount: 17, apply: 'applied' });
    expect(rec.applies).toEqual([{ orderId: ORDER_ID, distanceMeters: 5027, deliveryAmount: 17 }]);
    expect(rec.confirmationDispatched).toBe(1);
    expect(rec.marks).toEqual([]); // nunca marca failed/out_of_coverage en éxito
  });

  it('already_applied también dispara confirmación (idempotente)', async () => {
    const { deps, rec } = harness({ distances: [ok(1630)], apply: { result: 'already_applied' } });
    const res = await quoteDynamicOrder(deps, ORDER_ID);
    expect(res).toMatchObject({ result: 'quoted', amount: 10, apply: 'already_applied' });
    expect(rec.confirmationDispatched).toBe(1);
  });

  it('conflict de apply NO dispara confirmación', async () => {
    const { deps, rec } = harness({ distances: [ok(5027)], apply: { result: 'conflict' } });
    const res = await quoteDynamicOrder(deps, ORDER_ID);
    expect(res).toEqual({ result: 'conflict' });
    expect(rec.confirmationDispatched).toBe(0);
  });
});

describe('quoteDynamicOrder — retry de Mapbox (máx 1 reintento, solo transitorios)', () => {
  it('timeout y luego éxito: reintenta una vez', async () => {
    const { deps, rec } = harness({
      distances: [{ ok: false, error: 'timeout' }, ok(6169)],
      apply: { result: 'applied' },
    });
    const res = await quoteDynamicOrder(deps, ORDER_ID);
    expect(rec.distances).toHaveLength(2);
    expect(res).toMatchObject({ result: 'quoted', amount: 19 }); // 6169 m → tramo 6.1–7 km
  });

  it('network_error y luego éxito: reintenta una vez', async () => {
    const { deps, rec } = harness({
      distances: [{ ok: false, error: 'network_error' }, ok(10638)],
      apply: { result: 'applied' },
    });
    const res = await quoteDynamicOrder(deps, ORDER_ID);
    expect(rec.distances).toHaveLength(2);
    expect(res).toMatchObject({ result: 'quoted', amount: 27 }); // 10638 m → tramo 9.1–11 km
  });

  it('http_5xx dos veces: marca failed (no confirma)', async () => {
    const { deps, rec } = harness({
      distances: [{ ok: false, error: 'http_5xx' }, { ok: false, error: 'http_5xx' }],
    });
    const res = await quoteDynamicOrder(deps, ORDER_ID);
    expect(rec.distances).toHaveLength(2);
    expect(res).toEqual({ result: 'failed', error: 'http_5xx' });
    expect(rec.marks).toEqual([{ orderId: ORDER_ID, status: 'failed', distanceMeters: null }]);
    expect(rec.confirmationDispatched).toBe(0);
  });

  it('http_401 NO reintenta, marca failed y alerta', async () => {
    const { deps, rec } = harness({
      distances: [{ ok: false, error: 'http_401' }],
      withAlert: true,
    });
    const res = await quoteDynamicOrder(deps, ORDER_ID);
    expect(rec.distances).toHaveLength(1); // sin reintento
    expect(res).toEqual({ result: 'failed', error: 'http_401' });
    expect(rec.marks).toEqual([{ orderId: ORDER_ID, status: 'failed', distanceMeters: null }]);
    expect(rec.alerts).toHaveLength(1);
  });

  it('http_403 NO reintenta y marca failed', async () => {
    const { deps, rec } = harness({ distances: [{ ok: false, error: 'http_403' }] });
    const res = await quoteDynamicOrder(deps, ORDER_ID);
    expect(rec.distances).toHaveLength(1);
    expect(res).toEqual({ result: 'failed', error: 'http_403' });
  });

  it('no_route NO reintenta y marca failed', async () => {
    const { deps, rec } = harness({ distances: [{ ok: false, error: 'no_route' }] });
    const res = await quoteDynamicOrder(deps, ORDER_ID);
    expect(rec.distances).toHaveLength(1);
    expect(res).toEqual({ result: 'failed', error: 'no_route' });
    expect(rec.confirmationDispatched).toBe(0);
  });

  it('invalid_response NO reintenta y marca failed', async () => {
    const { deps, rec } = harness({ distances: [{ ok: false, error: 'invalid_response' }] });
    const res = await quoteDynamicOrder(deps, ORDER_ID);
    expect(rec.distances).toHaveLength(1);
    expect(res).toEqual({ result: 'failed', error: 'invalid_response' });
  });
});

describe('quoteDynamicOrder — fuera de cobertura', () => {
  it('> 18000 m: marca out_of_coverage con distancia real y avisa (applied)', async () => {
    const { deps, rec } = harness({
      distances: [ok(21864)],
      mark: { result: 'applied' },
      withAlert: true,
    });
    const res = await quoteDynamicOrder(deps, ORDER_ID);
    expect(res).toEqual({ result: 'out_of_coverage', distanceMeters: 21864, mark: 'applied' });
    expect(rec.marks).toEqual([
      { orderId: ORDER_ID, status: 'out_of_coverage', distanceMeters: 21864 },
    ]);
    expect(rec.applies).toEqual([]); // nunca apply_delivery_quote fuera de cobertura
    expect(rec.outOfCoverageSent).toBe(1);
    expect(rec.alerts).toHaveLength(1);
    expect(rec.confirmationDispatched).toBe(0);
  });

  it('already_applied NO reenvía el mensaje al cliente', async () => {
    const { deps, rec } = harness({ distances: [ok(21864)], mark: { result: 'already_applied' } });
    const res = await quoteDynamicOrder(deps, ORDER_ID);
    expect(res).toMatchObject({ result: 'out_of_coverage', mark: 'already_applied' });
    expect(rec.outOfCoverageSent).toBe(0);
  });

  it('conflict NO reenvía el mensaje al cliente', async () => {
    const { deps, rec } = harness({ distances: [ok(21864)], mark: { result: 'conflict' } });
    const res = await quoteDynamicOrder(deps, ORDER_ID);
    expect(res).toMatchObject({ result: 'out_of_coverage', mark: 'conflict' });
    expect(rec.outOfCoverageSent).toBe(0);
  });
});

describe('quoteDynamicOrder — estados que NO se cotizan (idempotencia por estado)', () => {
  it('pedido inexistente → skipped order_not_found', async () => {
    const { deps, rec } = harness({ loaded: null });
    expect(await quoteDynamicOrder(deps, ORDER_ID)).toEqual({
      result: 'skipped',
      reason: 'order_not_found',
    });
    expect(rec.distances).toHaveLength(0);
  });

  it('pedido no dinámico (pricing null) → skipped not_dynamic', async () => {
    const { deps, rec } = harness({ loaded: order({ delivery_pricing: null }) });
    expect(await quoteDynamicOrder(deps, ORDER_ID)).toMatchObject({ reason: 'not_dynamic' });
    expect(rec.distances).toHaveLength(0);
  });

  it('pickup → skipped not_dynamic', async () => {
    const { deps } = harness({
      loaded: order({ delivery_type: 'pickup', delivery_pricing: null, status: 'confirmed' }),
    });
    expect(await quoteDynamicOrder(deps, ORDER_ID)).toMatchObject({ reason: 'not_dynamic' });
  });

  it('ya quoted (status confirmed) → skipped not_awaiting_location (no recotiza)', async () => {
    const { deps, rec } = harness({
      loaded: order({ status: 'confirmed', delivery_quote_status: 'quoted' }),
    });
    expect(await quoteDynamicOrder(deps, ORDER_ID)).toMatchObject({
      reason: 'not_awaiting_location',
    });
    expect(rec.distances).toHaveLength(0);
  });

  it('out_of_coverage previo → skipped not_quotable (no recotiza)', async () => {
    const { deps, rec } = harness({
      loaded: order({ delivery_quote_status: 'out_of_coverage' }),
    });
    expect(await quoteDynamicOrder(deps, ORDER_ID)).toMatchObject({ reason: 'not_quotable' });
    expect(rec.distances).toHaveLength(0);
  });

  it('quote_status failed → SÍ recotiza (reintento con GPS ya guardado)', async () => {
    const { deps, rec } = harness({
      loaded: order({ delivery_quote_status: 'failed' }),
      distances: [ok(5027)],
      apply: { result: 'applied' },
    });
    const res = await quoteDynamicOrder(deps, ORDER_ID);
    expect(res).toMatchObject({ result: 'quoted', amount: 17 });
    expect(rec.distances).toHaveLength(1);
  });

  it('sin GPS válido → skipped missing_gps', async () => {
    const { deps, rec } = harness({
      loaded: order({ delivery_latitude: null, delivery_longitude: null }),
    });
    expect(await quoteDynamicOrder(deps, ORDER_ID)).toMatchObject({ reason: 'missing_gps' });
    expect(rec.distances).toHaveLength(0);
  });
});

describe('quoteDynamicOrder — defensa', () => {
  it('un throw inesperado de una dep no se propaga: result error', async () => {
    const deps: QuoteOrchestratorDeps = {
      async loadForQuote() {
        throw new Error('db down');
      },
      async getDistanceMeters() {
        return ok(1);
      },
      async applyQuote() {
        return { result: 'applied' };
      },
      async markQuoteResult() {
        return { result: 'applied' };
      },
      async sendOutOfCoverageMessage() {},
      async dispatchConfirmation() {},
    };
    // El motivo viaja en el resultado: un catch mudo dejaba el pedido en
    // `pending` sin rastro de por qué. Sigue sin propagarse hacia el webhook.
    expect(await quoteDynamicOrder(deps, ORDER_ID)).toEqual({
      result: 'error',
      reason: 'db down',
    });
  });

  it('un throw sin Error devuelve reason "unknown" en vez de romper', async () => {
    const deps: QuoteOrchestratorDeps = {
      async loadForQuote() {
        throw 'no soy un Error';
      },
      async getDistanceMeters() {
        return ok(1);
      },
      async applyQuote() {
        return { result: 'applied' };
      },
      async markQuoteResult() {
        return { result: 'applied' };
      },
      async sendOutOfCoverageMessage() {},
      async dispatchConfirmation() {},
    };
    expect(await quoteDynamicOrder(deps, ORDER_ID)).toEqual({
      result: 'error',
      reason: 'unknown',
    });
  });
});

describe('tarifa de lluvia — se consulta al cotizar', () => {
  /**
   * El recargo se decide en el momento de fijar el precio, no al recibir el
   * pedido: lo que queda escrito es el importe final. Un pedido ya cotizado
   * conserva su precio aunque el encargado apague el recargo un minuto después.
   */
  it('con lluvia activa suma 3 Bs al tramo', async () => {
    const { deps, rec } = harness({ distances: [ok(5027)], apply: { result: 'applied' } });
    const res = await quoteDynamicOrder(
      { ...deps, isRainSurchargeActive: async () => true },
      ORDER_ID,
    );
    // 5027 m → tramo 5.1–6 km = 17, más 3 de lluvia.
    expect(res).toMatchObject({ result: 'quoted', amount: 20 });
    expect(rec.applies[0].deliveryAmount).toBe(20);
  });

  it('sin lluvia cobra el tramo pelado', async () => {
    const { deps } = harness({ distances: [ok(5027)], apply: { result: 'applied' } });
    const res = await quoteDynamicOrder(
      { ...deps, isRainSurchargeActive: async () => false },
      ORDER_ID,
    );
    expect(res).toMatchObject({ result: 'quoted', amount: 17 });
  });

  it('si la consulta falla se cobra SIN recargo', async () => {
    // Perder 3 Bs es nuestro problema y se arregla en la siguiente cotización.
    // Cobrárselos a alguien por un fallo técnico que no puede ver, no.
    const { deps } = harness({ distances: [ok(5027)], apply: { result: 'applied' } });
    const res = await quoteDynamicOrder(
      {
        ...deps,
        isRainSurchargeActive: async () => {
          throw new Error('base caída');
        },
      },
      ORDER_ID,
    );
    expect(res).toMatchObject({ result: 'quoted', amount: 17 });
  });

  it('sin el puerto inyectado no hay recargo: comportamiento de antes', async () => {
    const { deps } = harness({ distances: [ok(5027)], apply: { result: 'applied' } });
    expect(await quoteDynamicOrder(deps, ORDER_ID)).toMatchObject({ amount: 17 });
  });

  it('la lluvia NO amplía la cobertura', async () => {
    const { deps } = harness({ distances: [ok(18_500)] });
    const res = await quoteDynamicOrder(
      { ...deps, isRainSurchargeActive: async () => true },
      ORDER_ID,
    );
    expect(res).toMatchObject({ result: 'out_of_coverage' });
  });
});
