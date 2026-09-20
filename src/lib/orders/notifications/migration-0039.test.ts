import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Verificación ESTÁTICA del contrato de 0039_mensaje_unico_de_ingreso.sql.
 *
 * Lo que fija: el delivery dinámico deja de crear `order_received`, la ubicación
 * dinámica deja de depender de ella en las DOS funciones que la reclaman, el
 * camino legacy conserva su dependencia, y nada de esto borra una sola fila.
 *
 * Es estática porque aquí no hay Postgres: contrasta el texto del archivo, igual
 * que el resto de tests de migración del proyecto.
 */

const sql = readFileSync(
  fileURLToPath(
    new URL('../../../../supabase/migrations/0039_mensaje_unico_de_ingreso.sql', import.meta.url),
  ),
  'utf8',
);
/** Sin comentarios: lo que se comprueba es lo que Postgres va a ejecutar. */
const code = sql.replace(/--[^\n]*/g, '');

describe('0039 — reemplaza exactamente las tres funciones del orden', () => {
  for (const fn of [
    'initialize_order_notifications',
    'claim_order_notification',
    'claim_notification_reconciliation',
  ]) {
    it(`create or replace de ${fn}`, () => {
      expect(code).toMatch(new RegExp(`create or replace function public\\.${fn}\\(`));
    });
  }

  it('no toca ninguna otra función', () => {
    for (const fn of [
      'select_due_notification_orders',
      'mark_order_notification_sent',
      'mark_location_request_sent',
      'terminalize_exhausted_reconciliation',
      'create_order_web',
    ]) {
      expect(code, fn).not.toContain(`create or replace function public.${fn}(`);
    }
  });

  it('va en una transacción', () => {
    expect(code).toMatch(/\bbegin;/);
    expect(code).toMatch(/\bcommit;/);
  });
});

describe('0039 — el dinámico ya no crea la fila de recepción', () => {
  it('las filas del delivery son confirmation y location_request', () => {
    expect(code).toContain("v_types := array['confirmation', 'location_request'];");
    // Si alguien devuelve order_received a esa lista, vuelven los dos mensajes.
    expect(code).not.toContain("array['order_received', 'confirmation', 'location_request']");
  });

  it('en dinámico la ubicación nace despierta y la confirmación dormida', () => {
    // El mensaje que sale al confirmar el pedido es el de ubicación; la
    // confirmación sigue esperando a que haya cotización aplicada.
    expect(code).toContain("if v_dynamic and v_type = 'confirmation' then");
  });
});

describe('0039 — la ubicación dinámica deja de esperar a la recepción', () => {
  it('ninguna función puede devolver ya `order_received_not_sent`', () => {
    // Era el motivo por el que la ubicación no se podía reclamar. Si sobrevive
    // en alguna de las dos, ese pedido se queda sin pedir la ubicación: el
    // mensaje que la pedía ya no existe como fila propia.
    expect(code).not.toContain('order_received_not_sent');
  });

  it('legacy conserva su dependencia de la confirmación', () => {
    expect(code).toContain('confirmation_not_sent');
    expect(code).toContain("v_pricing is distinct from 'dynamic'");
  });

  it('la caída de la dependencia está en las dos funciones que reclaman', () => {
    const claim = code.slice(code.indexOf('create or replace function public.claim_order_notification('));
    const reconciliacion = code.slice(
      code.indexOf('create or replace function public.claim_notification_reconciliation('),
    );
    for (const [nombre, bloque] of [
      ['claim_order_notification', claim.slice(0, claim.indexOf('$$;'))],
      ['claim_notification_reconciliation', reconciliacion.slice(0, reconciliacion.indexOf('$$;'))],
    ] as const) {
      expect(bloque, nombre).toContain("v_pricing is distinct from 'dynamic'");
      expect(bloque, nombre).not.toContain("notification_type = 'order_received'");
    }
  });
});

describe('0039 — no se pierde nada de lo ya enviado', () => {
  it('no borra filas ni tablas', () => {
    expect(code).not.toMatch(/\bdelete\s+from\b/i);
    expect(code).not.toMatch(/\bdrop\s+(table|column)\b/i);
    expect(code).not.toMatch(/\btruncate\b/i);
  });

  it('solo cierra las recepciones que seguían PENDIENTES', () => {
    const update = code.slice(code.indexOf('update public.order_notifications\n   set terminal_at'));
    expect(update).toContain("where notification_type = 'order_received'");
    expect(update).toContain("and status = 'pending'");
    // Lo enviado es el historial de lo que de verdad salió: no se toca.
    expect(update).not.toContain("'sent'");
  });

  it('el estado de los pedidos no se toca', () => {
    expect(code).not.toMatch(/update\s+public\.orders\b/i);
  });
});
