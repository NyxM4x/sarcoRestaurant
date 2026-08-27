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

/**
 * Quien puede VER un comprobante y DECIDIR sobre un pago.
 *
 * Cocina entra aqui por una razon operativa, no por comodidad: no se empieza a
 * cocinar un pedido que no esta pagado, y quien tiene el ticket delante es quien
 * necesita comprobar el comprobante en ese momento. Esperar a que el encargado
 * lo mire desde otra pantalla es lo que hoy frena la plancha.
 *
 * ── Por que esto existe como funcion y no como `hasValidSession()` ──────────
 *
 * Antes ambas superficies —la accion de revision y el endpoint del archivo— se
 * protegian con `hasValidSession()`, que devuelve `true` para CUALQUIER rol. El
 * efecto practico era que cocina ya podia decidir pagos y abrir comprobantes; lo
 * unico que se lo impedia era que la interfaz no le entregara los UUID.
 *
 * Eso es un boton oculto haciendo de autorizacion, y un boton oculto no autoriza
 * nada: basta conocer un identificador para saltarselo. Ahora el permiso se
 * concede a proposito y se lee en un sitio, asi que cambiarlo es cambiar esta
 * linea —y no auditar cada ruta para descubrir a quien dejaba pasar.
 */
export function canReviewPayments(role: SessionRole): boolean {
  return role === 'admin' || role === 'kitchen';
}
