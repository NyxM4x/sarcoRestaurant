import { describe, expect, it } from 'vitest';
import {
  generateMenuSessionToken,
  hashMenuSessionToken,
  verifyMenuSessionToken,
} from './session-token';

const TEST_SECRET = 'test-menu-session-secret-32-chars-minimum';
const TEST_MESSAGE_ID = 'wamid.HBEWAEFBDUMwEwghzC9B-test';

describe('generateMenuSessionToken', () => {
  it('genera un token opaco reproducible (HMAC)', () => {
    const token1 = generateMenuSessionToken(TEST_MESSAGE_ID, TEST_SECRET);
    const token2 = generateMenuSessionToken(TEST_MESSAGE_ID, TEST_SECRET);

    // Mismo source_message_id + mismo secret = mismo token (idempotencia)
    expect(token1).toBe(token2);
  });

  it('tokens diferentes para source_message_id diferentes', () => {
    const token1 = generateMenuSessionToken('message-1', TEST_SECRET);
    const token2 = generateMenuSessionToken('message-2', TEST_SECRET);

    expect(token1).not.toBe(token2);
  });

  it('tokens diferentes para secretos diferentes', () => {
    const token1 = generateMenuSessionToken(TEST_MESSAGE_ID, 'secret-1');
    const token2 = generateMenuSessionToken(TEST_MESSAGE_ID, 'secret-2');

    expect(token1).not.toBe(token2);
  });

  it('el token es URL-safe (base64url)', () => {
    const token = generateMenuSessionToken(TEST_MESSAGE_ID, TEST_SECRET);
    // base64url solo contiene: A-Z, a-z, 0-9, -, _
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('el token nunca es vacío', () => {
    const token = generateMenuSessionToken(TEST_MESSAGE_ID, TEST_SECRET);
    expect(token.length).toBeGreaterThan(0);
  });
});

describe('hashMenuSessionToken', () => {
  it('produce un hash SHA-256 en hexadecimal', () => {
    const token = generateMenuSessionToken(TEST_MESSAGE_ID, TEST_SECRET);
    const hash = hashMenuSessionToken(token);

    // SHA-256 = 32 bytes = 64 caracteres hexadecimales
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('siempre produce el mismo hash para el mismo token', () => {
    const token = generateMenuSessionToken(TEST_MESSAGE_ID, TEST_SECRET);
    const hash1 = hashMenuSessionToken(token);
    const hash2 = hashMenuSessionToken(token);

    expect(hash1).toBe(hash2);
  });

  it('produce hashes diferentes para tokens diferentes', () => {
    const token1 = generateMenuSessionToken('msg-1', TEST_SECRET);
    const token2 = generateMenuSessionToken('msg-2', TEST_SECRET);

    const hash1 = hashMenuSessionToken(token1);
    const hash2 = hashMenuSessionToken(token2);

    expect(hash1).not.toBe(hash2);
  });

  it('nunca expone el source_message_id en el hash', () => {
    const token = generateMenuSessionToken(TEST_MESSAGE_ID, TEST_SECRET);
    const hash = hashMenuSessionToken(token);

    // El message_id nunca debe aparecer en texto plano en el hash
    expect(hash).not.toContain(TEST_MESSAGE_ID);
  });

  it('nunca expone el secreto en el hash', () => {
    const token = generateMenuSessionToken(TEST_MESSAGE_ID, TEST_SECRET);
    const hash = hashMenuSessionToken(token);

    // El secreto nunca debe aparecer en texto plano
    expect(hash).not.toContain('secret');
  });
});

describe('verifyMenuSessionToken', () => {
  it('devuelve true para un token y su hash correspondiente', () => {
    const token = generateMenuSessionToken(TEST_MESSAGE_ID, TEST_SECRET);
    const hash = hashMenuSessionToken(token);

    expect(verifyMenuSessionToken(token, hash)).toBe(true);
  });

  it('devuelve false si el token no coincide', () => {
    const token1 = generateMenuSessionToken('msg-1', TEST_SECRET);
    const token2 = generateMenuSessionToken('msg-2', TEST_SECRET);
    const hash = hashMenuSessionToken(token1);

    expect(verifyMenuSessionToken(token2, hash)).toBe(false);
  });

  it('devuelve false si el hash está corrupto', () => {
    const token = generateMenuSessionToken(TEST_MESSAGE_ID, TEST_SECRET);
    const wrongHash = 'a'.repeat(64);

    expect(verifyMenuSessionToken(token, wrongHash)).toBe(false);
  });

  it('devuelve false para un token vacío', () => {
    const hash = hashMenuSessionToken('algo');
    expect(verifyMenuSessionToken('', hash)).toBe(false);
  });

  it('devuelve false para hash vacío', () => {
    const token = generateMenuSessionToken(TEST_MESSAGE_ID, TEST_SECRET);
    expect(verifyMenuSessionToken(token, '')).toBe(false);
  });

  it('usa timing-safe comparison', () => {
    // Este test solo valida que no lance excepción
    const token = generateMenuSessionToken(TEST_MESSAGE_ID, TEST_SECRET);
    const correctHash = hashMenuSessionToken(token);
    const wrongHash = 'b'.repeat(64);

    expect(verifyMenuSessionToken(token, wrongHash)).toBe(false);
    expect(verifyMenuSessionToken('wrong', correctHash)).toBe(false);
  });
});
