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
  error: 'No se pudo guardar el cambio. Vuelve a intentarlo.',
};

export function kitchenErrorMessage(reason: KitchenFailure): string {
  return MESSAGES[reason] ?? MESSAGES.error;
}
