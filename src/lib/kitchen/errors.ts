/**
 * Mensajes de error de la cocina — modulo PURO.
 *
 * Traduce los fallos internos a frases que un cocinero entiende delante de la
 * plancha. NUNCA se filtra SQL, stack ni detalle tecnico: el motivo interno se
 * queda del lado servidor y aqui solo viaja una etiqueta cerrada.
 */
export type KitchenFailure =
  | 'unauthorized'
  | 'invalid_action'
  | 'not_found'
  | 'dispatched'
  | 'cancelled'
  | 'invalid_transition'
  | 'conflict'
  // ── La puerta del pago (0028) ─────────────────────────────────────────────
  //
  // Tres motivos distintos y no uno, porque cada uno pide algo distinto de
  // quien está delante: revisar el comprobante, esperar al cliente, o dejarlo
  // estar. Un único "no se puede" obligaría a adivinar cuál de los tres es.
  | 'payment_pending'
  | 'payment_rejected'
  | 'payment_expired'
  | 'error';

const MESSAGES: Record<KitchenFailure, string> = {
  unauthorized: 'Tu sesión expiró. Vuelve a ingresar.',
  invalid_action: 'Esa acción no está disponible para este pedido.',
  not_found: 'El pedido ya no está en el tablero.',
  // El caso real: el encargado ya lo despacho y el cocinero intenta recuperarlo.
  dispatched: 'El pedido ya salió a reparto',
  cancelled: 'El pedido fue cancelado.',
  invalid_transition: 'Esa acción no está disponible para este pedido.',
  conflict: 'Otro cocinero cambió este pedido. Se actualizó el tablero.',
  // Dice qué hacer, no solo qué pasa: el comprobante está en la misma pantalla
  // y quien cocina puede aceptarlo él mismo.
  payment_pending: 'Revisa el comprobante y acepta el pago para empezar.',
  payment_rejected: 'Pago rechazado. Esperando que el cliente reenvíe el comprobante.',
  payment_expired: 'El cliente no reenvió el comprobante a tiempo. El pedido queda cancelado.',
  error: 'No se pudo guardar el cambio. Vuelve a intentarlo.',
};

export function kitchenErrorMessage(reason: KitchenFailure): string {
  return MESSAGES[reason] ?? MESSAGES.error;
}
