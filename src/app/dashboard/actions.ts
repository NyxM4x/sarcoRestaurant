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
import { sweepExpiredOrders } from '@/lib/payment-proof/expiry-service';
import { createMenuRepository } from '@/lib/menu';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import {
  evaluatePromotion,
  validatePromotionDraft,
  type PromotionDraft,
  type PromotionDraftError,
  type PromotionStatus,
} from '@/lib/promotions/promotion';
import { createPromotionsRepository } from '@/lib/promotions/repository';

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
 * Cancela los pedidos cuya ventana de gracia venció (0028).
 *
 * ── Por qué es un botón y no un cron ────────────────────────────────────────
 *
 * La expiración se DERIVA al leer: el KDS, el panel y el enrutado del intake
 * aplican la misma regla, así que nadie ve como vivo un pedido que ya venció
 * aunque su `status` siga diciendo `confirmed`. Lo que falta es MATERIALIZAR
 * esa cancelación en la base, y eso es un acto explícito: lo pulsa una persona
 * que está mirando, no un proceso a las tres de la mañana.
 *
 * ── Solo el encargado ───────────────────────────────────────────────────────
 *
 * Cancelar es terminal y afecta a varios pedidos de golpe. Quien cocina decide
 * sobre UN comprobante que tiene delante; cerrar una tanda de pedidos es una
 * decisión del turno, no de la plancha. Por eso `canAccessAdmin` y no
 * `canReviewPayments`.
 */
export async function sweepExpiredOrdersAction(): Promise<
  { ok: true; cancelled: number; orderNumbers: string[] } | { ok: false; reason: 'unauthorized' }
> {
  const role = await currentSessionRole();
  if (role === null || !canAccessAdmin(role)) return { ok: false, reason: 'unauthorized' };

  const result = await sweepExpiredOrders();
  // Solo si algo cambió: refrescar por un barrido que no canceló nada es pedirle
  // al servidor que repinta la vista para nada.
  if (result.cancelled > 0) revalidatePath('/dashboard');
  return { ok: true, ...result };
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

// ── Disponibilidad de productos ─────────────────────────────────────────────

/**
 * Retira un producto del menú, o lo devuelve. Solo el encargado.
 *
 * Es la acción de "se acabó": lo que cambia es `is_active`, la misma columna con
 * la que se retiraron las gaseosas. El producto no se borra —los pedidos de
 * ayer lo nombran— y vuelve a venderse con el mismo botón.
 *
 * Revalida también el MENÚ: retirar algo del panel y que los clientes lo sigan
 * viendo es justo el fallo que esta pantalla viene a evitar. Y las promociones
 * que lo incluyan pasan solas a "No disponible" —lo calcula
 * `promotion_availability`— sin que haya que tocarlas.
 */
export async function setMenuItemActiveAction(
  id: string,
  active: boolean,
): Promise<
  { ok: true; active: boolean } | { ok: false; reason: 'unauthorized' | 'not_found' | 'error' }
> {
  const role = await currentSessionRole();
  if (role === null || !canAccessAdmin(role)) return { ok: false, reason: 'unauthorized' };
  if (typeof active !== 'boolean') return { ok: false, reason: 'error' };

  try {
    const encontrado = await createMenuRepository(getSupabaseAdmin()).setActive(id, active);
    if (!encontrado) return { ok: false, reason: 'not_found' };

    revalidatePath('/dashboard/configuracion');
    revalidatePath('/menu');
    return { ok: true, active };
  } catch {
    return { ok: false, reason: 'error' };
  }
}

// ── Promociones (0031) ──────────────────────────────────────────────────────

/**
 * Resultado de guardar. `errors` trae los códigos de `validatePromotionDraft`
 * para que el formulario señale el campo exacto en vez de decir "revisa los
 * datos" y dejar a quien edita buscando qué está mal.
 */
export type SavePromotionResult =
  | { ok: true; id: string }
  | { ok: false; reason: 'unauthorized' | 'not_found' | 'stale' | 'error' }
  | { ok: false; reason: 'invalid'; errors: PromotionDraftError[] };

/**
 * Crea o edita una promoción. Solo el encargado.
 *
 * ── Por qué se revalida contra el catálogo aquí ─────────────────────────────
 *
 * El formulario ya calcula el ahorro mientras se escribe, pero eso es una
 * comodidad del navegador y no una autorización. Los precios se releen de
 * `menu_items` en este mismo momento, y la regla monetaria se comprueba con
 * ellos: entre que se abrió el formulario y se pulsó guardar, alguien pudo
 * cambiar el precio de un producto.
 *
 * `id === null` crea; con `id` edita, y entonces `expectedRevision` es
 * obligatorio — editar sin decir qué versión se está editando es exactamente
 * la forma de pisar el trabajo de otra persona sin enterarse.
 */
export async function savePromotionAction(input: {
  id: string | null;
  expectedRevision: number | null;
  name: string;
  description: string | null;
  promoPrice: number;
  startsAt: string | null;
  endsAt: string | null;
  components: Array<{ menuItemId: string; quantity: number }>;
}): Promise<SavePromotionResult> {
  const role = await currentSessionRole();
  if (role === null || !canAccessAdmin(role)) return { ok: false, reason: 'unauthorized' };

  const draft: PromotionDraft = {
    name: input.name,
    description: input.description,
    promoPrice: input.promoPrice,
    startsAt: input.startsAt,
    endsAt: input.endsAt,
    components: input.components,
  };

  try {
    const catalogo = await createMenuRepository(getSupabaseAdmin()).listAll();
    const errores = validatePromotionDraft(draft, catalogo);
    if (errores.length > 0) return { ok: false, reason: 'invalid', errors: errores };

    const repo = createPromotionsRepository();

    if (input.id === null) {
      const id = await repo.create(draft);
      revalidateAfterPromotionChange();
      return { ok: true, id };
    }

    if (input.expectedRevision === null) return { ok: false, reason: 'stale' };

    const resultado = await repo.update(input.id, draft, input.expectedRevision);
    if (resultado !== 'ok') return { ok: false, reason: resultado };

    revalidateAfterPromotionChange();
    return { ok: true, id: input.id };
  } catch {
    return { ok: false, reason: 'error' };
  }
}

/**
 * Enciende o apaga una promoción. Determinista: recibe el estado QUE SE QUIERE,
 * no un "cambia lo que haya".
 *
 * Dos peticiones idénticas dejan el mismo resultado, que es lo que hace segura
 * una doble pulsación o un reintento por red lenta. Un `toggle` con la misma
 * doble pulsación acabaría apagando lo que se quería encender.
 *
 * ── Encender vuelve a comprobarlo todo ──────────────────────────────────────
 *
 * No basta con que el combo estuviera bien cuando se creó. Se releen los
 * componentes y sus precios de AHORA y se evalúa como si ya estuviera
 * encendida: si le falta un producto, si se quedó sin unidades o si dejó de
 * haber ahorro, no se enciende y se dice cuál de las tres cosas pasa.
 *
 * `scheduled` sí se admite: encender algo que empieza el viernes es
 * exactamente lo que hace el botón de programar.
 */
export async function setPromotionActiveAction(
  id: string,
  active: boolean,
): Promise<
  | { ok: true; active: boolean }
  | { ok: false; reason: 'unauthorized' | 'not_found' | 'error' }
  | { ok: false; reason: 'not_publishable'; status: PromotionStatus }
> {
  const role = await currentSessionRole();
  if (role === null || !canAccessAdmin(role)) return { ok: false, reason: 'unauthorized' };
  if (typeof active !== 'boolean') return { ok: false, reason: 'error' };

  try {
    const repo = createPromotionsRepository();

    if (active) {
      const promocion = await repo.find(id);
      if (promocion === null) return { ok: false, reason: 'not_found' };

      const evaluada = evaluatePromotion({ ...promocion, isActive: true }, Date.now());
      if (evaluada.status !== 'available' && evaluada.status !== 'scheduled') {
        return { ok: false, reason: 'not_publishable', status: evaluada.status };
      }
    }

    const resultado = await repo.setActive(id, active);
    if (resultado === 'not_found') return { ok: false, reason: 'not_found' };

    revalidateAfterPromotionChange();
    return { ok: true, active };
  } catch {
    return { ok: false, reason: 'error' };
  }
}

/**
 * El panel y el MENÚ PÚBLICO. Los dos, siempre.
 *
 * Revalidar solo el panel dejaría al encargado viendo su cambio aplicado
 * mientras los clientes siguen con la versión anterior — que es la forma de
 * "apagué la promoción y se sigue vendiendo".
 */
function revalidateAfterPromotionChange(): void {
  revalidatePath('/dashboard/configuracion');
  revalidatePath('/menu');
}
