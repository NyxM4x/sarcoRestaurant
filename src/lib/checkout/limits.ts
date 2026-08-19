/**
 * Límites del checkout — fuente única de verdad.
 *
 * Los consumen tanto el contrato Zod del servidor (`@/lib/orders/web-schema`)
 * como la validación del formulario en el navegador (`./form`). Mantenerlos
 * aquí evita que las dos capas se desincronicen.
 *
 * Este módulo no importa nada a propósito: el frontend lo importa directamente,
 * y arrastrar `web-schema` metería Zod en el bundle del menú.
 *
 * Deben coincidir con los que valida la RPC `public.create_order_web`.
 */

/** Máximo de líneas distintas en un pedido. */
export const MAX_CART_LINES = 20;

/** Cantidad mínima por línea. */
export const MIN_ITEM_QUANTITY = 1;

/** Cantidad máxima por línea. */
export const MAX_ITEM_QUANTITY = 10;

/** Longitud máxima del nombre del cliente, ya recortado. */
export const MAX_CUSTOMER_NAME_LENGTH = 100;

/** Longitud máxima de las notas, ya recortadas. */
export const MAX_NOTES_LENGTH = 500;
