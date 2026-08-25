import 'server-only';
import { cookies } from 'next/headers';
import { getServerEnv } from '@/lib/env/env';
import {
  createSessionToken,
  readSessionRole,
  verifySessionToken,
  readSessionCookie,
  DASHBOARD_COOKIE,
  DASHBOARD_SESSION_TTL_MS,
  type SessionRole,
} from './session-token';
import { createUsersRepository } from './users-repository';
import { createSupabaseUsersDataSource } from './users-data-source';

/**
 * Autenticacion del acceso interno — server-only.
 *
 * Usuario + contrasena contra la tabla `dashboard_users` (migracion 0020), mas
 * cookie httpOnly firmada HMAC. Ya NO existen contrasenas compartidas por
 * variable de entorno: el rol de cada persona vive en la base.
 *
 * Fail-closed: sin DASHBOARD_SESSION_SECRET no se puede firmar ninguna cookie,
 * asi que nadie entra. La cookie prueba QUE ROL tiene la sesion (`admin` o
 * `kitchen`) y nunca guarda datos personales; la politica de a que puede entrar
 * cada rol vive en `session-role.ts`, que es puro y testeable.
 */

interface DashboardAuthConfig {
  secret: string;
}

/**
 * Config valida solo si el secreto de firma existe y es suficientemente largo.
 * Las credenciales ya no viven aqui: estan en `dashboard_users`.
 */
function readConfig(): DashboardAuthConfig | null {
  let env;
  try {
    env = getServerEnv();
  } catch {
    return null;
  }
  const secret = env.DASHBOARD_SESSION_SECRET ?? '';
  if (secret.length < 32) return null;
  return { secret };
}

export function isDashboardAuthConfigured(): boolean {
  return readConfig() !== null;
}

/**
 * Valida usuario + contrasena contra la base y devuelve el rol probado.
 * `null` si las credenciales no valen o el servidor no esta configurado.
 */
export async function authenticateUser(
  username: string,
  password: string,
): Promise<SessionRole | null> {
  if (!readConfig()) return null;
  try {
    const repo = createUsersRepository(createSupabaseUsersDataSource());
    return await repo.authenticate(username, password);
  } catch {
    // Error de base sanitizado: un fallo de conexion no distingue de
    // credenciales malas hacia el cliente, y nunca expone SQL ni stack.
    return null;
  }
}

/** Verifica la cookie de sesion de un Request (para route handlers). */
export function isRequestAuthorized(request: Request): boolean {
  const cfg = readConfig();
  if (!cfg) return false;
  const token = readSessionCookie(request.headers.get('cookie'));
  return verifySessionToken(token, cfg.secret, Date.now());
}

/** Rol probado por la cookie de un Request (para route handlers). `null` si no hay sesion. */
export function requestSessionRole(request: Request): SessionRole | null {
  const cfg = readConfig();
  if (!cfg) return null;
  const token = readSessionCookie(request.headers.get('cookie'));
  return readSessionRole(token, cfg.secret, Date.now());
}

/** Rol de la sesion actual (cookie del contexto server). `null` si no hay sesion valida. */
export async function currentSessionRole(): Promise<SessionRole | null> {
  const cfg = readConfig();
  if (!cfg) return null;
  const store = await cookies();
  const token = store.get(DASHBOARD_COOKIE)?.value ?? null;
  return readSessionRole(token, cfg.secret, Date.now());
}

/** ¿La sesion actual (cookie del contexto server) es valida? */
export async function hasValidSession(): Promise<boolean> {
  return (await currentSessionRole()) !== null;
}

/** Crea la sesion (tras validar la contrasena) escribiendo la cookie httpOnly. */
export async function establishSession(role: SessionRole = 'admin'): Promise<boolean> {
  const cfg = readConfig();
  if (!cfg) return false;
  const value = createSessionToken(cfg.secret, Date.now(), DASHBOARD_SESSION_TTL_MS, role);
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
