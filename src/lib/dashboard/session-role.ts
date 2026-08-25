/**
 * Politica de rutas por rol — modulo PURO (sin server-only).
 *
 * Decide UNA cosa: a que puede entrar cada rol y donde aterriza al ingresar.
 * QUIEN tiene cada rol lo decide `users-repository.ts` contra la base. Vive
 * separado de `auth.ts` (server-only) para poder probarlo sin Next.
 */
import type { SessionRole } from './session-token';

/** Donde aterriza cada rol al entrar. */
export const ADMIN_HOME = '/dashboard';
export const KITCHEN_HOME = '/cocina';
export const LOGIN_PATH = '/dashboard/login';

/** Ruta de aterrizaje tras el login: cada rol va donde trabaja. */
export function landingPathForRole(role: SessionRole): string {
  return role === 'kitchen' ? KITCHEN_HOME : ADMIN_HOME;
}

/** El panel administrativo es exclusivo del encargado. */
export function canAccessAdmin(role: SessionRole): boolean {
  return role === 'admin';
}

/** La cocina la ve el cocinero y tambien el encargado (a veces mira el tablero). */
export function canAccessKitchen(role: SessionRole): boolean {
  return role === 'kitchen' || role === 'admin';
}
