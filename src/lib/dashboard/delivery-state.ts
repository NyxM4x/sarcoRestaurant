/**
 * Estado de cotización de envío para el dashboard (Fase 6D.2D) — módulo PURO.
 *
 * Deriva, SOLO para presentación, el estado del envío dinámico a partir de los
 * campos ya existentes en `orders` (`delivery_pricing`, `delivery_quote_status`)
 * y la presencia de coordenadas. No consulta Mapbox, no recalcula tarifa, no
 * toca la base: es lectura y traducción a una etiqueta + tono visual.
 *
 * Devuelve `null` cuando NO aplica (pickup, delivery legacy `delivery_pricing`
 * NULL, o histórico/Flow): en esos casos la UI no muestra chip de cotización.
 */
import type { DeliveryType, DeliveryPricing, DeliveryQuoteStatus } from '@/types';
import type { StatusTone } from './status';

/** Clave estable del estado (para lógica/tests; nunca se muestra al usuario). */
export type DeliveryStateKey =
  | 'awaiting_location'
  | 'quoting'
  | 'failed'
  | 'out_of_coverage'
  | 'quoted';

/** Vista lista para un chip/badge: etiqueta en español + tono del sistema. */
export interface DeliveryStateView {
  key: DeliveryStateKey;
  label: string;
  tone: StatusTone;
}

export interface DeliveryStateInput {
  deliveryType: DeliveryType;
  deliveryPricing: DeliveryPricing | null;
  deliveryQuoteStatus: DeliveryQuoteStatus | null;
  /** ¿El pedido ya tiene coordenadas GPS guardadas? */
  hasCoordinates: boolean;
}

/**
 * Traduce el estado de cotización de un delivery DINÁMICO a una vista visual.
 *
 * Solo produce estado cuando `delivery_type='delivery'` y
 * `delivery_pricing='dynamic'`. Pickup y legacy (`delivery_pricing` NULL) → null.
 *
 *   pending  + sin GPS → awaiting_location ("Esperando ubicación", amber)
 *   pending  + con GPS → quoting           ("Calculando envío",    blue)
 *   failed             → failed            ("Error al calcular envío", red)
 *   out_of_coverage    → out_of_coverage   ("Fuera de cobertura",  red)
 *   quoted             → quoted            ("Envío cotizado",      green)
 */
export function deliveryQuoteView(input: DeliveryStateInput): DeliveryStateView | null {
  if (input.deliveryType !== 'delivery' || input.deliveryPricing !== 'dynamic') {
    return null;
  }

  switch (input.deliveryQuoteStatus) {
    case 'failed':
      return { key: 'failed', label: 'Error al calcular envío', tone: 'red' };
    case 'out_of_coverage':
      return { key: 'out_of_coverage', label: 'Fuera de cobertura', tone: 'red' };
    case 'quoted':
      return { key: 'quoted', label: 'Envío cotizado', tone: 'green' };
    case 'pending':
      return input.hasCoordinates
        ? { key: 'quoting', label: 'Calculando envío', tone: 'blue' }
        : { key: 'awaiting_location', label: 'Esperando ubicación', tone: 'amber' };
    default:
      // Dinámico sin estado de cotización reconocible (null u otro): sin chip.
      return null;
  }
}
