import { describe, it, expect } from 'vitest';
import {
  DELIVERY_BASE_AMOUNT,
  DELIVERY_MAX_DISTANCE_METERS,
  DELIVERY_RAIN_SURCHARGE,
  DELIVERY_TIERS,
  feeForMeters,
} from './fee';

/**
 * TARIFARIO — la tabla publicada por el proveedor, verificada tramo a tramo.
 *
 * Los casos están escritos con los números del cartel, no derivados de la
 * implementación: si alguien edita `DELIVERY_TIERS` por accidente, estos tests
 * son la segunda fuente que lo delata. Por eso se repiten los importes en vez de
 * leerlos de la constante — un test que se calcula a sí mismo no comprueba nada.
 */

/** El cartel, transcrito: [hasta km, Bs]. */
const CARTEL: ReadonlyArray<[number, number]> = [
  [2, 10],
  [3, 12],
  [4, 13],
  [5, 15],
  [6, 17],
  [7, 19],
  [8, 21],
  [9, 25],
  [11, 27],
  [12, 30],
  [13, 32],
  [14, 34],
  [15, 36],
  [16, 40],
  [17, 42],
  [18, 44],
];

const km = (n: number) => Math.round(n * 1000);

describe('tarifario — cada tramo cobra lo que dice el cartel', () => {
  it('el techo de cada tramo cuesta lo publicado', () => {
    for (const [hastaKm, bs] of CARTEL) {
      expect(feeForMeters(km(hastaKm)), `${hastaKm} km`).toEqual({ ok: true, amount: bs });
    }
  });

  it('un metro por encima del techo ya es el tramo siguiente', () => {
    // El borde es donde se cobra mal: 3.000 m son 12 Bs y 3.001 son 13.
    for (let i = 0; i < CARTEL.length - 1; i += 1) {
      const [hastaKm] = CARTEL[i];
      const [, siguienteBs] = CARTEL[i + 1];
      expect(feeForMeters(km(hastaKm) + 1), `${hastaKm} km + 1 m`).toEqual({
        ok: true,
        amount: siguienteBs,
      });
    }
  });

  it('el tramo de 9.1 a 11 km abarca DOS kilómetros', () => {
    // No es un error de transcripción: el cartel salta de 9 a 11 sin tramo
    // intermedio, así que 10 km cuestan lo mismo que 11.
    expect(feeForMeters(km(9.5))).toEqual({ ok: true, amount: 27 });
    expect(feeForMeters(km(10))).toEqual({ ok: true, amount: 27 });
    expect(feeForMeters(km(11))).toEqual({ ok: true, amount: 27 });
    expect(feeForMeters(km(11.001))).toEqual({ ok: true, amount: 30 });
  });

  it('los saltos irregulares se respetan: no hay fórmula que valga', () => {
    // De 3 a 4 km sube 1 Bs; de 8 a 9 sube 4. Cualquier progresión lineal
    // cobraría mal aquí, y es la razón de que esto sea una tabla.
    expect(feeForMeters(km(4))).toEqual({ ok: true, amount: 13 }); // +1 sobre 12
    expect(feeForMeters(km(9))).toEqual({ ok: true, amount: 25 }); // +4 sobre 21
    expect(feeForMeters(km(16))).toEqual({ ok: true, amount: 40 }); // +4 sobre 36
  });

  it('una distancia dentro del tramo cuesta lo mismo que su techo', () => {
    expect(feeForMeters(km(2.5))).toEqual({ ok: true, amount: 12 });
    expect(feeForMeters(km(5.76))).toEqual({ ok: true, amount: 17 });
    expect(feeForMeters(km(17.9))).toEqual({ ok: true, amount: 44 });
  });
});

describe('tarifario — los extremos', () => {
  it('cero metros cuesta la tarifa mínima, no cero', () => {
    expect(feeForMeters(0)).toEqual({ ok: true, amount: 10 });
    expect(DELIVERY_BASE_AMOUNT).toBe(10);
  });

  it('el máximo comercial son 18 km y se cotiza', () => {
    expect(DELIVERY_MAX_DISTANCE_METERS).toBe(18_000);
    expect(feeForMeters(18_000)).toEqual({ ok: true, amount: 44 });
  });

  it('un metro más allá queda fuera de cobertura, no se inventa precio', () => {
    expect(feeForMeters(18_001)).toEqual({ ok: false, reason: 'out_of_coverage' });
    expect(feeForMeters(50_000)).toEqual({ ok: false, reason: 'out_of_coverage' });
  });

  it('una distancia imposible se rechaza en vez de cobrarse', () => {
    for (const malo of [-1, 1.5, NaN, Infinity, -Infinity]) {
      expect(feeForMeters(malo), String(malo)).toEqual({
        ok: false,
        reason: 'invalid_distance',
      });
    }
    expect(feeForMeters('3000' as unknown as number)).toEqual({
      ok: false,
      reason: 'invalid_distance',
    });
  });
});

describe('tarifa de lluvia — suma encima, no sustituye', () => {
  it('añade 3 Bs al tramo que corresponda', () => {
    expect(DELIVERY_RAIN_SURCHARGE).toBe(3);
    expect(feeForMeters(km(2), { rain: true })).toEqual({ ok: true, amount: 13 });
    expect(feeForMeters(km(5.76), { rain: true })).toEqual({ ok: true, amount: 20 });
    expect(feeForMeters(km(18), { rain: true })).toEqual({ ok: true, amount: 47 });
  });

  it('sin lluvia el precio es el de siempre', () => {
    expect(feeForMeters(km(5.76), { rain: false })).toEqual({ ok: true, amount: 17 });
    expect(feeForMeters(km(5.76))).toEqual({ ok: true, amount: 17 });
  });

  it('la lluvia NO amplía la cobertura', () => {
    // Encarece el viaje, no cambia la distancia: 18.001 m siguen sin tener
    // precio automático, llueva o no.
    expect(feeForMeters(18_001, { rain: true })).toEqual({
      ok: false,
      reason: 'out_of_coverage',
    });
  });

  it('tampoco convierte una distancia inválida en cobrable', () => {
    expect(feeForMeters(-1, { rain: true })).toEqual({ ok: false, reason: 'invalid_distance' });
  });
});

describe('la tabla está bien formada', () => {
  it('los tramos suben en distancia y nunca bajan de precio', () => {
    // Un tramo desordenado haría que `find` eligiera el equivocado, y un precio
    // que baja al alejarse sería un error de transcripción del cartel.
    for (let i = 1; i < DELIVERY_TIERS.length; i += 1) {
      expect(DELIVERY_TIERS[i].maxMeters, `tramo ${i}`).toBeGreaterThan(
        DELIVERY_TIERS[i - 1].maxMeters,
      );
      expect(DELIVERY_TIERS[i].amount, `tramo ${i}`).toBeGreaterThanOrEqual(
        DELIVERY_TIERS[i - 1].amount,
      );
    }
  });

  it('no hay ningún metro sin precio dentro de la cobertura', () => {
    // Recorre todos los bordes: si un tramo empezara donde no acaba el anterior,
    // habría distancias sin tarifa o con dos.
    for (let m = 0; m <= DELIVERY_MAX_DISTANCE_METERS; m += 137) {
      const fee = feeForMeters(m);
      expect(fee.ok, `${m} m`).toBe(true);
    }
  });

  it('la tabla tiene los 16 tramos del cartel', () => {
    expect(DELIVERY_TIERS).toHaveLength(CARTEL.length);
  });
});
