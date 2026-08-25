import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword, PASSWORD_SALT_ROUNDS } from './password';

describe('password — hashing con sal', () => {
  it('el hash no es la contrasena en claro', async () => {
    const hash = await hashPassword('zarco-secreto');
    expect(hash).not.toBe('zarco-secreto');
    expect(hash).not.toContain('zarco-secreto');
  });

  it('dos hashes de la MISMA contrasena son distintos (sal aleatoria)', async () => {
    const a = await hashPassword('misma');
    const b = await hashPassword('misma');
    expect(a).not.toBe(b);
    // Pero ambos verifican: la sal viaja dentro del propio hash.
    expect(await verifyPassword('misma', a)).toBe(true);
    expect(await verifyPassword('misma', b)).toBe(true);
  });

  it('usa el coste configurado y el formato bcrypt', async () => {
    expect(PASSWORD_SALT_ROUNDS).toBe(12);
    const hash = await hashPassword('x');
    expect(hash).toMatch(/^\$2[aby]\$12\$/);
  });
});

describe('password — verificacion', () => {
  it('acepta la contrasena correcta y rechaza la incorrecta', async () => {
    const hash = await hashPassword('correcta');
    expect(await verifyPassword('correcta', hash)).toBe(true);
    expect(await verifyPassword('incorrecta', hash)).toBe(false);
    expect(await verifyPassword('Correcta', hash)).toBe(false);
  });

  it('respeta caracteres especiales sin mutilarlos', async () => {
    // Caso real: una contrasena terminada en `$1` o con `%` debe funcionar tal
    // cual. Los valores son ficticios: las credenciales reales del restaurante
    // NUNCA entran al repositorio, solo se replican sus formas problematicas.
    for (const raw of ['claveDePrueba$1', 'otraClave%0', 'a b\tc', 'ñÑáé€']) {
      const hash = await hashPassword(raw);
      expect(await verifyPassword(raw, hash), raw).toBe(true);
      expect(await verifyPassword(raw.slice(0, -1), hash), raw).toBe(false);
    }
  });
});

describe('password — nunca lanza', () => {
  it('entradas vacias devuelven false sin explotar', async () => {
    const hash = await hashPassword('algo');
    expect(await verifyPassword('', hash)).toBe(false);
    expect(await verifyPassword('algo', '')).toBe(false);
    expect(await verifyPassword('', '')).toBe(false);
  });

  it('un hash corrupto en la base devuelve false, no tumba el login', async () => {
    for (const roto of ['no-es-un-hash', '$2b$12$demasiado-corto', '{}', '$$$$']) {
      await expect(verifyPassword('algo', roto)).resolves.toBe(false);
    }
  });
});
