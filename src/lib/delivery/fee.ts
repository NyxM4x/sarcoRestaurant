/**
 * Tarifario de delivery de La Fija (Fase 6D.2A) — módulo PURO.
 *
 * Trabaja EXCLUSIVAMENTE con metros enteros: la decisión de escalón nunca usa
 * coma flotante para elegir el tramo (solo una división entera dentro de `ceil`).
 * NO llama a Mapbox ni a la red: recibe metros y devuelve tarifa o fuera de
 * cobertura. La tarifa jamás se "inventa"; una distancia inválida se rechaza.
 *
 * Regla de negocio FIJA de esta versión (NO configurable por variables de
 * entorno, por decisión explícita del negocio):
 *   - 0 – 3000 m            → Bs 10
 *   - > 3000 m              → Bs 10 + Bs 2 por cada km o fracción adicional
 *                             iniciada (escalón de 1000 m).
 *   - máximo comercial      → 18000 m (Bs 40).
 *   - > 18000 m             → fuera de cobertura (no se cotiza automáticamente).
 *
 * Este módulo es la ÚNICA fuente de verdad del tarifario y de la cobertura
 * máxima: nada más en el código debe redefinir estos valores.
 */

/** Distancia base (m) cubierta por la tarifa mínima. */
export const DELIVERY_BASE_METERS = 3000;
/** Tarifa mínima (Bs) hasta la distancia base, inclusive. */
export const DELIVERY_BASE_AMOUNT = 10;
/** Tamaño de cada escalón adicional (m): 1 km o fracción iniciada. */
export const DELIVERY_STEP_METERS = 1000;
/** Incremento (Bs) por cada escalón adicional iniciado. */
export const DELIVERY_STEP_AMOUNT = 2;
/**
 * Distancia máxima comercial con cotización automática (m). Más allá de esto el
 * pedido queda fuera de cobertura y debe resolverse manualmente. Fuente única.
 */
export const DELIVERY_MAX_DISTANCE_METERS = 18000;

/**
 * Resultado del tarifario.
 * - `out_of_coverage`: distancia válida pero mayor al máximo comercial (> 18 km).
 * - `invalid_distance`: entrada no utilizable (negativa, no entera, NaN, Infinity).
 */
export type DeliveryFee =
  | { ok: true; amount: number }
  | { ok: false; reason: 'out_of_coverage' | 'invalid_distance' };

/**
 * Calcula la tarifa de delivery a partir de la distancia de ruta en metros.
 *
 * Determinista y sin efectos: la misma distancia siempre da la misma tarifa.
 * Nunca lanza; toda entrada dudosa devuelve `invalid_distance`.
 */
export function feeForMeters(meters: number): DeliveryFee {
  // Entrada estricta: entero finito ≥ 0. Nunca se adivina la distancia.
  if (typeof meters !== 'number' || !Number.isInteger(meters) || meters < 0) {
    return { ok: false, reason: 'invalid_distance' };
  }

  // Fuera de cobertura ANTES de tarifar: > 18 km no tiene precio automático.
  if (meters > DELIVERY_MAX_DISTANCE_METERS) {
    return { ok: false, reason: 'out_of_coverage' };
  }

  // Hasta la base (inclusive): tarifa mínima.
  if (meters <= DELIVERY_BASE_METERS) {
    return { ok: true, amount: DELIVERY_BASE_AMOUNT };
  }

  // Cada km o fracción iniciada por encima de la base suma un escalón.
  const extraSteps = Math.ceil((meters - DELIVERY_BASE_METERS) / DELIVERY_STEP_METERS);
  return { ok: true, amount: DELIVERY_BASE_AMOUNT + extraSteps * DELIVERY_STEP_AMOUNT };
}
