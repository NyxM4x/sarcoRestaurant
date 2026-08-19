import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Verificación ESTÁTICA del contrato de 0013_dynamic_delivery_notifications.sql
 * (6D.2C). Fija: reemplazo de las 9 funciones, gates de 3 fases (order_received →
 * location_request → confirmation), preservación de la 4ª rama de 0006 y el
 * whitelist de order_received en cada función que valida el tipo.
 */

const sql = readFileSync(
  fileURLToPath(
    new URL('../../../supabase/migrations/0013_dynamic_delivery_notifications.sql', import.meta.url),
  ),
  'utf8',
);
const code = sql.replace(/--[^\n]*/g, '');

const REPLACED = [
  'initialize_order_notifications',
  'claim_order_notification',
  'claim_notification_reconciliation',
  'select_due_notification_orders',
  'recover_stale_sending_notification',
  'mark_order_notification_sent',
  'mark_notification_sent_by_webhook',
  'schedule_notification_send',
  'terminalize_exhausted_reconciliation',
];

describe('0013 — reemplaza las 9 funciones necesarias (y solo esas)', () => {
  for (const fn of REPLACED) {
    it(`create or replace de ${fn}`, () => {
      expect(code).toMatch(new RegExp(`create or replace function public\\.${fn}\\(`));
    });
  }

  it('NO reemplaza mark_location_request / mark_failed / reschedule / helpers internos', () => {
    for (const fn of [
      'mark_location_request_sent',
      'mark_order_notification_failed',
      'mark_order_notification_pending_reconciliation',
      'mark_reconciliation_sent',
      'reschedule_notification_reconciliation',
      'internal_apply_notification_sent',
      'is_ambiguous_notification_error',
    ]) {
      expect(code).not.toMatch(new RegExp(`create or replace function public\\.${fn}\\(`));
    }
  });

  it('no altera la tabla ni el CHECK de notification_type (eso es 0012)', () => {
    expect(code).not.toMatch(/alter table/i);
    expect(code).not.toContain('order_notifications_type_check');
  });
});

describe('0013 — order_received admitido en el whitelist de tipo', () => {
  it('las funciones que validan el tipo aceptan los TRES', () => {
    const matches = code.match(
      /not in \('order_received', 'confirmation', 'location_request'\)/g,
    );
    // claim, claim_recon, recover_stale, mark_by_webhook, schedule_send, terminalize.
    expect(matches).not.toBeNull();
    expect((matches ?? []).length).toBeGreaterThanOrEqual(6);
  });

  it('mark_order_notification_sent cierra confirmation u order_received (no ubicación)', () => {
    expect(code).toContain("v_row.notification_type not in ('confirmation', 'order_received')");
  });
});

describe('0013 — initialize dynamic: 3 filas, order_received activa', () => {
  it('dynamic crea order_received + confirmation + location_request', () => {
    expect(code).toContain("array['order_received', 'confirmation', 'location_request']");
  });

  it('legacy delivery conserva solo confirmation + location_request', () => {
    expect(code).toContain("array['confirmation', 'location_request']");
  });

  it('en dynamic solo order_received nace programada; el resto dormido (NULL)', () => {
    expect(code).toMatch(
      /if v_dynamic and v_type <> 'order_received' then\s+v_next_attempt := null;\s+else\s+v_next_attempt := now\(\)/,
    );
  });
});

describe('0013 — gates de 3 fases (claim)', () => {
  it('confirmation dinámica bloqueada hasta quoted', () => {
    expect(code).toContain('quote_not_applied');
    expect(code).toMatch(/v_pricing = 'dynamic'\s+and v_quote is distinct from 'quoted'/);
  });

  it('location dinámica exige order_received sent; legacy exige confirmation sent', () => {
    expect(code).toContain('order_received_not_sent');
    expect(code).toContain('confirmation_not_sent');
    expect(code).toMatch(
      /orr\.notification_type = 'order_received'\s+and orr\.status = 'sent'/,
    );
  });

  it('order_received no tiene dependencias (no aparece un gate propio que lo bloquee)', () => {
    // Su rama de location/confirmation no lo menciona como bloqueante.
    expect(code).not.toContain('order_received_not_initialized');
  });
});

describe('0013 — select_due preserva 0006 (regresión) + ramas dinámicas', () => {
  it('CONSERVA la 4ª rama de 0006: reconciling stale claimed_at < now-300s', () => {
    expect(code).toMatch(
      /n\.status = 'reconciling'\s+and n\.claimed_at is not null\s+and n\.claimed_at < now\(\) - interval '300 seconds'/,
    );
  });

  it('conserva sending stale 120s y reconciliation due', () => {
    expect(code).toMatch(/n\.status = 'sending'[\s\S]*?interval '120 seconds'/);
    expect(code).toContain("n.status = 'pending_reconciliation'");
  });

  it('excluye la confirmación de un dinámico no cotizado', () => {
    expect(code).toMatch(
      /o\.delivery_pricing = 'dynamic'\s+and o\.delivery_quote_status is distinct from 'quoted'/,
    );
  });

  it('descubre confirmación dinámica quoted y ubicación dinámica dormida', () => {
    expect(code).toMatch(
      /o\.delivery_pricing = 'dynamic'\s+and o\.delivery_quote_status = 'quoted'\s+and o\.status = 'confirmed'/,
    );
    expect(code).toMatch(
      /n\.notification_type = 'location_request'\s+and n\.status = 'pending'[\s\S]*?o\.delivery_pricing = 'dynamic'/,
    );
  });

  it('gate de ubicación: legacy confirmation-sent OR dinámico order_received-sent', () => {
    expect(code).toMatch(
      /o\.delivery_pricing = 'dynamic'\s+and orr\.status = 'sent'/,
    );
  });
});

describe('0013 — grants solo service_role para las 9 funciones', () => {
  it('otorga execute a service_role y revoca anon/authenticated vía bucle', () => {
    expect(code).toMatch(/grant execute on function public\.%s to service_role/);
    expect(code).toMatch(/revoke all on function public\.%s from anon/);
    for (const fn of REPLACED) {
      expect(code).toContain(fn + '(');
    }
  });
});
