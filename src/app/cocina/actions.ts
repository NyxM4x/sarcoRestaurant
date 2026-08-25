'use server';

import { redirect } from 'next/navigation';
import { currentSessionRole, clearSession } from '@/lib/dashboard/auth';
import { canAccessKitchen, LOGIN_PATH } from '@/lib/dashboard/session-role';
import { createKitchenRepository } from '@/lib/kitchen/tickets-repository';
import { createSupabaseKitchenDataSource } from '@/lib/kitchen/data-source';
import { kitchenErrorMessage } from '@/lib/kitchen/errors';
import type { KdsStage } from '@/lib/kitchen/kds-status';

/**
 * Server Actions de la COCINA.
 *
 * Propias a proposito: `updateOrderStatusAction` valida contra la maquina del
 * encargado y rechazaria los retrocesos legitimos del KDS (RETORNAR, DEVOLVER A
 * COCINA). Aqui se valida contra la maquina de cocina y contra el estado leido
 * en ese momento, y se escribe con guarda optimista.
 *
 * No toca `order_notifications` ni dispara ningun mensaje al cliente.
 */
export type KitchenActionResult =
  | { ok: true; stage: KdsStage }
  | { ok: false; message: string };

export async function kitchenStageAction(
  orderNumber: string,
  action: string,
): Promise<KitchenActionResult> {
  const role = await currentSessionRole();
  if (role === null || !canAccessKitchen(role)) {
    return { ok: false, message: kitchenErrorMessage('unauthorized') };
  }
  if (typeof orderNumber !== 'string' || typeof action !== 'string') {
    return { ok: false, message: kitchenErrorMessage('invalid_action') };
  }

  try {
    const repo = createKitchenRepository(createSupabaseKitchenDataSource());
    const result = await repo.applyAction(orderNumber, action);
    if (result.ok) return { ok: true, stage: result.stage };
    return { ok: false, message: kitchenErrorMessage(result.reason) };
  } catch {
    // Error de base sanitizado: nunca se expone SQL ni stack al navegador.
    return { ok: false, message: kitchenErrorMessage('error') };
  }
}

/** Cierra la sesion desde la pantalla de cocina. */
export async function kitchenLogoutAction(): Promise<void> {
  await clearSession();
  redirect(LOGIN_PATH);
}
