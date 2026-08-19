import 'server-only';
import { z } from 'zod';

/**
 * Configuración server-only del delivery dinámico (Fase 6D.2A).
 *
 * SOLO cubre lo que depende del entorno: token de Mapbox y coordenadas del
 * restaurante (origen de la ruta). El tarifario y la cobertura máxima NO viven
 * aquí: son regla de negocio fija y su única fuente es `./fee`.
 *
 * VALIDACIÓN LAZY: `parseDeliveryConfig` es pura y no lee `process.env`;
 * `getDeliveryConfig()` la aplica sobre el entorno la PRIMERA vez que se invoca
 * (y cachea). Importar este módulo NO valida nada, de modo que el build y los
 * tests no fallan solo por no tener Mapbox configurado todavía en Vercel.
 *
 * El token es server-side: nunca se expone al navegador (sin `NEXT_PUBLIC_`) ni
 * se registra en logs.
 */

/** Timeout por defecto para Mapbox Directions (ms). Sobrescribible por env. */
export const DEFAULT_MAPBOX_DIRECTIONS_TIMEOUT_MS = 5000;

/** Configuración resuelta y validada del delivery dinámico. */
export interface DeliveryConfig {
  /** MAPBOX_ACCESS_TOKEN — secreto server-side. */
  mapboxAccessToken: string;
  /** RESTAURANT_LAT — latitud del origen (restaurante). */
  restaurantLat: number;
  /** RESTAURANT_LNG — longitud del origen (restaurante). */
  restaurantLng: number;
  /** MAPBOX_DIRECTIONS_TIMEOUT_MS o el default. */
  mapboxTimeoutMs: number;
}

export type ParseDeliveryConfigResult =
  | { ok: true; config: DeliveryConfig }
  | { ok: false; missing: string[] };

/** Trata la cadena vacía como ausente (placeholder = no definido). */
const emptyAsUndefined = (v: unknown) => (v === '' ? undefined : v);

const configSchema = z.object({
  MAPBOX_ACCESS_TOKEN: z.preprocess(emptyAsUndefined, z.string().min(1)),
  RESTAURANT_LAT: z.preprocess(emptyAsUndefined, z.coerce.number().finite().min(-90).max(90)),
  RESTAURANT_LNG: z.preprocess(emptyAsUndefined, z.coerce.number().finite().min(-180).max(180)),
  MAPBOX_DIRECTIONS_TIMEOUT_MS: z.preprocess(
    emptyAsUndefined,
    z.coerce.number().int().positive().optional(),
  ),
});

/**
 * Valida un objeto de entorno arbitrario (puro, sin `process.env` ni caché).
 *
 * Devuelve la configuración lista o la lista de variables faltantes/ inválidas
 * (solo NOMBRES, nunca valores: no se filtran secretos).
 */
export function parseDeliveryConfig(
  env: Record<string, string | undefined>,
): ParseDeliveryConfigResult {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    const missing = Array.from(
      new Set(parsed.error.issues.map((i) => i.path.join('.'))),
    );
    return { ok: false, missing };
  }
  return {
    ok: true,
    config: {
      mapboxAccessToken: parsed.data.MAPBOX_ACCESS_TOKEN,
      restaurantLat: parsed.data.RESTAURANT_LAT,
      restaurantLng: parsed.data.RESTAURANT_LNG,
      mapboxTimeoutMs:
        parsed.data.MAPBOX_DIRECTIONS_TIMEOUT_MS ?? DEFAULT_MAPBOX_DIRECTIONS_TIMEOUT_MS,
    },
  };
}

let cached: DeliveryConfig | null = null;

/**
 * Devuelve la configuración de delivery leída de `process.env` (lazy + cacheada).
 * Lanza con los NOMBRES de las variables faltantes/ inválidas, nunca sus valores.
 */
export function getDeliveryConfig(): DeliveryConfig {
  if (cached) return cached;

  const result = parseDeliveryConfig(process.env);
  if (!result.ok) {
    throw new Error(
      `Config de delivery inválida o faltante: ${result.missing.join(', ')}. ` +
        'Revisa MAPBOX_ACCESS_TOKEN, RESTAURANT_LAT y RESTAURANT_LNG.',
    );
  }

  cached = result.config;
  return cached;
}
