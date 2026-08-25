/**
 * Token de sesion del dashboard — modulo PURO (Node crypto).
 *
 * La cookie httpOnly guarda `<expMs>.<rol>.<hmacHex>`. La firma HMAC-SHA256
 * cubre el mensaje `${expMs}.${rol}`: el ROL forma parte de lo firmado, asi que
 * editar la cookie a mano NO asciende a nadie de cocinero a administrador. La
 * verificacion es en tiempo constante y rechaza tokens vencidos. No guarda
 * datos personales.
 *
 * Retrocompatibilidad: los tokens del formato anterior (`<expMs>.<hmacHex>`,
 * firmados solo sobre la expiracion) siguen valiendo como `admin` hasta que
 * caduquen, para que nadie pierda su sesion con el despliegue.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** Roles que puede probar la cookie. `admin` gobierna el panel; `kitchen` la cocina. */
export const SESSION_ROLES = ['admin', 'kitchen'] as const;
export type SessionRole = (typeof SESSION_ROLES)[number];

/** Duracion por defecto de la sesion: 8 horas. */
export const DASHBOARD_SESSION_TTL_MS = 8 * 60 * 60 * 1000;

function isSessionRole(value: string): value is SessionRole {
  return (SESSION_ROLES as readonly string[]).includes(value);
}

/** Firma del formato ACTUAL: el rol viaja dentro del mensaje firmado. */
function sign(expMs: number, role: SessionRole, secret: string): string {
  return createHmac('sha256', secret).update(`${expMs}.${role}`, 'utf8').digest('hex');
}

/** Firma del formato ANTERIOR (solo la expiracion). Solo se usa para verificar. */
function signLegacy(expMs: number, secret: string): string {
  return createHmac('sha256', secret).update(String(expMs), 'utf8').digest('hex');
}

/** Comparacion de firmas hex en tiempo constante. */
function hexEquals(expected: string, actual: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(actual, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Crea el valor de cookie firmado para una sesion que expira en `expMs`. */
export function createSessionToken(
  secret: string,
  nowMs: number,
  ttlMs: number = DASHBOARD_SESSION_TTL_MS,
  role: SessionRole = 'admin',
): string {
  const expMs = nowMs + ttlMs;
  return `${expMs}.${role}.${sign(expMs, role, secret)}`;
}

/**
 * Verifica firma y vigencia, y devuelve el ROL probado por el token.
 * `null` si el token falta, esta mal formado, lleva un rol desconocido, la
 * firma no cuadra o ya expiro.
 */
export function readSessionRole(
  token: string | null | undefined,
  secret: string,
  nowMs: number,
): SessionRole | null {
  if (!token || !secret) return null;
  const parts = token.split('.');
  // 3 partes = formato actual (con rol); 2 = formato legacy (solo expiracion).
  if (parts.length !== 2 && parts.length !== 3) return null;

  const expPart = parts[0];
  const sigPart = parts[parts.length - 1];
  if (!/^\d{1,15}$/.test(expPart) || !/^[0-9a-f]{64}$/.test(sigPart)) return null;
  const expMs = Number(expPart);

  let role: SessionRole;
  let expected: string;
  if (parts.length === 3) {
    const rolePart = parts[1];
    // Un rol inventado se rechaza antes de firmar nada.
    if (!isSessionRole(rolePart)) return null;
    role = rolePart;
    expected = sign(expMs, role, secret);
  } else {
    // Sesion emitida antes de que existieran los roles: era del panel admin.
    role = 'admin';
    expected = signLegacy(expMs, secret);
  }

  if (!hexEquals(expected, sigPart)) return null;
  return expMs > nowMs ? role : null;
}

/** Verifica firma y vigencia. Devuelve true solo si el token es autentico y no ha expirado. */
export function verifySessionToken(
  token: string | null | undefined,
  secret: string,
  nowMs: number,
): boolean {
  return readSessionRole(token, secret, nowMs) !== null;
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
