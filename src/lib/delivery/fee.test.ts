import { describe, it, expect } from 'vitest';
import {
  feeForMeters,
  DELIVERY_BASE_METERS,
  DELIVERY_BASE_AMOUNT,
  DELIVERY_MAX_DISTANCE_METERS,
} from './fee';

/** Extrae el monto o falla el test si el resultado no fue `ok`. */
function amount(meters: number): number {
  const r = feeForMeters(meters);
  if (!r.ok) throw new Error(`se esperaba tarifa para ${meters} m, se obtuvo ${r.reason}`);
  return r.amount;
}

describe('feeForMeters — tarifario oficial (bordes obligatorios)', () => {
  // [metros, Bs esperados] — cada fila es un borde exigido por el negocio.
  const cases: Array<[number, number]> = [
    [0, 10],
    [1, 10],
    [2999, 10],
    [3000, 10],
    [3001, 12],
    [3999, 12],
    [4000, 12],
    [4001, 14],
    [5000, 14],
    [5001, 16],
    [7600, 20],
    [10000, 24],
    [10001, 26],
    [12000, 28],
    [12300, 30],
    [17000, 38],
    [17001, 40],
    [18000, 40],
  ];

  for (const [meters, bs] of cases) {
    it(`${meters} m → Bs ${bs}`, () => {
      expect(amount(meters)).toBe(bs);
    });
  }
});

describe('feeForMeters — fuera de cobertura', () => {
  it('18001 m → out_of_coverage (no devuelve precio)', () => {
    expect(feeForMeters(18001)).toEqual({ ok: false, reason: 'out_of_coverage' });
  });

  it('cualquier distancia muy grande sigue siendo out_of_coverage', () => {
    expect(feeForMeters(50000)).toEqual({ ok: false, reason: 'out_of_coverage' });
    expect(feeForMeters(1_000_000)).toEqual({ ok: false, reason: 'out_of_coverage' });
  });

  it('el límite exacto (18000) SÍ cotiza; 18001 NO', () => {
    expect(feeForMeters(DELIVERY_MAX_DISTANCE_METERS)).toEqual({ ok: true, amount: 40 });
    expect(feeForMeters(DELIVERY_MAX_DISTANCE_METERS + 1)).toEqual({
      ok: false,
      reason: 'out_of_coverage',
    });
  });
});

describe('feeForMeters — entradas inválidas (nunca inventa distancia)', () => {
  it('negativos → invalid_distance', () => {
    expect(feeForMeters(-1)).toEqual({ ok: false, reason: 'invalid_distance' });
    expect(feeForMeters(-3000)).toEqual({ ok: false, reason: 'invalid_distance' });
  });

  it('NaN → invalid_distance', () => {
    expect(feeForMeters(Number.NaN)).toEqual({ ok: false, reason: 'invalid_distance' });
  });

  it('Infinity / -Infinity → invalid_distance', () => {
    expect(feeForMeters(Number.POSITIVE_INFINITY)).toEqual({ ok: false, reason: 'invalid_distance' });
    expect(feeForMeters(Number.NEGATIVE_INFINITY)).toEqual({ ok: false, reason: 'invalid_distance' });
  });

  it('no enteros → invalid_distance (el contrato exige metros enteros)', () => {
    expect(feeForMeters(3000.5)).toEqual({ ok: false, reason: 'invalid_distance' });
    expect(feeForMeters(0.1)).toEqual({ ok: false, reason: 'invalid_distance' });
  });

  it('tipos no numéricos → invalid_distance', () => {
    // @ts-expect-error validación defensiva ante un caller sin tipos.
    expect(feeForMeters('3000')).toEqual({ ok: false, reason: 'invalid_distance' });
    // @ts-expect-error validación defensiva ante un caller sin tipos.
    expect(feeForMeters(null)).toEqual({ ok: false, reason: 'invalid_distance' });
    // @ts-expect-error validación defensiva ante un caller sin tipos.
    expect(feeForMeters(undefined)).toEqual({ ok: false, reason: 'invalid_distance' });
  });
});

describe('feeForMeters — coherencia del escalón', () => {
  it('cada salto de tramo suma exactamente Bs 2', () => {
    // Cruces de escalón: 3000→3001, 4000→4001, 5000→5001 …
    expect(amount(3001) - amount(3000)).toBe(2);
    expect(amount(4001) - amount(4000)).toBe(2);
    expect(amount(5001) - amount(5000)).toBe(2);
  });

  it('dentro de un mismo km el precio no cambia', () => {
    expect(amount(3001)).toBe(amount(3999)); // ambos Bs 12
    expect(amount(4001)).toBe(amount(5000)); // ambos Bs 14
  });

  it('las constantes públicas reflejan la regla del negocio', () => {
    expect(DELIVERY_BASE_METERS).toBe(3000);
    expect(DELIVERY_BASE_AMOUNT).toBe(10);
    expect(DELIVERY_MAX_DISTANCE_METERS).toBe(18000);
  });
});
