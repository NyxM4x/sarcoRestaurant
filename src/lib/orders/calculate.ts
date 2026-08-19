import type { DeliveryType, MenuItem } from '@/types';
import type { CalculatedLine, CalculatedOrder } from './types';

/** Cantidad máxima permitida por producto (IDEA.md §9). */
export const MAX_QUANTITY_PER_ITEM = 10;

/**
 * Tarifa de delivery en BOB. Pendiente de decisión de negocio: por ahora 0
 * (delivery y pickup tienen el mismo total). Cambiar aquí cuando se defina.
 */
export const DELIVERY_FEE_BOB = 0;

/** Error de validación de negocio del pedido (cantidades, pedido vacío, etc.). */
export class OrderValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrderValidationError';
  }
}

/** Redondea a 2 decimales evitando errores de coma flotante. */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Formatea un monto en bolivianos: `Bs. 57`. */
export function formatBs(amount: number): string {
  return `Bs. ${round2(amount)}`;
}

/**
 * Normaliza una cantidad cruda (string | number | undefined) a un entero.
 * Lanza `OrderValidationError` si no es un entero dentro de [0, MAX].
 */
export function normalizeQuantity(raw: unknown, code = 'item'): number {
  if (raw === undefined || raw === null || raw === '') return 0;

  const value =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string'
        ? Number(raw.trim())
        : NaN;

  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new OrderValidationError(`Cantidad inválida para "${code}".`);
  }
  if (value < 0 || value > MAX_QUANTITY_PER_ITEM) {
    throw new OrderValidationError(
      `Cantidad fuera de rango (0-${MAX_QUANTITY_PER_ITEM}) para "${code}".`,
    );
  }
  return value;
}

/**
 * Calcula el pedido a partir de los productos reales y las cantidades ya
 * normalizadas (indexadas por `code`). Solo incluye líneas con cantidad > 0.
 * Lanza `OrderValidationError` si el pedido queda vacío.
 */
export function calculateOrder(
  menuItems: MenuItem[],
  quantitiesByCode: Record<string, number>,
  deliveryType: DeliveryType,
): CalculatedOrder {
  const lines: CalculatedLine[] = [];

  for (const item of menuItems) {
    const quantity = quantitiesByCode[item.code] ?? 0;
    if (quantity <= 0) continue;

    lines.push({
      menu_item_id: item.id,
      product_code: item.code,
      product_name_snapshot: item.name,
      unit_price_snapshot: item.price,
      quantity,
      subtotal: round2(item.price * quantity),
    });
  }

  if (lines.length === 0) {
    throw new OrderValidationError('El pedido debe incluir al menos un producto.');
  }

  const subtotal_amount = round2(lines.reduce((acc, l) => acc + l.subtotal, 0));
  const delivery_amount = deliveryType === 'delivery' ? DELIVERY_FEE_BOB : 0;
  const total_amount = round2(subtotal_amount + delivery_amount);

  return { lines, subtotal_amount, delivery_amount, total_amount };
}

/** Construye las líneas de resumen para el Flow: `2x Trancapecho — Bs. 44`. */
export function buildSummaryLines(calc: CalculatedOrder): string[] {
  return calc.lines.map(
    (l) => `${l.quantity}x ${l.product_name_snapshot} — ${formatBs(l.subtotal)}`,
  );
}
