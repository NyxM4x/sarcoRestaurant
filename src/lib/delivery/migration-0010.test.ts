import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Verificación ESTÁTICA del contrato de 0010_delivery_quote_result.sql (6D.2C).
 * No ejecuta SQL: escanea el DDL real (comentarios eliminados) para fijar
 * guardas, locking, idempotencia, ausencia de campos de dinero y grants.
 */

const sql = readFileSync(
  fileURLToPath(new URL('../../../supabase/migrations/0010_delivery_quote_result.sql', import.meta.url)),
  'utf8',
);
const code = sql.replace(/--[^\n]*/g, '');

describe('0010 — mark_delivery_quote_result: firma y locking', () => {
  it('crea la RPC con 3 args (uuid, text, integer)', () => {
    expect(code).toContain('create function public.mark_delivery_quote_result(');
    expect(code).toMatch(/p_order_id uuid/);
    expect(code).toMatch(/p_status text/);
    expect(code).toMatch(/p_distance_meters integer/);
  });

  it('serializa con SELECT ... FOR UPDATE', () => {
    expect(code).toMatch(/from public\.orders\s+where id = p_order_id\s+for update/);
  });
});

describe('0010 — guardas de dominio', () => {
  it('exige delivery + dynamic + awaiting_location', () => {
    expect(code).toContain("v_order.delivery_type <> 'delivery'");
    expect(code).toContain("v_order.delivery_pricing is distinct from 'dynamic'");
    expect(code).toContain("v_order.status <> 'awaiting_location'");
  });

  it('p_status solo admite failed | out_of_coverage', () => {
    expect(code).toMatch(/p_status not in \('failed', 'out_of_coverage'\)/);
  });

  it('out_of_coverage exige distancia > 18000', () => {
    expect(code).toContain('p_distance_meters <= 18000');
    expect(code).toContain('out_of_coverage requires distance_meters');
  });
});

describe('0010 — idempotencia y no-degradación', () => {
  it('devuelve applied / already_applied / conflict', () => {
    expect(code).toContain("v_result := 'applied'");
    expect(code).toContain("v_result := 'already_applied'");
    expect(code).toContain("'result', 'conflict'");
  });

  it('una cotización quoted nunca se degrada (conflict)', () => {
    expect(code).toContain("v_order.delivery_quote_status = 'quoted'");
  });
});

describe('0010 — NO toca dinero ni el status del pedido', () => {
  it('no referencia delivery_amount / total_amount / subtotal_amount / confirmed_at', () => {
    expect(code).not.toContain('delivery_amount');
    expect(code).not.toContain('total_amount');
    expect(code).not.toContain('subtotal_amount');
    expect(code).not.toContain('confirmed_at');
  });

  it('nunca confirma el pedido (no escribe status = confirmed)', () => {
    expect(code).not.toContain("'confirmed'");
  });

  it('solo escribe delivery_quote_status y delivery_distance_meters', () => {
    expect(code).toMatch(/set[\s\S]*delivery_quote_status\s*=/);
    expect(code).toMatch(/delivery_distance_meters\s*=/);
  });
});

describe('0010 — grants (solo service_role)', () => {
  it('revoca public/anon/authenticated y otorga service_role', () => {
    expect(code).toMatch(
      /revoke all on function public\.mark_delivery_quote_result[\s\S]*?from public/,
    );
    expect(code).toMatch(
      /revoke all on function public\.mark_delivery_quote_result[\s\S]*?from anon/,
    );
    expect(code).toMatch(
      /revoke all on function public\.mark_delivery_quote_result[\s\S]*?from authenticated/,
    );
    expect(code).toMatch(
      /grant execute on function public\.mark_delivery_quote_result[\s\S]*?to service_role/,
    );
  });
});
