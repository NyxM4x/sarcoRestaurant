import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Verificación ESTÁTICA de 0011_fix_delivery_quote_result_guard_order.sql (6D.2C).
 *
 * Corrige el ORDEN de guardas de mark_delivery_quote_result: la protección de
 * 'quoted' → conflict debe evaluarse ANTES de exigir status='awaiting_location',
 * para que un pedido ya cotizado (status='confirmed') devuelva conflict en vez de
 * lanzar 'order is not awaiting_location'. El resto queda idéntico a 0010.
 */

const sql = readFileSync(
  fileURLToPath(
    new URL('../../../supabase/migrations/0011_fix_delivery_quote_result_guard_order.sql', import.meta.url),
  ),
  'utf8',
);
const code = sql.replace(/--[^\n]*/g, '');

const QUOTED_GUARD = "v_order.delivery_quote_status = 'quoted'";
const AWAITING_GUARD = "v_order.status <> 'awaiting_location'";

describe('0011 fix — CREATE OR REPLACE con misma firma', () => {
  it('reemplaza (no re-crea) mark_delivery_quote_result con 3 args', () => {
    expect(code).toContain('create or replace function public.mark_delivery_quote_result(');
    expect(code).toMatch(/p_order_id uuid/);
    expect(code).toMatch(/p_status text/);
    expect(code).toMatch(/p_distance_meters integer/);
  });
});

describe('0011 fix — ORDEN de guardas corregido', () => {
  it('la guarda quoted→conflict aparece ANTES de exigir awaiting_location', () => {
    const quotedAt = code.indexOf(QUOTED_GUARD);
    const awaitingAt = code.indexOf(AWAITING_GUARD);
    expect(quotedAt).toBeGreaterThan(-1);
    expect(awaitingAt).toBeGreaterThan(-1);
    // Contrato: quoted (status=confirmed) → conflict, NUNCA 'not awaiting_location'.
    expect(quotedAt).toBeLessThan(awaitingAt);
  });

  it('quoted+confirmed devuelve conflict sin exigir awaiting_location', () => {
    // El bloque quoted retorna conflict; el raise de awaiting_location queda después.
    expect(code).toMatch(
      /delivery_quote_status = 'quoted' then[\s\S]*?'result', 'conflict'[\s\S]*?end if;[\s\S]*?v_order\.status <> 'awaiting_location'/,
    );
  });

  it('sigue exigiendo awaiting_location para las transiciones no-quoted', () => {
    expect(code).toContain(AWAITING_GUARD);
    expect(code).toContain('order is not awaiting_location');
  });
});

describe('0011 fix — no debilita ninguna otra guarda (idéntico a 0010)', () => {
  it('conserva locking, dominio y validación de cobertura', () => {
    expect(code).toMatch(/from public\.orders\s+where id = p_order_id\s+for update/);
    expect(code).toContain("v_order.delivery_type <> 'delivery'");
    expect(code).toContain("v_order.delivery_pricing is distinct from 'dynamic'");
    expect(code).toContain('p_distance_meters <= 18000');
  });

  it('las guardas de dominio se evalúan antes que la de quoted', () => {
    const dtypeAt = code.indexOf("v_order.delivery_type <> 'delivery'");
    const pricingAt = code.indexOf("v_order.delivery_pricing is distinct from 'dynamic'");
    const quotedAt = code.indexOf(QUOTED_GUARD);
    expect(dtypeAt).toBeGreaterThan(-1);
    expect(dtypeAt).toBeLessThan(quotedAt);
    expect(pricingAt).toBeLessThan(quotedAt);
  });

  it('conserva idempotencia failed / out_of_coverage y out_of_coverage→failed conflict', () => {
    expect(code).toContain("v_result := 'applied'");
    expect(code).toContain("v_result := 'already_applied'");
    expect(code).toContain("'result', 'conflict'");
    // out_of_coverage previo nunca se degrada a failed. El ancla "Destino: failed"
    // vive en un comentario: se mira sobre el sql CRUDO.
    expect(sql).toMatch(
      /Destino: failed[\s\S]*?v_order\.delivery_quote_status = 'out_of_coverage'[\s\S]*?'result', 'conflict'/,
    );
  });

  it('NO escribe dinero ni confirma el pedido', () => {
    expect(code).not.toContain('delivery_amount');
    expect(code).not.toContain('total_amount');
    expect(code).not.toContain('subtotal_amount');
    expect(code).not.toContain('confirmed_at');
    expect(code).not.toContain("'confirmed'");
  });
});

describe('0011 fix — grants (solo service_role)', () => {
  it('revoca public/anon/authenticated y otorga service_role', () => {
    expect(code).toMatch(
      /revoke all on function public\.mark_delivery_quote_result[\s\S]*?from anon/,
    );
    expect(code).toMatch(
      /grant execute on function public\.mark_delivery_quote_result[\s\S]*?to service_role/,
    );
  });
});
