import { z } from 'zod';
import { DELIVERY_TYPES, PAYMENT_METHODS } from '@/types';
import {
  MAX_CART_LINES,
  MAX_CUSTOMER_NAME_LENGTH,
  MAX_ITEM_QUANTITY,
  MAX_NOTES_LENGTH,
  MIN_ITEM_QUANTITY,
} from '@/lib/checkout/limits';

/**
 * Contrato de entrada de `POST /api/store/orders` (checkout web, Fase 5.2C).
 *
 * `strictObject` rechaza cualquier campo desconocido. Es deliberado: el cliente
 * NO puede enviar `customer_phone`, `phone_number_id`, `menu_session_id`,
 * `checkout_fingerprint`, precios, montos, `status` ni `order_number`. Todos
 * esos valores los resuelve el servidor:
 * - el teléfono sale de `menu_sessions` dentro de la RPC;
 * - los precios y montos, de `menu_items` dentro de la RPC;
 * - la huella, del helper `calculateCheckoutFingerprint`;
 * - el estado y el número de pedido, de PostgreSQL.
 *
 * Esta validación es la primera de dos capas: la RPC vuelve a validar todo en
 * PostgreSQL dentro de la transacción (SQLSTATE 22023). Zod da mensajes útiles
 * y corta temprano; la base de datos es la autoridad final.
 */

// Los límites viven en `@/lib/checkout/limits` (fuente única, sin Zod, para que
// el frontend pueda importarlos). Se reexportan por compatibilidad.
export {
  MAX_CART_LINES,
  MIN_ITEM_QUANTITY,
  MAX_ITEM_QUANTITY,
  MAX_CUSTOMER_NAME_LENGTH,
  MAX_NOTES_LENGTH,
};

const cartLineSchema = z.strictObject({
  code: z
    .string()
    .trim()
    .min(1, { error: 'El código del producto no puede estar vacío.' }),
  quantity: z
    .number()
    .int({ error: 'La cantidad debe ser un número entero.' })
    .min(MIN_ITEM_QUANTITY, { error: 'La cantidad mínima es 1.' })
    .max(MAX_ITEM_QUANTITY, { error: 'La cantidad máxima es 10.' }),
});

export const createWebOrderSchema = z.strictObject({
  /** Token opaco de la URL del menú (`?session=TOKEN`). Nunca se registra ni se devuelve. */
  session_token: z
    .string()
    .min(1, { error: 'Falta el token de sesión.' }),

  customer_name: z
    .string()
    .trim()
    .min(1, { error: 'El nombre es obligatorio.' })
    .max(MAX_CUSTOMER_NAME_LENGTH, { error: 'El nombre no puede superar 100 caracteres.' }),

  delivery_type: z.enum(DELIVERY_TYPES, {
    error: 'El tipo de entrega debe ser delivery o pickup.',
  }),

  /** Método de pago (Fase 6D.1). Obligatorio para pedidos web: 'cash' | 'qr'. */
  payment_method: z.enum(PAYMENT_METHODS, {
    error: 'El método de pago debe ser efectivo o QR.',
  }),

  /** Opcional. Se recorta y las notas vacías se normalizan a `null`. */
  notes: z
    .string()
    .trim()
    .max(MAX_NOTES_LENGTH, { error: 'Las notas no pueden superar 500 caracteres.' })
    .nullish()
    .transform((value) => (value == null || value === '' ? null : value)),

  items: z
    .array(cartLineSchema)
    .min(1, { error: 'El carrito no puede estar vacío.' })
    .max(MAX_CART_LINES, { error: 'El carrito no puede tener más de 20 líneas.' })
    // Los códigos ya llegan recortados por `cartLineSchema`, así que comparar
    // aquí equivale a comparar `btrim(...)` como hace la RPC.
    .refine(
      (items) => new Set(items.map((item) => item.code)).size === items.length,
      { error: 'El carrito tiene productos repetidos.' },
    ),
});

/** Body ya validado y normalizado: nombre y códigos recortados, notas `null` si vacías. */
export type CreateWebOrderInput = z.infer<typeof createWebOrderSchema>;
