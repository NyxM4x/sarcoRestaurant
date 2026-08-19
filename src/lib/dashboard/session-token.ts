/**
 * Token de sesion del dashboard — modulo PURO (Node crypto).
 *
 * La cookie httpOnly guarda `<expMs>.<hmacHex>`. La firma HMAC-SHA256 sobre el
 * timestamp de expiracion impide falsificacion; la verificacion es en tiempo
 * constante y rechaza tokens vencidos. No guarda datos personales.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** Duracion por defecto de la sesion: 8 horas. */
export const DASHBOARD_SESSION_TTL_MS = 8 * 60 * 60 * 1000;

function sign(expMs: number, secret: string): string {
  return createHmac('sha256', secret).update(String(expMs), 'utf8').digest('hex');
}

/** Crea el valor de cookie firmado para una sesion que expira en `expMs`. */
export function createSessionToken(secret: string, nowMs: number, ttlMs: number = DASHBOARD_SESSION_TTL_MS): string {
  const expMs = nowMs + ttlMs;
  return `${expMs}.${sign(expMs, secret)}`;
}

/** Verifica firma y vigencia. Devuelve true solo si el token es autentico y no ha expirado. */
export function verifySessionToken(token: string | null | undefined, secret: string, nowMs: number): boolean {
  if (!token || !secret) return false;
  const dot = token.indexOf('.');
  if (dot <= 0) return false;
  const expPart = token.slice(0, dot);
  const sigPart = token.slice(dot + 1);
  if (!/^\d{1,15}$/.test(expPart) || !/^[0-9a-f]{64}$/.test(sigPart)) return false;

  const expMs = Number(expPart);
  const expected = sign(expMs, secret);
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(sigPart, 'utf8');
  if (a.length !== b.length) return false;
  if (!timingSafeEqual(a, b)) return false;
  return expMs > nowMs;
}

/** Nombre de la cookie de sesion del dashboard. */
export const DASHBOARD_COOKIE = 'lafija_dash';

/** Extrae el valor de la cookie de sesion desde un header Cookie crudo. */
export function readSessionCookie(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    if (part.slice(0, eq).trim() === DASHBOARD_COOKIE) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}
