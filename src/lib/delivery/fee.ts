/**
 * Tarifario de delivery de Don Zarco — módulo PURO.
 *
 * Trabaja EXCLUSIVAMENTE con metros enteros. NO llama a Mapbox ni a la red:
 * recibe metros y devuelve tarifa o fuera de cobertura. La tarifa jamás se
 * "inventa"; una distancia inválida se rechaza.
 *
 * ── Es una TABLA, no una fórmula ────────────────────────────────────────────
 *
 * Hasta ahora era `base + N × escalón`, que se podía calcular. El tarifario del
 * proveedor no sigue ninguna progresión: de 3 a 4 km sube 1 Bs, de 8 a 9 sube 4,
 * y el tramo de 9.1 a 11 abarca dos kilómetros en vez de uno. Cualquier fórmula
 * que intentara reproducir eso acabaría siendo una tabla disfrazada con casos
 * especiales, y el primer tramo que el proveedor cambiara la rompería en
 * silencio — cobrando de más o de menos sin que nadie lo notara.
 *
 * Escrita como tabla, cambiar un precio es cambiar un número en una línea que se
 * lee igual que el cartel del proveedor.
 *
 * ── Los límites son el LÍMITE SUPERIOR de cada tramo ────────────────────────
 *
 * El cartel dice "2.1 a 3 km = 12 Bs". Eso significa que 3.000 m cuestan 12, y
 * que 3.001 ya pertenecen al tramo siguiente. Se guarda solo el techo de cada
 * tramo porque el suelo es siempre el techo del anterior: guardar los dos
 * permitiría que dejaran de encajar, y ahí es donde aparecen los huecos sin
 * precio y los solapamientos con dos precios distintos.
 *
 * Este módulo es la ÚNICA fuente de verdad del tarifario y de la cobertura
 * máxima: nada más en el código debe redefinir estos valores.
 */

/** Un tramo del cartel: hasta `maxMeters` inclusive, cuesta `amount`. */
export interface DeliveryTier {
  /** Techo del tramo en metros, INCLUSIVE. */
  maxMeters: number;
  /** Tarifa en bolivianos. */
  amount: number;
}

/**
 * Tarifario vigente, tal como lo publica el proveedor.
 *
 * Ordenado de menor a mayor y sin huecos: cada tramo empieza donde acaba el
 * anterior. `assertTarifarioOrdenado` lo comprueba en los tests.
 */
export const DELIVERY_TIERS: readonly DeliveryTier[] = [
  { maxMeters: 2_000, amount: 10 }, // 0.1 – 2 km
  { maxMeters: 3_000, amount: 12 }, // 2.1 – 3 km
  { maxMeters: 4_000, amount: 13 }, // 3.1 – 4 km
  { maxMeters: 5_000, amount: 15 }, // 4.1 – 5 km
  { maxMeters: 6_000, amount: 17 }, // 5.1 – 6 km
  { maxMeters: 7_000, amount: 19 }, // 6.1 – 7 km
  { maxMeters: 8_000, amount: 21 }, // 7.1 – 8 km
  { maxMeters: 9_000, amount: 25 }, // 8.1 – 9 km
  { maxMeters: 11_000, amount: 27 }, // 9.1 – 11 km  ← dos kilómetros, no uno
  { maxMeters: 12_000, amount: 30 }, // 11.1 – 12 km
  { maxMeters: 13_000, amount: 32 }, // 12.1 – 13 km
  { maxMeters: 14_000, amount: 34 }, // 13.1 – 14 km
  { maxMeters: 15_000, amount: 36 }, // 14.1 – 15 km
  { maxMeters: 16_000, amount: 40 }, // 15.1 – 16 km
  { maxMeters: 17_000, amount: 42 }, // 16.1 – 17 km
  { maxMeters: 18_000, amount: 44 }, // 17.1 – 18 km
];

/**
 * Distancia máxima comercial con cotización automática (m). Sale del ÚLTIMO
 * tramo en vez de escribirse aparte: si mañana el proveedor añade un tramo de
 * 19 km, la cobertura crece sola y no queda un número olvidado contradiciendo
 * a la tabla.
 */
export const DELIVERY_MAX_DISTANCE_METERS =
  DELIVERY_TIERS[DELIVERY_TIERS.length - 1].maxMeters;

/** Tarifa mínima: la del primer tramo. Un pedido nunca cuesta menos. */
export const DELIVERY_BASE_AMOUNT = DELIVERY_TIERS[0].amount;

/**
 * Recargo por lluvia (Bs), tal como lo publica el proveedor.
 *
 * Se suma ENCIMA del tramo, sin alterarlo: la lluvia encarece el viaje, no
 * cambia la distancia. Aplicarlo como un tramo distinto habría obligado a
 * mantener dos tablas paralelas que tarde o temprano se desincronizan.
 */
export const DELIVERY_RAIN_SURCHARGE = 3;

/**
 * Resultado del tarifario.
 * - `out_of_coverage`: distancia válida pero mayor al máximo comercial.
 * - `invalid_distance`: entrada no utilizable (negativa, no entera, NaN, Infinity).
 */
export type DeliveryFee =
  | { ok: true; amount: number }
  | { ok: false; reason: 'out_of_coverage' | 'invalid_distance' };

export interface FeeOptions {
  /**
   * ¿Está activa la tarifa de lluvia? Lo decide el encargado desde el panel, y
   * solo afecta a las cotizaciones NUEVAS: un pedido ya cotizado conserva su
   * precio pase lo que pase con el tiempo.
   */
  rain?: boolean;
}

/**
 * Calcula la tarifa de delivery a partir de la distancia de ruta en metros.
 *
 * Determinista y sin efectos: la misma distancia y las mismas opciones dan
 * siempre la misma tarifa. Nunca lanza; toda entrada dudosa devuelve
 * `invalid_distance`.
 */
export function feeForMeters(meters: number, options: FeeOptions = {}): DeliveryFee {
  // Entrada estricta: entero finito ≥ 0. Nunca se adivina la distancia.
  if (typeof meters !== 'number' || !Number.isInteger(meters) || meters < 0) {
    return { ok: false, reason: 'invalid_distance' };
  }

  // Fuera de cobertura ANTES de tarifar: más allá del último tramo no hay precio
  // automático, y el pedido lo resuelve una persona.
  if (meters > DELIVERY_MAX_DISTANCE_METERS) {
    return { ok: false, reason: 'out_of_coverage' };
  }

  // Primer tramo cuyo techo alcanza la distancia. La tabla está ordenada, así
  // que el primero que sirve es el correcto.
  const tier = DELIVERY_TIERS.find((t) => meters <= t.maxMeters);
  // No puede faltar —el guard de cobertura ya cubrió el caso—, pero si la tabla
  // quedara mal editada se prefiere rechazar a cobrar un importe inventado.
  if (!tier) return { ok: false, reason: 'invalid_distance' };

  const surcharge = options.rain ? DELIVERY_RAIN_SURCHARGE : 0;
  return { ok: true, amount: tier.amount + surcharge };
}
