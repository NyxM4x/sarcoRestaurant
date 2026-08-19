import { describe, it, expect } from 'vitest';
import { buildAlertMessage, categorizeReason, MAX_ALERT_TEXT_LENGTH } from './alert-message';

const NOW = Date.parse('2026-07-31T18:05:00.000Z');

function msg(over: Partial<Parameters<typeof buildAlertMessage>[0]> = {}) {
  return buildAlertMessage({
    orderNumber: 'ORD-000042',
    notificationType: 'confirmation',
    reasonCode: 'provider_failed',
    reviewKind: 'manual_review',
    now: NOW,
    ...over,
  });
}

describe('buildAlertMessage — contenido sanitizado', () => {
  it('incluye número de pedido, tipo traducido, motivo y estado', () => {
    const t = msg();
    expect(t).toContain('ORD-000042');
    expect(t).toContain('Confirmación');
    expect(t).toContain('Revisión requerida');
    expect(t).toContain('Acción');
  });

  it('traduce location_request', () => {
    expect(msg({ notificationType: 'location_request' })).toContain('Solicitud de ubicación');
  });

  it('25. nunca incluye teléfono', () => {
    // Aunque el número de pedido tuviera dígitos, no debe aparecer un teléfono.
    const t = msg({ orderNumber: 'ORD-000042' });
    expect(t).not.toMatch(/\b\d{8,15}\b/);
  });

  it('26. nunca incluye coordenadas', () => {
    const t = msg();
    expect(t).not.toMatch(/-?\d{1,3}\.\d{3,}/); // lat/long
  });

  it('27. nunca incluye wamid ni ids técnicos', () => {
    const t = msg();
    expect(t.toLowerCase()).not.toContain('wamid');
    expect(t).not.toContain('claim_token');
    expect(t).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i); // uuid
  });

  it('un reasonCode desconocido no filtra el código crudo', () => {
    const t = msg({ reasonCode: 'http_500_secret_detail' });
    expect(t).not.toContain('http_500_secret_detail');
    expect(t).toContain('Requiere revisión manual');
  });

  it('sanea saltos de línea y < > del número de pedido', () => {
    const t = msg({ orderNumber: 'ORD-1\n<script>' });
    expect(t).not.toContain('<script>');
    expect(t).not.toContain('\r');
  });

  it('recorta a la longitud máxima', () => {
    const t = msg({ orderNumber: 'X'.repeat(2000) });
    expect(t.length).toBeLessThanOrEqual(MAX_ALERT_TEXT_LENGTH);
  });

  it('categorizeReason mapea códigos conocidos y desconocidos', () => {
    expect(categorizeReason('provider_failed')).toContain('proveedor');
    expect(categorizeReason('reconciliation_attempts_exhausted')).toContain('reconciliar');
    expect(categorizeReason('algo_raro')).toBe('Requiere revisión manual');
  });
});
