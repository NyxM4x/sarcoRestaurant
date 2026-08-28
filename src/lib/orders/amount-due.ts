/**
 * Lo que el cliente debe transferir por QR — módulo PURO.
 *
 * ── Por qué NO es el total ──────────────────────────────────────────────────
 *
 * En delivery, por QR se cobra solo la comida: el envío lo paga el cliente al
 * recibir el pedido, y el mensaje del QR se lo advierte. Así que el comprobante
 * correcto vale el SUBTOTAL, y comparar contra el total haría rechazar pagos
 * buenos — con el cliente esperando y la comida sin empezar.
 *
 * En recojo no hay envío que cobrar aparte, así que se paga todo por QR y la
 * cifra a validar es el total.
 *
 * ── Por qué vive aquí y no en la pantalla que lo usa ────────────────────────
 *
 * Porque ya lo usan dos: el ticket de cocina, para que el cocinero contraste el
 * comprobante con la vista puesta, y el análisis automático, para contrastarlo
 * sin mirar. Dos cálculos de la misma cifra acabarían discrepando el día que
 * cambie la política de envío, y discreparían en silencio: una pantalla diría
 * que el pago está bien y la otra que falta dinero.
 */
import type { DeliveryType } from '@/types';

/** Lo mínimo que hace falta saber del pedido para calcular la cifra. */
export interface AmountDueRow {
  delivery_type: DeliveryType;
  /**
   * `numeric` de Postgres puede llegar como cadena según el driver, y ausente
   * en una fila antigua o en un adaptador que no lo pida.
   */
  total_amount?: number | string | null;
  subtotal_amount?: number | string | null;
}

/**
 * Importe que el cliente debía transferir por QR.
 *
 * Un valor ilegible cae a 0 en vez de a `NaN`: la tarjeta muestra "Bs 0,00",
 * que es visiblemente raro y hace mirar dos veces, en lugar de un "NaN" que
 * parece un fallo de la pantalla y se ignora.
 */
export function amountDueByQrOf(row: AmountDueRow): number {
  // Recojo: no hay envío que cobrar aparte, se paga todo por QR.
  if (row.delivery_type === 'pickup') return Number(row.total_amount) || 0;
  // Delivery: solo la comida. El envío lo paga al recibir el pedido.
  return Number(row.subtotal_amount) || 0;
}
