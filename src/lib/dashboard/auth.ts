import 'server-only';
import { cookies } from 'next/headers';
import { getServerEnv } from '@/lib/env/env';
import { safeCompare } from '@/lib/security/compare';
import {
  createSessionToken,
  verifySessionToken,
  readSessionCookie,
  DASHBOARD_COOKIE,
  DASHBOARD_SESSION_TTL_MS,
} from './session-token';

/**
 * Autenticacion del dashboard — server-only.
 *
 * Contrasena compartida + cookie httpOnly firmada HMAC. Fail-closed: si faltan
 * DASHBOARD_PASSWORD o DASHBOARD_SESSION_SECRET, nadie entra. La verificacion de
 * la contrasena es en tiempo constante; la cookie nunca guarda datos personales.
 */

interface DashboardAuthConfig {
  password: string;
  secret: string;
}

/** Config valida solo si ambos secretos existen y el secreto es suficientemente largo. */
function readConfig(): DashboardAuthConfig | null {
  let env;
  try {
    env = getServerEnv();
  } catch {
    return null;
  }
  const password = env.DASHBOARD_PASSWORD ?? '';
  const secret = env.DASHBOARD_SESSION_SECRET ?? '';
  if (password.length < 1 || secret.length < 32) return null;
  return { password, secret };
}

export function isDashboardAuthConfigured(): boolean {
  return readConfig() !== null;
}

/** Verifica la contrasena en tiempo constante. */
export function verifyDashboardPassword(candidate: string): boolean {
  const cfg = readConfig();
  if (!cfg) return false;
  return safeCompare(candidate, cfg.password);
}

/** Verifica la cookie de sesion de un Request (para route handlers). */
export function isRequestAuthorized(request: Request): boolean {
  const cfg = readConfig();
  if (!cfg) return false;
  const token = readSessionCookie(request.headers.get('cookie'));
  return verifySessionToken(token, cfg.secret, Date.now());
}

/** ¿La sesion actual (cookie del contexto server) es valida? */
export async function hasValidSession(): Promise<boolean> {
  const cfg = readConfig();
  if (!cfg) return false;
  const store = await cookies();
  const token = store.get(DASHBOARD_COOKIE)?.value ?? null;
  return verifySessionToken(token, cfg.secret, Date.now());
}

/** Crea la sesion (tras validar la contrasena) escribiendo la cookie httpOnly. */
export async function establishSession(): Promise<boolean> {
  const cfg = readConfig();
  if (!cfg) return false;
  const value = createSessionToken(cfg.secret, Date.now());
  const store = await cookies();
  store.set(DASHBOARD_COOKIE, value, {
    httpOnly: true,
    // Secure en producción (https); permisivo en dev local (http://localhost).
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: Math.floor(DASHBOARD_SESSION_TTL_MS / 1000),
  });
  return true;
}

/** Cierra la sesion borrando la cookie. */
export async function clearSession(): Promise<void> {
  const store = await cookies();
  store.set(DASHBOARD_COOKIE, '', {
    httpOnly: true,
    // Secure en producción (https); permisivo en dev local (http://localhost).
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
}
