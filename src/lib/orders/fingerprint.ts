import { createHash } from 'node:crypto';
import type { DeliveryType, PaymentMethod } from '@/types';

/**
 * Huella canónica del checkout web — módulo puro.
 *
 * Distingue un reintento legítimo (mismo carrito, doble clic o red lenta) de la
 * reutilización de un enlace con un carrito distinto. La RPC
 * `public.create_order_web` compara esta huella con la del pedido ya asociado a
 * la sesión: si coincide devuelve el mismo pedido, si difiere lanza P1003.
 *
 * Se calcula SIEMPRE en el servidor. El navegador nunca la envía.
 *
 * El payload canónico contiene solo lo que define el pedido desde el punto de
 * vista del cliente. Deliberadamente NO incluye:
 * - session_token ni menu_session_id (la huella describe el carrito, no la sesión)
 * - customer_phone ni phone_number_id (salen de menu_sessions, no del request)
 * - precios, subtotal ni total (los calcula PostgreSQL desde menu_items)
 */

/** Datos ya normalizados por Zod que entran en la huella. */
export interface CheckoutFingerprintInput {
  customer_name: string;
  delivery_type: DeliveryType;
  /**
   * Método de pago (Fase 6D.1). Entra en la huella porque cambiar de efectivo a
   * QR ES una intención de checkout distinta (cambia el mensaje y la forma de
   * pagar): un reintento legítimo conserva el mismo método; cambiarlo sobre la
   * misma sesión produce otra huella → P1003 (enlace ya usado).
   */
  payment_method: PaymentMethod;
  notes: string | null;
  items: ReadonlyArray<{ code: string; quantity: number }>;
}

/**
 * Serializa el payload de forma determinista.
 *
 * Determinismo garantizado por:
 * - orden fijo de claves (se construyen los objetos en orden explícito y
 *   `JSON.stringify` respeta el orden de inserción de claves string);
 * - items ordenados por `code` ascendente con comparación de código de unidad,
 *   no dependiente del locale;
 * - `btrim` sobre nombre y códigos, y `notes` vacías normalizadas a `null`
 *   (los mismos valores que recibe la RPC).
 */
function canonicalize(input: CheckoutFingerprintInput): string {
  const notes = input.notes === null ? null : input.notes.trim();

  const items = input.items
    .map((item) => ({ code: item.code.trim(), quantity: item.quantity }))
    // Comparación explícita: localeCompare variaría según el locale del runtime.
    .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
    .map((item) => ({ code: item.code, quantity: item.quantity }));

  return JSON.stringify({
    customer_name: input.customer_name.trim(),
    delivery_type: input.delivery_type,
    payment_method: input.payment_method,
    notes: notes === '' ? null : notes,
    items,
  });
}

/**
 * Calcula la huella SHA-256 del carrito.
 *
 * @returns 64 caracteres hexadecimales en minúscula, el formato que exige el
 *   CHECK `orders_checkout_fingerprint_format` y valida la RPC.
 */
export function calculateCheckoutFingerprint(input: CheckoutFingerprintInput): string {
  return createHash('sha256').update(canonicalize(input), 'utf8').digest('hex');
}
