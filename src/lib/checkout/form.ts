import type { DeliveryType, PaymentMethod } from '@/types';
import {
  MAX_CART_LINES,
  MAX_CUSTOMER_NAME_LENGTH,
  MAX_ITEM_QUANTITY,
  MAX_NOTES_LENGTH,
  MIN_ITEM_QUANTITY,
} from './limits';

/**
 * Validación y normalización del formulario de checkout — módulo puro.
 *
 * Espeja las reglas del contrato Zod del servidor usando los mismos límites
 * (`./limits`). No es la autoridad: sirve para dar mensajes inmediatos y evitar
 * viajes de red inútiles. El servidor y la RPC vuelven a validar todo.
 *
 * La normalización que produce (`trim`, notas vacías a `null`) es exactamente
 * la que aplican Zod y la RPC, de modo que el fingerprint del servidor se
 * calcula sobre los mismos valores que vio el usuario.
 */

/** Campos tal como los escribe el usuario, sin normalizar. */
export interface CheckoutFormFields {
  customer_name: string;
  delivery_type: DeliveryType | null;
  /** Método de pago (Fase 6D.1). `null` mientras el usuario no elige. */
  payment_method: PaymentMethod | null;
  notes: string;
}

/** Línea del carrito lista para enviar. */
export interface CheckoutItem {
  code: string;
  quantity: number;
}

/** Errores por campo. `items` agrupa cualquier problema del carrito. */
export interface CheckoutFormErrors {
  customer_name?: string;
  delivery_type?: string;
  payment_method?: string;
  notes?: string;
  items?: string;
}

/** Pedido normalizado, listo para el cliente HTTP. */
export interface NormalizedCheckout {
  customer_name: string;
  delivery_type: DeliveryType;
  payment_method: PaymentMethod;
  notes: string | null;
  items: CheckoutItem[];
}

export type CheckoutFormResult =
  | { ok: true; value: NormalizedCheckout }
  | { ok: false; errors: CheckoutFormErrors };

/** Campos vacíos para inicializar el formulario. */
export const EMPTY_FORM_FIELDS: CheckoutFormFields = {
  customer_name: '',
  delivery_type: null,
  payment_method: null,
  notes: '',
};

/** `''` y las cadenas de solo espacios se normalizan a `null`, como en la RPC. */
export function normalizeNotes(notes: string | null | undefined): string | null {
  if (notes == null) return null;
  const trimmed = notes.trim();
  return trimmed === '' ? null : trimmed;
}

function isValidDeliveryType(value: unknown): value is DeliveryType {
  return value === 'delivery' || value === 'pickup';
}

function isValidPaymentMethod(value: unknown): value is PaymentMethod {
  return value === 'cash' || value === 'qr';
}

/**
 * Valida el formulario junto con el carrito y devuelve el pedido normalizado.
 *
 * Acumula todos los errores en una pasada: el usuario ve de una vez todo lo que
 * debe corregir, en lugar de campo por campo.
 */
export function validateCheckoutForm(
  fields: CheckoutFormFields,
  items: ReadonlyArray<CheckoutItem>,
): CheckoutFormResult {
  const errors: CheckoutFormErrors = {};

  // ── Nombre ───────────────────────────────────────────────────────────────
  const customerName = fields.customer_name.trim();
  if (customerName === '') {
    errors.customer_name = 'Escribe tu nombre para continuar.';
  } else if (customerName.length > MAX_CUSTOMER_NAME_LENGTH) {
    errors.customer_name = `El nombre no puede superar ${MAX_CUSTOMER_NAME_LENGTH} caracteres.`;
  }

  // ── Tipo de entrega ──────────────────────────────────────────────────────
  if (!isValidDeliveryType(fields.delivery_type)) {
    errors.delivery_type = 'Elige cómo quieres recibir tu pedido.';
  }

  // ── Método de pago (6D.1) ─────────────────────────────────────────────────
  if (!isValidPaymentMethod(fields.payment_method)) {
    errors.payment_method = 'Elige cómo quieres pagar.';
  }

  // ── Notas ────────────────────────────────────────────────────────────────
  const notes = normalizeNotes(fields.notes);
  if (notes !== null && notes.length > MAX_NOTES_LENGTH) {
    errors.notes = `Las notas no pueden superar ${MAX_NOTES_LENGTH} caracteres.`;
  }

  // ── Carrito ──────────────────────────────────────────────────────────────
  const normalizedItems: CheckoutItem[] = items.map((item) => ({
    code: item.code.trim(),
    quantity: item.quantity,
  }));

  if (normalizedItems.length === 0) {
    errors.items = 'Tu carrito está vacío.';
  } else if (normalizedItems.length > MAX_CART_LINES) {
    errors.items = `No puedes pedir más de ${MAX_CART_LINES} productos distintos.`;
  } else if (normalizedItems.some((item) => item.code === '')) {
    errors.items = 'Hay un producto inválido en tu carrito.';
  } else if (
    normalizedItems.some(
      (item) =>
        !Number.isInteger(item.quantity) ||
        item.quantity < MIN_ITEM_QUANTITY ||
        item.quantity > MAX_ITEM_QUANTITY,
    )
  ) {
    errors.items = `Las cantidades deben estar entre ${MIN_ITEM_QUANTITY} y ${MAX_ITEM_QUANTITY}.`;
  } else if (new Set(normalizedItems.map((item) => item.code)).size !== normalizedItems.length) {
    errors.items = 'Hay productos repetidos en tu carrito.';
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  return {
    ok: true,
    value: {
      customer_name: customerName,
      // Ya validado arriba; el cast es seguro dentro de esta rama.
      delivery_type: fields.delivery_type as DeliveryType,
      payment_method: fields.payment_method as PaymentMethod,
      notes,
      items: normalizedItems,
    },
  };
}
