import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Verificaciones estáticas de 6D.2B: como no hay Supabase local dedicado, NO se
 * ejecuta SQL. Se valida la ESTRUCTURA de 0009 por escaneo de texto y la PARIDAD
 * del tarifario entre fee.ts (fuente del flujo) y la fórmula defensiva de la RPC.
 */

const sql = readFileSync(
  fileURLToPath(new URL('../../../supabase/migrations/0009_dynamic_delivery.sql', import.meta.url)),
  'utf8',
);

// SQL sin comentarios de línea (`-- ...`): las aserciones sobre PRESENCIA/AUSENCIA
// de identificadores deben mirar solo el DDL real, no el texto explicativo del
// header (que a propósito nombra lo que NO se toca). Las aserciones sobre la
// DOCUMENTACIÓN (fee.ts, sincronización) miran el `sql` crudo.
const code = sql.replace(/--[^\n]*/g, '');

const routeSource = readFileSync(
  fileURLToPath(new URL('../../app/api/store/orders/route.ts', import.meta.url)),
  'utf8',
);

describe('0009 — columnas nuevas', () => {
  it('agrega delivery_pricing / delivery_quote_status / delivery_distance_meters', () => {
    expect(code).toContain('add column if not exists delivery_pricing text');
    expect(code).toContain('add column if not exists delivery_quote_status text');
    expect(code).toContain('add column if not exists delivery_distance_meters integer');
  });

  it('los CHECK reflejan los dominios cerrados', () => {
    expect(code).toContain("delivery_pricing is null or delivery_pricing = 'dynamic'");
    expect(code).toMatch(/delivery_quote_status in \('pending', 'quoted', 'failed', 'out_of_coverage'\)/);
    // Auditoría: distancia solo >= 0, NUNCA limitada a 18000 en la columna.
    expect(code).toContain('delivery_distance_meters is null or delivery_distance_meters >= 0');
    expect(code).not.toMatch(/delivery_distance_meters\s*<=\s*18000/);
  });
});

describe('0009 — RPC nuevas, sin tocar v2/legacy', () => {
  it('crea create_order_web_v3 y apply_delivery_quote', () => {
    expect(code).toContain('create function public.create_order_web_v3(');
    expect(code).toContain('create function public.apply_delivery_quote(');
  });

  it('v3 conserva la firma de 7 args de v2 (el cliente NO envía delivery_pricing)', () => {
    expect(code).toMatch(/create_order_web_v3\(\s*p_menu_session_id uuid/);
    expect(code).toMatch(/p_payment_method text\s*\)/);
    expect(code).not.toContain('p_delivery_pricing');
  });

  it('el servidor deriva delivery_pricing según delivery_type', () => {
    expect(code).toContain("v_delivery_pricing := 'dynamic'");
    expect(code).toContain("v_delivery_quote_status := 'pending'");
  });

  it('NO dropea ni reemplaza create_order_web ni create_order_web_v2', () => {
    expect(code).not.toMatch(/drop\s+function/i);
    expect(code).not.toMatch(/create\s+or\s+replace/i);
    expect(code).not.toContain('create_order_web_v2(');
  });
});

describe('0009 — NO toca notification recovery', () => {
  const forbidden = [
    'order_notifications',
    'claim_order_notification',
    'claim_notification_reconciliation',
    'select_due_notification_orders',
    'initialize_order_notifications',
    'mark_order_notification',
    'mark_notification',
    'recover_stale',
  ];
  for (const token of forbidden) {
    it(`no menciona ${token} en el DDL`, () => {
      expect(code).not.toContain(token);
    });
  }
});

describe('0009 — money guard: apply_delivery_quote', () => {
  it('no acepta un total del cliente; lo recalcula desde la base', () => {
    expect(code).not.toContain('p_total_amount');
    expect(code).toContain('v_total := v_order.subtotal_amount + p_delivery_amount');
  });

  it('rechaza > 18000 m (no cotiza fuera de cobertura)', () => {
    expect(code).toContain('p_distance_meters > 18000');
  });

  it('valida el tarifario contra p_delivery_amount', () => {
    expect(code).toContain('p_delivery_amount <> v_expected');
  });

  it('documenta explícitamente la sincronización con fee.ts', () => {
    // Estas viven EN los comentarios: se miran sobre el sql crudo.
    expect(sql).toContain('fee.ts');
    expect(sql).toContain('MANTENER SINCRONIZADO');
  });

  it('resultados idempotentes: applied / already_applied / conflict', () => {
    expect(code).toContain("'result', 'applied'");
    expect(code).toContain("'result', 'already_applied'");
    expect(code).toContain("'result', 'conflict'");
  });

  it('usa FOR UPDATE para serializar concurrencia', () => {
    expect(code).toMatch(/from public\.orders\s+where id = p_order_id\s+for update/);
  });
});

describe('0009 — grants (solo service_role)', () => {
  for (const fn of ['create_order_web_v3', 'apply_delivery_quote']) {
    it(`${fn}: revoca public/anon/authenticated y otorga service_role`, () => {
      expect(code).toMatch(new RegExp(`revoke all on function public\\.${fn}[\\s\\S]*?from public`));
      expect(code).toMatch(new RegExp(`revoke all on function public\\.${fn}[\\s\\S]*?from anon`));
      expect(code).toMatch(new RegExp(`revoke all on function public\\.${fn}[\\s\\S]*?from authenticated`));
      expect(code).toMatch(new RegExp(`grant execute on function public\\.${fn}[\\s\\S]*?to service_role`));
    });
  }
});

// 0032 movió el runtime a create_order_web_v4. Lo que este bloque protege es
// que nadie VUELVA a las versiones anteriores: v3 dejó de ser la vigente,
// pero v2 y la legacy nunca deben reaparecer.
describe('runtime no vuelve a las RPC antiguas (6D.2C / 0032)', () => {
  it('la ruta de checkout llama v3 y ya NO llama v2', () => {
    expect(routeSource).toContain('create_order_web_v4');
    expect(routeSource).not.toContain("rpc('create_order_web_v2'");
  });
});
