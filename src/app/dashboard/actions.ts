'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { ORDER_STATUSES, type OrderStatus } from '@/types';
import {
  authenticateUser,
  establishSession,
  clearSession,
  hasValidSession,
  isDashboardAuthConfigured,
} from '@/lib/dashboard/auth';
import { landingPathForRole, LOGIN_PATH } from '@/lib/dashboard/session-role';
import { createOrdersRepository } from '@/lib/dashboard/orders-repository';
import { createSupabaseOrdersDataSource } from '@/lib/dashboard/data-source';

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
