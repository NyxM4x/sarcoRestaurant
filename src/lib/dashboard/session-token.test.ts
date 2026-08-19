import { describe, it, expect } from 'vitest';
import {
  createSessionToken,
  verifySessionToken,
  readSessionCookie,
  DASHBOARD_COOKIE,
} from './session-token';

const SECRET = 'a'.repeat(40);

describe('session-token — firma HMAC de la cookie', () => {
  it('1. token válido reciente verifica true; sin token, false', () => {
    const now = Date.parse('2026-08-06T12:00:00Z');
    const token = createSessionToken(SECRET, now);
    expect(verifySessionToken(token, SECRET, now + 1000)).toBe(true);
    expect(verifySessionToken(null, SECRET, now)).toBe(false);
    expect(verifySessionToken('', SECRET, now)).toBe(false);
  });

  it('token expirado se rechaza', () => {
    const now = Date.parse('2026-08-06T12:00:00Z');
    const token = createSessionToken(SECRET, now, 1000);
    expect(verifySessionToken(token, SECRET, now + 2000)).toBe(false);
  });

  it('firma inválida o secreto distinto se rechaza (no falsificable)', () => {
    const now = Date.now();
    const token = createSessionToken(SECRET, now);
    expect(verifySessionToken(token, 'b'.repeat(40), now)).toBe(false);
    const [exp] = token.split('.');
    expect(verifySessionToken(`${exp}.${'0'.repeat(64)}`, SECRET, now)).toBe(false);
    expect(verifySessionToken('garbage', SECRET, now)).toBe(false);
    expect(verifySessionToken(`${Number(exp) + 999999}.${token.split('.')[1]}`, SECRET, now)).toBe(false);
  });

  it('readSessionCookie extrae solo la cookie del dashboard', () => {
    expect(readSessionCookie(`other=1; ${DASHBOARD_COOKIE}=abc.def; x=2`)).toBe('abc.def');
    expect(readSessionCookie('other=1')).toBeNull();
    expect(readSessionCookie(null)).toBeNull();
  });
});
