import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { authorizesVision } from './agent-gate';

/**
 * GUARDIÁN · el interruptor de captura NO es un permiso para Vision.
 *
 * ── Qué se está impidiendo que vuelva ───────────────────────────────────────
 *
 * La primera versión de la puerta devolvía `not_payment_proof` cuando
 * `PAYMENT_PROOF_CAPTURE_ENABLED` no valía 'true', razonando que con la captura
 * apagada no hay flujo de comprobantes y por tanto no hay nada que proteger.
 *
 * El razonamiento era falso: los comprobantes SIGUEN llegando por WhatsApp con
 * el flag apagado — lo único que deja de pasar es que los guardemos. Aquella
 * clasificación autorizaba a OpenAI exactamente los archivos que el sistema
 * había decidido no tocar, y una auditoría lo marcó como bypass.
 *
 * Esta prueba llama al `intakePaymentProof` REAL —no a un doble— porque lo que
 * hay que blindar es la respuesta de la implementación, no la de un fixture.
 * Con el flag apagado la función retorna antes de tocar Supabase, así que no
 * hace falta base de datos.
 */

const BASE = {
  SUPABASE_URL: 'https://ejemplo.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'clave-de-servicio',
};

const original = { ...process.env };

/** Ejecuta el intake real con el interruptor en el valor dado. */
async function intakeCon(flag: string | undefined) {
  vi.resetModules();
  process.env = { ...original, ...BASE };
  if (flag === undefined) delete process.env.PAYMENT_PROOF_CAPTURE_ENABLED;
  else process.env.PAYMENT_PROOF_CAPTURE_ENABLED = flag;

  const mod = await import('./intake-service');
  return mod.intakePaymentProof({
    sourceMessageId: 'wamid.GUARDIAN',
    customerPhone: '59100000000',
    attachment: null,
    declaredMimeType: 'image/jpeg',
    providerPhoneNumberId: 'pnid-1',
    receivedAtMs: Date.parse('2026-08-27T18:00:00.000Z'),
  });
}

beforeEach(() => {
  process.env = { ...original };
});
afterEach(() => {
  process.env = { ...original };
  vi.resetModules();
});

describe('GUARDIÁN · capture_disabled nunca equivale a not_payment_proof', () => {
  it('con el flag ausente, la clasificación NO autoriza Vision', async () => {
    const res = await intakeCon(undefined);
    expect(res.result).toBe('failed');
    // `reason` solo existe en la variante `failed`: se estrecha antes de leerlo.
    if (res.result === 'failed') expect(res.reason).toBe('capture_disabled');
    expect(res.proofClassification).not.toBe('not_payment_proof');
    expect(authorizesVision(res.proofClassification)).toBe(false);
  });

  it('con el flag vacío o con un typo, tampoco autoriza', async () => {
    for (const valor of ['', 'TRUE', 'True', '1', 'yes', 'si', 'enabled', 'tru']) {
      const res = await intakeCon(valor);
      expect(res.result, valor).toBe('failed');
      if (res.result === 'failed') expect(res.reason, valor).toBe('capture_disabled');
      expect(authorizesVision(res.proofClassification), valor).toBe(false);
    }
  });

  it('la degradación es segura: falla la captura, NO la privacidad', async () => {
    // Se afirma el par completo, que es el contrato de esta ruta: el
    // comprobante no se captura Y sus bytes no salen. Si alguien vuelve a
    // "arreglar" lo primero devolviendo `not_payment_proof`, esto falla.
    const res = await intakeCon(undefined);
    expect(res.result).toBe('failed');
    expect(res.proofClassification).toBe('unknown');
  });
});
