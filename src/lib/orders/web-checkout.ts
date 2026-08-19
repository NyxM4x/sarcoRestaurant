import { hashMenuSessionToken } from '@/lib/menu/session-token';
import { log } from '@/lib/log';
import type { DispatchResult } from '@/lib/orders/notifications/web-notify';
import { calculateCheckoutFingerprint } from './fingerprint';
import { createWebOrderSchema } from './web-schema';
import type { DeliveryType, OrderStatus, PaymentMethod } from '@/types';

/**
 * Orquestación del checkout web (Fase 5.2C) — sin dependencias server-only.
 *
 * Las dependencias se inyectan (mismo patrón que `confirm.ts`), de modo que la
 * ruta se limita a cablear Supabase y este módulo queda cubierto por tests sin
 * tocar la base de datos.
 *
 * Este módulo NO escribe en `orders` ni en `order_items`. Toda la escritura
 * ocurre dentro de `public.create_order_web_v3`, que es la única responsable de:
 * leer el teléfono desde `menu_sessions`, validar productos activos, leer los
 * precios reales, calcular subtotal y total, derivar delivery_pricing, crear el
 * pedido y sus líneas, y resolver idempotencia y concurrencia.
 */

/** Fila que devuelve `public.create_order_web_v3` como jsonb. */
export interface CreateOrderWebRow {
  order_id: string;
  order_number: string;
  /** La RPC lo normaliza con `btrim` y exige 1-100 caracteres: nunca es nulo. */
  customer_name: string;
  delivery_type: DeliveryType;
  status: OrderStatus;
  subtotal_amount: number;
  delivery_amount: number;
  total_amount: number;
  /** La RPC lo exige ('cash' | 'qr') para pedidos web. */
  payment_method: PaymentMethod;
  created_at: string;
  created: boolean;
}

/** Parámetros de la RPC, ya normalizados por el servidor. */
export interface CreateOrderWebParams {
  p_menu_session_id: string;
  p_customer_name: string;
  p_delivery_type: DeliveryType;
  p_notes: string | null;
  p_items_json: Array<{ code: string; quantity: number }>;
  p_checkout_fingerprint: string;
  /** Método de pago (6D.1). Obligatorio: 'cash' | 'qr'. */
  p_payment_method: PaymentMethod;
}

/**
 * Resultado crudo de la RPC. `errorCode` es el SQLSTATE que PostgreSQL propaga
 * en `PostgrestError.code`; el mapeo a HTTP se hace por ese código, nunca por
 * el texto del mensaje.
 */
export type CreateOrderWebOutcome =
  | { data: CreateOrderWebRow; errorCode: null }
  | { data: null; errorCode: string | null };

/**
 * Modo de despacho de notificaciones, derivado ÚNICAMENTE de `row.created`.
 *
 * - `initialize_and_dispatch`: pedido recién creado (201). Crea las filas de
 *   `order_notifications` y las procesa.
 * - `dispatch_existing`: reintento idempotente (200). Procesa solo filas ya
 *   existentes y NUNCA inicializa: así un pedido anterior a esta función jamás
 *   recibe mensajes tardíos por un reintento.
 */
export type NotificationDispatchMode = 'initialize_and_dispatch' | 'dispatch_existing';

export interface ScheduleNotificationDispatchInput {
  orderId: string;
  mode: NotificationDispatchMode;
}

/** Registra trabajo para después de la respuesta (implementado con `after()`). */
export type ScheduleNotificationDispatch = (input: ScheduleNotificationDispatchInput) => void;

export interface WebCheckoutDeps {
  /**
   * Devuelve el id de una sesión vigente a partir del hash del token, o `null`
   * si no existe o está vencida. En producción lo resuelve
   * `createMenuSessionRepository(...).findByHash`, que ya filtra por
   * `expires_at > now()`.
   *
   * Solo devuelve el id: el teléfono nunca sale del repositorio hacia la ruta.
   */
  findSessionIdByTokenHash(tokenHash: string): Promise<string | null>;
  /** Invoca `public.create_order_web_v3` con el cliente `service_role`. */
  callCreateOrderWeb(params: CreateOrderWebParams): Promise<CreateOrderWebOutcome>;

  /**
   * Programa el envío por WhatsApp para DESPUÉS de responder. Es opcional: sin
   * ella el checkout funciona igual (útil en pruebas). Solo recibe `orderId` y
   * `mode`; nunca el token de sesión, el teléfono ni el carrito.
   */
  scheduleNotificationDispatch?: ScheduleNotificationDispatch;
}

/** Acción que el frontend debe tomar tras crear el pedido. */
export type NextAction = 'order_confirmed' | 'return_to_whatsapp_for_location';

const SESSION_ERROR_MESSAGE =
  'Este enlace ya no es válido. Vuelve a WhatsApp y solicita nuevamente el menú.';
const SESSION_REUSED_MESSAGE =
  'Este enlace ya fue utilizado. Vuelve a WhatsApp para solicitar un nuevo enlace.';
const INTERNAL_ERROR_MESSAGE = 'No pudimos registrar tu pedido. Intenta de nuevo en un momento.';

function jsonResponse(status: number, body: unknown): Response {
  return Response.json(body, { status });
}

/**
 * Traduce el SQLSTATE de la RPC a una respuesta HTTP.
 *
 * Se mapea por código, no por texto: los mensajes de PostgreSQL pueden cambiar
 * y además pueden contener detalles internos que no deben llegar al navegador.
 */
function mapRpcError(errorCode: string | null): Response {
  switch (errorCode) {
    case 'P1001':
      return jsonResponse(401, { error: 'invalid_session', message: SESSION_ERROR_MESSAGE });
    case 'P1002':
      return jsonResponse(422, {
        error: 'product_unavailable',
        message: 'Uno de los productos ya no está disponible. Revisa tu pedido.',
      });
    case 'P1003':
      return jsonResponse(409, { error: 'session_already_used', message: SESSION_REUSED_MESSAGE });
    case '22023':
      return jsonResponse(422, {
        error: 'validation_error',
        message: 'Los datos del pedido no son válidos. Revisa tu pedido.',
      });
    default:
      // Cualquier otro error se registra sin detalle de base de datos y se
      // devuelve genérico: nada de stack traces ni respuestas crudas.
      log.error('store.orders.rpc_failed', { sqlstate: errorCode ?? 'unknown' });
      return jsonResponse(500, { error: 'internal_error', message: INTERNAL_ERROR_MESSAGE });
  }
}

/** `pickup` queda confirmado; `delivery` necesita la ubicación por WhatsApp. */
function nextActionFor(deliveryType: DeliveryType): NextAction {
  return deliveryType === 'pickup' ? 'order_confirmed' : 'return_to_whatsapp_for_location';
}

/**
 * Construye el cuerpo de la respuesta con una lista blanca de campos.
 *
 * Nunca se reenvía la fila completa de la RPC: así, si en el futuro la función
 * devolviera algún campo extra, no se filtraría al navegador por accidente.
 */
function buildSuccessBody(row: CreateOrderWebRow) {
  return {
    order: {
      id: row.order_id,
      order_number: row.order_number,
      customer_name: row.customer_name,
      delivery_type: row.delivery_type,
      status: row.status,
      subtotal_amount: Number(row.subtotal_amount),
      delivery_amount: Number(row.delivery_amount),
      total_amount: Number(row.total_amount),
      created_at: row.created_at,
    },
    created: row.created,
    next_action: nextActionFor(row.delivery_type),
  };
}

/**
 * Maneja `POST /api/store/orders`.
 *
 * Flujo:
 * 1. Parsear el JSON del body (400 si es inválido).
 * 2. Validar el contrato con Zod, rechazando campos desconocidos (422).
 * 3. Resolver la sesión: SHA-256 del token → `menu_sessions` (401 si no vigente).
 * 4. Calcular la huella canónica del carrito en el servidor.
 * 5. Invocar la RPC transaccional y mapear su SQLSTATE a HTTP.
 *
 * No registra el token, el hash, el teléfono ni el body completo.
 */
export async function handleCreateWebOrder(
  request: Request,
  deps: WebCheckoutDeps,
): Promise<Response> {
  // 1. Body JSON.
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return jsonResponse(400, { error: 'invalid_json', message: 'El cuerpo no es JSON válido.' });
  }

  // 2. Contrato. `strictObject` rechaza campos que el cliente no puede enviar.
  const parsed = createWebOrderSchema.safeParse(raw);
  if (!parsed.success) {
    // Solo ruta y mensaje: nunca se refleja el valor recibido, que podría
    // contener el token de sesión.
    const issues = parsed.error.issues.map((issue) => ({
      field: issue.path.join('.'),
      message: issue.message,
    }));
    return jsonResponse(422, {
      error: 'validation_error',
      message: issues[0]?.message ?? 'Los datos del pedido no son válidos.',
      issues,
    });
  }
  const body = parsed.data;

  // 3. Sesión: se busca por hash, nunca por el token en claro.
  const tokenHash = hashMenuSessionToken(body.session_token);
  let menuSessionId: string | null;
  try {
    menuSessionId = await deps.findSessionIdByTokenHash(tokenHash);
  } catch (error) {
    log.error('store.orders.session_lookup_failed', {
      reason: error instanceof Error ? error.message : 'unknown',
    });
    return jsonResponse(500, { error: 'internal_error', message: INTERNAL_ERROR_MESSAGE });
  }

  if (!menuSessionId) {
    return jsonResponse(401, { error: 'invalid_session', message: SESSION_ERROR_MESSAGE });
  }

  // 4. Huella canónica, calculada solo con los valores ya normalizados.
  const checkoutFingerprint = calculateCheckoutFingerprint({
    customer_name: body.customer_name,
    delivery_type: body.delivery_type,
    payment_method: body.payment_method,
    notes: body.notes,
    items: body.items,
  });

  // 5. RPC transaccional: única vía de escritura.
  let outcome: CreateOrderWebOutcome;
  try {
    outcome = await deps.callCreateOrderWeb({
      p_menu_session_id: menuSessionId,
      p_customer_name: body.customer_name,
      p_delivery_type: body.delivery_type,
      p_notes: body.notes,
      p_items_json: body.items.map((item) => ({ code: item.code, quantity: item.quantity })),
      p_checkout_fingerprint: checkoutFingerprint,
      p_payment_method: body.payment_method,
    });
  } catch (error) {
    log.error('store.orders.rpc_threw', {
      reason: error instanceof Error ? error.message : 'unknown',
    });
    return jsonResponse(500, { error: 'internal_error', message: INTERNAL_ERROR_MESSAGE });
  }

  if (outcome.errorCode !== null || outcome.data === null) {
    return mapRpcError(outcome.errorCode);
  }

  const row = outcome.data;

  log.info('store.orders.created', {
    order_id: row.order_id,
    order_number: row.order_number,
    delivery_type: row.delivery_type,
    payment_method: row.payment_method,
    status: row.status,
    created: row.created,
    lines: body.items.length,
    total_amount: Number(row.total_amount),
  });

  // 6. Notificación por WhatsApp: se PROGRAMA (no se espera). El navegador
  // recibe su respuesta sin depender de Kapso. Solo ocurre en respuestas
  // exitosas y exactamente una vez.
  const mode: NotificationDispatchMode = row.created
    ? 'initialize_and_dispatch'
    : 'dispatch_existing';

  try {
    deps.scheduleNotificationDispatch?.({ orderId: row.order_id, mode });
  } catch {
    // El pedido ya está creado: un fallo al REGISTRAR el trabajo no puede
    // convertir una respuesta exitosa en error. Se registra sin detalle técnico.
    log.warn('store.orders.notification_schedule_failed', { order_id: row.order_id, mode });
  }

  // 201 solo cuando la RPC creó el pedido; 200 en un reintento con el mismo carrito.
  return jsonResponse(row.created ? 201 : 200, buildSuccessBody(row));
}

// ── Adaptador de scheduling ────────────────────────────────────────────────

/** Firma mínima de `after()` de `next/server`; se inyecta para poder probarla. */
export type AfterLike = (callback: () => void | Promise<void>) => void;

/** Ejecutores reales del despacho (implementados por la capa server-only). */
export interface NotificationDispatchRunners {
  initializeAndDispatch(orderId: string): Promise<DispatchResult>;
  dispatchExisting(orderId: string): Promise<DispatchResult>;
}

/**
 * Construye la dependencia `scheduleNotificationDispatch` sobre `after()`.
 *
 * Vive aquí (y no en la ruta) para poder probarse sin `next/server`: la ruta
 * real solo inyecta el `after` verdadero y los ejecutores server-only.
 *
 * El callback se entrega SIN ejecutar: `after` decide cuándo correrlo, ya
 * enviada la respuesta. Todo el cuerpo va en un try/catch total para que nunca
 * exista una promesa rechazada sin manejar, y solo se registran campos
 * sanitizados (order_id, mode, ok y estados del dispatch).
 */
export function createNotificationScheduler(
  after: AfterLike,
  runners: NotificationDispatchRunners,
): ScheduleNotificationDispatch {
  return ({ orderId, mode }) => {
    after(async () => {
      try {
        const result =
          mode === 'initialize_and_dispatch'
            ? await runners.initializeAndDispatch(orderId)
            : await runners.dispatchExisting(orderId);

        log.info('store.orders.notification_dispatched', {
          order_id: orderId,
          mode,
          ok: result.ok,
          confirmation: result.confirmation,
          location_request: result.locationRequest,
          reason: result.reason ?? null,
        });
      } catch {
        // Sin mensaje técnico: el dispatch ya devuelve resultados seguros, esto
        // es la última red para que nada escape del callback.
        log.error('store.orders.notification_dispatch_failed', { order_id: orderId, mode });
      }
    });
  };
}
