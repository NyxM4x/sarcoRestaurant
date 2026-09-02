import { ORDER_STATUSES, type DeliveryType, type OrderStatus } from '@/types';
import type { NormalizedCheckout } from './form';
import {
  mapCheckoutFailure,
  networkFailure,
  timeoutFailure,
  unreadableResponseFailure,
  type CheckoutFailure,
} from './errors';

/**
 * Cliente HTTP del checkout.
 *
 * Envía exactamente las cinco claves del contrato: `session_token`,
 * `customer_name`, `delivery_type`, `notes` e `items` (solo `code` y
 * `quantity`). Nunca precios, montos, teléfono, `menu_session_id`, fingerprint,
 * estado ni `order_number`: todo eso lo resuelve el servidor.
 *
 * No escribe nada en consola: ni el token, ni el body, ni la respuesta cruda.
 */

export const CHECKOUT_ENDPOINT = '/api/store/orders';

/**
 * Tiempo máximo de la operación completa: `fetch`, recepción del cuerpo,
 * `response.json()` y validación. Al agotarse, el resultado es ambiguo.
 */
export const CHECKOUT_TIMEOUT_MS = 20_000;

/** Pedido tal como lo devuelve el backend (lista blanca de campos). */
export interface CheckoutOrder {
  id: string;
  order_number: string;
  customer_name: string;
  delivery_type: DeliveryType;
  status: OrderStatus;
  subtotal_amount: number;
  delivery_amount: number;
  total_amount: number;
  created_at: string;
}

export type CheckoutResult =
  | { ok: true; order: CheckoutOrder; created: boolean }
  | { ok: false; failure: CheckoutFailure };

export interface SubmitOrderOptions {
  /** Inyectable para tests; por defecto el `fetch` global. */
  fetchImpl?: typeof fetch;
  /** Inyectable para tests; por defecto `CHECKOUT_TIMEOUT_MS`. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Construye el body con exactamente las claves permitidas. */
function buildRequestBody(sessionToken: string, checkout: NormalizedCheckout) {
  return {
    session_token: sessionToken,
    customer_name: checkout.customer_name,
    delivery_type: checkout.delivery_type,
    payment_method: checkout.payment_method,
    notes: checkout.notes,
    items: checkout.items.map((item) => ({ code: item.code, quantity: item.quantity })),
    // La clave se OMITE cuando no hay combos. El esquema del servidor la acepta
    // ausente, y así un pedido normal viaja exactamente igual que antes de
    // 0031 — nada que revisar si alguna vez hay que comparar dos peticiones.
    ...(checkout.promotions.length === 0
      ? {}
      : {
          promotions: checkout.promotions.map((p) => ({
            promotion_id: p.promotion_id,
            quantity: p.quantity,
            revision: p.revision,
          })),
        }),
  };
}

// ── Validación estricta de la respuesta ─────────────────────────────────────

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Monto válido: número real, finito y no negativo.
 *
 * Rechaza a propósito los strings numéricos (`"40"`): si el backend cambiara el
 * formato, preferimos tratarlo como ilegible y ofrecer el reintento exacto
 * antes que mostrar un total en el que no podemos confiar.
 */
function isValidAmount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isOrderStatus(value: unknown): value is OrderStatus {
  return typeof value === 'string' && (ORDER_STATUSES as readonly string[]).includes(value);
}

/**
 * Convierte el cuerpo en un pedido solo si TODOS los campos requeridos están
 * presentes y bien formados. Sin valores por defecto: una respuesta incompleta
 * es `null`, lo que el llamador traduce a `unreadable_response`.
 *
 * Consecuencia deliberada: no se vacía el carrito, no se consume la sesión y se
 * ofrece el reintento exacto.
 */
function parseSuccess(body: unknown): { order: CheckoutOrder; created: boolean } | null {
  if (typeof body !== 'object' || body === null) return null;

  const { order, created } = body as Record<string, unknown>;
  if (typeof created !== 'boolean') return null;
  if (typeof order !== 'object' || order === null) return null;

  const row = order as Record<string, unknown>;

  if (!isNonEmptyString(row.id)) return null;
  if (!isNonEmptyString(row.order_number)) return null;
  if (!isNonEmptyString(row.customer_name)) return null;
  if (!isNonEmptyString(row.created_at)) return null;
  if (row.delivery_type !== 'delivery' && row.delivery_type !== 'pickup') return null;
  if (!isOrderStatus(row.status)) return null;
  if (!isValidAmount(row.subtotal_amount)) return null;
  if (!isValidAmount(row.delivery_amount)) return null;
  if (!isValidAmount(row.total_amount)) return null;

  return {
    created,
    order: {
      id: row.id,
      order_number: row.order_number,
      customer_name: row.customer_name,
      delivery_type: row.delivery_type,
      status: row.status,
      subtotal_amount: row.subtotal_amount,
      delivery_amount: row.delivery_amount,
      total_amount: row.total_amount,
      created_at: row.created_at,
    },
  };
}

/**
 * Envía el pedido.
 *
 * El token se recibe como argumento y solo se usa aquí, al construir el body:
 * no se guarda en el estado de la aplicación ni en `localStorage`.
 *
 * El temporizador cubre la operación entera y solo se limpia en el `finally`
 * exterior, de modo que un cuerpo que nunca termina de llegar también expira.
 */
export async function submitOrder(
  sessionToken: string,
  checkout: NormalizedCheckout,
  options: SubmitOrderOptions = {},
): Promise<CheckoutResult> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? CHECKOUT_TIMEOUT_MS;

  const controller = new AbortController();

  // Distingue nuestro propio vencimiento de un abort externo o un fallo de red.
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const onExternalAbort = () => controller.abort();

  try {
    if (options.signal) {
      // Si ya venía abortado, no tiene sentido registrar el listener: se corta ya.
      if (options.signal.aborted) controller.abort();
      else options.signal.addEventListener('abort', onExternalAbort);
    }

    let response: Response;
    try {
      response = await fetchImpl(CHECKOUT_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(buildRequestBody(sessionToken, checkout)),
        signal: controller.signal,
      });
    } catch {
      // No se inspecciona el error: solo importa si venció nuestro temporizador.
      return { ok: false, failure: timedOut ? timeoutFailure() : networkFailure() };
    }

    // El cuerpo se lee dentro del mismo temporizador.
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      // Cuerpo ilegible: ambiguo, sea cual sea el status. No se mapea por
      // `response.status` porque no sabemos qué llegó realmente.
      return { ok: false, failure: timedOut ? timeoutFailure() : unreadableResponseFailure() };
    }

    if (!response.ok) {
      return { ok: false, failure: mapCheckoutFailure(response.status, body) };
    }

    const success = parseSuccess(body);
    if (!success) return { ok: false, failure: unreadableResponseFailure() };

    return { ok: true, order: success.order, created: success.created };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onExternalAbort);
  }
}
