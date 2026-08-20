import 'server-only';

/**
 * Geocoding inverso de Mapbox (coordenadas → dirección aproximada).
 *
 * Se usa SOLO para dar contexto humano en el aviso al grupo de reparto. Nunca
 * decide una tarifa ni una cobertura: eso sale de la distancia real por calle
 * (`./mapbox` + `./fee`), que es la única autoridad.
 *
 * BEST-EFFORT por definición: cualquier fallo devuelve `null` y el aviso sale
 * igual con el enlace de mapa, que es el dato que de verdad importa. Un pedido
 * jamás se retrasa ni se pierde porque el geocoder no conteste.
 *
 * En Santa Cruz la precisión es baja —devuelve cosas como "Calle 1"— y por eso
 * el resultado se presenta como aproximado. No sustituye a las coordenadas.
 */

/** Timeout corto: es un adorno del mensaje, no puede retrasar el aviso. */
const REVERSE_GEOCODE_TIMEOUT_MS = 3000;

const BASE_URL = 'https://api.mapbox.com';

export interface ReverseGeocodeDeps {
  accessToken: string;
  /** Inyectable para tests; por defecto el `fetch` global. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  baseUrl?: string;
}

/**
 * Dirección aproximada de un punto, o `null` si no se pudo resolver.
 *
 * Pide `types=address,street` para quedarse con el nivel de calle: sin ese
 * filtro, Mapbox suele devolver primero la ciudad entera ("Santa Cruz de la
 * Sierra"), que no aporta nada a quien ya sabe en qué ciudad está.
 */
export async function reverseGeocode(
  latitude: number,
  longitude: number,
  deps: ReverseGeocodeDeps,
): Promise<string | null> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const baseUrl = deps.baseUrl ?? BASE_URL;

  const url =
    `${baseUrl}/search/geocode/v6/reverse` +
    `?longitude=${encodeURIComponent(longitude)}&latitude=${encodeURIComponent(latitude)}` +
    `&types=address,street&language=es&limit=1` +
    `&access_token=${encodeURIComponent(deps.accessToken)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? REVERSE_GEOCODE_TIMEOUT_MS);

  try {
    const res = await fetchImpl(url, { method: 'GET', signal: controller.signal });
    if (!res.ok) return null;

    const body: unknown = await res.json();
    const features = (body as { features?: unknown })?.features;
    if (!Array.isArray(features) || features.length === 0) return null;

    const props = (features[0] as { properties?: unknown })?.properties as
      | { full_address?: unknown; name_preferred?: unknown; name?: unknown }
      | undefined;

    for (const candidate of [props?.full_address, props?.name_preferred, props?.name]) {
      if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim();
    }
    return null;
  } catch {
    // Timeout, red caída o JSON ilegible: el aviso sale sin dirección.
    return null;
  } finally {
    clearTimeout(timer);
  }
}
