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

/**
 * Deja escrito si el envío ya está pagado, tras mirar el comprobante (0033).
 *
 * Vive aquí y no en el panel del encargado porque quien mira el comprobante en
 * la práctica es quien empaca, y es el mismo que le canta al repartidor qué
 * cobrar. La decisión y la persona que la toma están en la misma pantalla.
 *
 * NO mueve el pedido de etapa ni acepta ni rechaza el pago: son dimensiones
 * distintas, y esta acción responde una sola pregunta —¿se cobra el envío en la
 * puerta?— que hasta ahora se resolvía llamando por teléfono.
 */
export type KitchenCollectResult = { ok: true } | { ok: false; message: string };

export async function kitchenDeliveryFeePaidAction(
  orderNumber: string,
  paid: boolean,
): Promise<KitchenCollectResult> {
  const role = await currentSessionRole();
  if (role === null || !canAccessKitchen(role)) {
    return { ok: false, message: kitchenErrorMessage('unauthorized') };
  }
  if (typeof orderNumber !== 'string' || typeof paid !== 'boolean') {
    return { ok: false, message: kitchenErrorMessage('invalid_action') };
  }

  try {
    const repo = createKitchenRepository(createSupabaseKitchenDataSource());
    const result = await repo.setDeliveryFeePaid(orderNumber, paid);
    if (result.ok) return { ok: true };
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
