'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { ORDER_STATUSES, type OrderStatus } from '@/types';
import {
  authenticateUser,
  establishSession,
  clearSession,
  hasValidSession,
  currentSessionRole,
  isDashboardAuthConfigured,
} from '@/lib/dashboard/auth';
import {
  canAccessAdmin,
  canReviewPayments,
  landingPathForRole,
  LOGIN_PATH,
} from '@/lib/dashboard/session-role';
import { setRainSurcharge } from '@/lib/delivery/settings';
import { createOrdersRepository } from '@/lib/dashboard/orders-repository';
import { createSupabaseOrdersDataSource } from '@/lib/dashboard/data-source';
import { decidePaymentAttempt } from '@/lib/payment-proof/decide-attempt';
import { isReviewDecision, type ReviewResult } from '@/lib/payment-proof/review-result';

export interface LoginState {
  error: 'invalid' | 'not_configured' | null;
}

/**
 * Login por usuario + contrasena contra `dashboard_users`. Es el MISMO
 * formulario para los dos roles: el rol guardado del usuario decide donde
 * aterriza (el cocinero en `/cocina`, el encargado en `/dashboard`).
 *
 * El mensaje de error es identico para usuario inexistente y contrasena mala,
 * para no revelar que nombres de usuario existen.
 */
export async function loginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  if (!isDashboardAuthConfigured()) return { error: 'not_configured' };
  const username = String(formData.get('username') ?? '');
  const password = String(formData.get('password') ?? '');
  const role = await authenticateUser(username, password);
  if (role === null) return { error: 'invalid' };
  await establishSession(role);
  redirect(landingPathForRole(role));
}

export async function logoutAction(): Promise<void> {
  await clearSession();
  redirect(LOGIN_PATH);
}

export type UpdateActionResult =
  | { ok: true; status: OrderStatus }
  | { ok: false; reason: 'unauthorized' | 'invalid_status' | 'not_found' | 'terminal' | 'invalid_transition' | 'conflict' | 'error' };

/**
 * Cambia el estado de un pedido. Valida sesion en servidor, valida el estado
 * destino y delega en el repositorio (que valida la transicion y usa guarda
 * optimista). Nunca toca order_notifications ni envia WhatsApp.
 */
export async function updateOrderStatusAction(
  orderNumber: string,
  to: string,
): Promise<UpdateActionResult> {
  if (!(await hasValidSession())) return { ok: false, reason: 'unauthorized' };
  if (!ORDER_STATUSES.includes(to as OrderStatus)) return { ok: false, reason: 'invalid_status' };
  if (typeof orderNumber !== 'string' || !/^[A-Za-z0-9-]{1,40}$/.test(orderNumber)) {
    return { ok: false, reason: 'not_found' };
  }

  try {
    const repo = createOrdersRepository(createSupabaseOrdersDataSource());
    const result = await repo.updateStatus(orderNumber, to as OrderStatus);
    if (result.ok) {
      revalidatePath('/dashboard');
      return { ok: true, status: result.status };
    }
    return { ok: false, reason: result.reason };
  } catch {
    // Error de base sanitizado: nunca se expone SQL ni stack al navegador.
    return { ok: false, reason: 'error' };
  }
}

/** Formato estricto de UUID; se valida ANTES de tocar la base. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Confirma o rechaza un intento de pago desde el panel.
 *
 * Frontera publica MINIMA: no se abre un endpoint de escritura: una Server
 * Action basta y ya viaja autenticada por la cookie de sesion.
 *
 * NO acepta el telefono del cliente desde el navegador. El aviso se manda a
 * partir del pedido que devuelve la propia RPC, leido en servidor; si el
 * navegador pudiera elegir el destinatario, cualquiera con sesion haria que el
 * sistema mandase mensajes a un numero arbitrario.
 *
 * `revalidatePath` solo se llama tras un resultado PERSISTIDO con exito: no
 * tiene sentido refrescar la vista por un intento fallido.
 */
export async function reviewPaymentAttemptAction(
  attemptId: string,
  decision: string,
): Promise<ReviewResult> {
  // Rol, no solo sesión: decidir un pago dispara un WhatsApp al cliente y cierra
  // el episodio de revisión. Quién puede hacerlo se lee en `canReviewPayments`.
  const role = await currentSessionRole();
  if (role === null || !canReviewPayments(role)) return { ok: false, reason: 'unauthorized' };
  if (!isReviewDecision(decision)) return { ok: false, reason: 'invalid_decision' };
  if (typeof attemptId !== 'string' || !UUID_RE.test(attemptId)) {
    return { ok: false, reason: 'not_found' };
  }

  const result = await decidePaymentAttempt(attemptId, decision);
  if (result.ok) revalidatePath('/dashboard');
  return result;
}

/**
 * Enciende o apaga la tarifa de lluvia (+3 Bs).
 *
 * Solo el encargado: es una decisión comercial que cambia lo que paga cada
 * cliente, y quien cocina no tiene por qué poder tocar precios. Por eso usa
 * `canAccessAdmin` y no `canReviewPayments` — dos permisos distintos para dos
 * cosas distintas.
 *
 * Afecta ÚNICAMENTE a las cotizaciones nuevas. Un pedido ya cotizado conserva su
 * precio: el cliente vio una cifra y esa es la que vale, llueva o escampe
 * después.
 */
export async function setRainSurchargeAction(
  active: boolean,
): Promise<{ ok: true; active: boolean } | { ok: false; reason: 'unauthorized' | 'error' }> {
  const role = await currentSessionRole();
  if (role === null || !canAccessAdmin(role)) return { ok: false, reason: 'unauthorized' };
  if (typeof active !== 'boolean') return { ok: false, reason: 'error' };

  const written = await setRainSurcharge(active);
  if (!written) return { ok: false, reason: 'error' };

  revalidatePath('/dashboard');
  return { ok: true, active };
}
