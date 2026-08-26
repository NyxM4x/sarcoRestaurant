import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * El interruptor de la captura de comprobantes.
 *
 * `getServerEnv()` cachea tras la primera validacion, asi que cada caso exige
 * resetear los modulos: sin eso el primer valor probado contamina al resto.
 */
const BASE = {
  SUPABASE_URL: 'https://ejemplo.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'clave-de-servicio',
};

const original = { ...process.env };

async function switchWith(value: string | undefined): Promise<boolean> {
  vi.resetModules();
  process.env = { ...original, ...BASE };
  if (value === undefined) delete process.env.PAYMENT_PROOF_CAPTURE_ENABLED;
  else process.env.PAYMENT_PROOF_CAPTURE_ENABLED = value;
  const mod = await import('./intake-service');
  return mod.isProofCaptureEnabled();
}

beforeEach(() => {
  process.env = { ...original };
});
afterEach(() => {
  process.env = { ...original };
  vi.resetModules();
});

describe('interruptor de captura de comprobantes', () => {
  it('SOLO la cadena exacta `true` la enciende', async () => {
    expect(await switchWith('true')).toBe(true);
  });

  it('ausente o vacia la deja apagada', async () => {
    expect(await switchWith(undefined)).toBe(false);
    expect(await switchWith('')).toBe(false);
  });

  it('un valor parecido NO la enciende (nada de encenderla por accidente)', async () => {
    for (const valor of ['TRUE', 'True', '1', 'yes', 'si', 'enabled', 'tru']) {
      expect(await switchWith(valor), valor).toBe(false);
    }
  });

  it('sin entorno valido queda apagada (fail-closed)', async () => {
    vi.resetModules();
    process.env = { ...original };
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    process.env.PAYMENT_PROOF_CAPTURE_ENABLED = 'true';
    const mod = await import('./intake-service');
    expect(mod.isProofCaptureEnabled()).toBe(false);
  });
});
