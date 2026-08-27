import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DELIVERY_TIERS, DELIVERY_RAIN_SURCHARGE, feeForMeters } from './fee';

/**
 * PARIDAD del tarifario: `fee.ts` (el flujo) ↔ el money guard de la RPC.
 *
 * Son dos copias de la misma tabla de precios, y tienen que serlo: el código
 * calcula la tarifa y la RPC la verifica antes de escribirla, de modo que un
 * importe manipulado por el camino no llega a la base. Esa defensa solo funciona
 * mientras las dos copias digan lo mismo.
 *
 * Si divergen, el fallo no es sutil: el guard rechaza TODA cotización, el pedido
 * se queda en `awaiting_location` y el cliente nunca recibe su QR. El delivery
 * deja de existir, y el error aparece como una excepción de Postgres que no se
 * parece en nada a "el tarifario está desincronizado".
 *
 * ── Se LEE el SQL, no se replica ────────────────────────────────────────────
 *
 * La versión anterior de este test copiaba la fórmula del SQL en JavaScript. Eso
 * comprueba que la copia coincide con `fee.ts`, no que el SQL lo haga: quien
 * cambiara la migración y olvidara la réplica tendría los tests en verde y la
 * producción rota. Aquí se parsean los tramos del archivo de migración.
 */

const sql = readFileSync(
  fileURLToPath(
    new URL('../../../supabase/migrations/0024_delivery_tariff_2026_08.sql', import.meta.url),
  ),
  'utf8',
);

/** Tramos tal como están escritos en `delivery_tariff_for_meters`. */
function tramosDelSql(): Array<{ maxMeters: number; amount: number }> {
  const cuerpo = sql.slice(
    sql.indexOf('create or replace function public.delivery_tariff_for_meters'),
    sql.indexOf('comment on function public.delivery_tariff_for_meters'),
  );
  const tramos: Array<{ maxMeters: number; amount: number }> = [];
  const re = /when\s+p_meters\s*<=\s*(\d+)\s+then\s+(\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cuerpo)) !== null) {
    tramos.push({ maxMeters: Number(m[1]), amount: Number(m[2]) });
  }
  return tramos;
}

describe('la migración 0024 existe y define el tarifario', () => {
  it('crea la función del tarifario y la tabla de ajustes', () => {
    expect(sql).toContain('create or replace function public.delivery_tariff_for_meters');
    expect(sql).toContain('create table if not exists public.delivery_settings');
    expect(sql).toContain('rain_surcharge_active');
  });

  it('reemplaza el money guard SIN reescribir el resto de la RPC', () => {
    // Las condiciones del original tienen que seguir ahí: perderlas al cambiar
    // el tarifario sería sustituir un problema de precios por uno de estados.
    expect(sql).toContain('create or replace function public.apply_delivery_quote');
    expect(sql).toContain("raise exception 'order not found'");
    expect(sql).toContain("raise exception 'order is not delivery'");
    expect(sql).toContain("'result', 'already_applied'");
    expect(sql).toContain("'result', 'conflict'");
    expect(sql).toContain('for update');
    // El total se recalcula en la base, nunca se acepta del cliente.
    expect(sql).toContain('v_total := v_order.subtotal_amount + p_delivery_amount');
  });

  it('ya no queda rastro de la fórmula vieja', () => {
    expect(sql).not.toContain('v_extra_steps');
    expect(sql).not.toContain('+ 999) / 1000');
  });
});

describe('paridad — el SQL y fee.ts describen la MISMA tabla', () => {
  it('mismos tramos, en el mismo orden y con los mismos precios', () => {
    expect(tramosDelSql()).toEqual(
      DELIVERY_TIERS.map((t) => ({ maxMeters: t.maxMeters, amount: t.amount })),
    );
  });

  it('coinciden metro a metro en todo el rango cotizable', () => {
    const tramos = tramosDelSql();
    const sqlExpected = (m: number) => tramos.find((t) => m <= t.maxMeters)?.amount;

    for (let m = 0; m <= 18_000; m += 1) {
      const fee = feeForMeters(m);
      expect(fee.ok, `${m} m`).toBe(true);
      if (fee.ok) expect(fee.amount, `${m} m`).toBe(sqlExpected(m));
    }
  });

  it('el guard acepta el tramo y el tramo con lluvia, y nada más', () => {
    // El recargo se suma en el código; el guard tiene que admitirlo o rechazaría
    // toda cotización con lluvia activa.
    expect(sql).toContain('p_delivery_amount <> v_expected + 3');
    expect(DELIVERY_RAIN_SURCHARGE).toBe(3);
  });

  it('la cobertura máxima coincide en los dos lados', () => {
    expect(sql).toContain('p_distance_meters > 18000');
    expect(DELIVERY_TIERS[DELIVERY_TIERS.length - 1].maxMeters).toBe(18_000);
  });
});
