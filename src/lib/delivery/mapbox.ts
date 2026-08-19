import 'server-only';

/**
 * Cliente de Mapbox Directions API (Fase 6D.2A) — server-only.
 *
 * ÚNICA responsabilidad: pedir la distancia de ruta REAL por calles (perfil
 * `driving`) entre el restaurante (origen) y el cliente (destino), y devolver
 * METROS ENTEROS o un error TIPADO. NO calcula tarifa (eso es `./fee`), NO usa
 * distancia en línea recta, NO lee configuración (token/coords/timeout llegan por
 * parámetro) y NUNCA registra el token ni la URL.
 *
 * `fetchImpl` es inyectable para probar sin red.
 */

/** Coordenada geográfica. WhatsApp entrega `latitude`/`longitude`. */
export interface MapboxCoords {
  lat: number;
  lng: number;
}

export interface MapboxDistanceRequest {
  /** Origen de la ruta: el restaurante. */
  origin: MapboxCoords;
  /** Destino de la ruta: el cliente. */
  destination: MapboxCoords;
}

export interface MapboxClientConfig {
  /** MAPBOX_ACCESS_TOKEN — server-side; nunca se registra. */
  accessToken: string;
  /** Base de la API (override para tests). Por defecto la oficial. */
  baseUrl?: string;
  /** Presupuesto de tiempo del request (ms). */
  timeoutMs?: number;
  /** Inyectable en pruebas; por defecto el `fetch` global. */
  fetchImpl?: typeof fetch;
}

/**
 * Resultado de la consulta de distancia.
 *
 * Errores:
 * - `timeout`            : se agotó el presupuesto (AbortController).
 * - `http_401`/`http_403`: token inválido o sin permisos.
 * - `http_5xx`           : fallo del proveedor (reintentable).
 * - `http_error`         : cualquier otro estado no exitoso (otros 4xx, etc.).
 * - `network_error`      : el `fetch` lanzó sin ser un abort.
 * - `no_route`           : Mapbox respondió sin ruta (`code: NoRoute` o `routes` vacío).
 * - `invalid_response`   : JSON ilegible o `distance` ausente/negativa/no numérica.
 * - `invalid_coordinates`: origen o destino fuera de rango (no se llama a la red).
 *
 * Nota: `out_of_coverage` (> 18 km) NO se decide aquí. Mapbox devuelve la
 * distancia; el tarifario (`./fee`) decide la cobertura.
 */
export type MapboxDistanceResult =
  | { ok: true; distanceMeters: number }
  | {
      ok: false;
      error:
        | 'timeout'
        | 'http_401'
        | 'http_403'
        | 'http_5xx'
        | 'http_error'
        | 'network_error'
        | 'no_route'
        | 'invalid_response'
        | 'invalid_coordinates';
    };

const DEFAULT_BASE_URL = 'https://api.mapbox.com';
const DEFAULT_TIMEOUT_MS = 5000;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isValidCoord(c: MapboxCoords | undefined): boolean {
  return (
    !!c &&
    typeof c.lat === 'number' &&
    Number.isFinite(c.lat) &&
    c.lat >= -90 &&
    c.lat <= 90 &&
    typeof c.lng === 'number' &&
    Number.isFinite(c.lng) &&
    c.lng >= -180 &&
    c.lng <= 180
  );
}

/**
 * Extrae la distancia de la respuesta de Mapbox y la normaliza a METROS ENTEROS.
 *
 * Mapbox devuelve `routes[0].distance` en metros como número (posible decimal).
 * Se redondea al entero más cercano (`Math.round`) de forma determinista: es la
 * unidad con la que trabaja el tarifario. Cualquier forma inesperada → error.
 */
function extractDistanceMeters(json: unknown): MapboxDistanceResult {
  const root = record(json);
  if (!root) return { ok: false, error: 'invalid_response' };

  // Sin ruta: Mapbox usa `code: 'NoRoute'` o un `routes` vacío.
  if (root.code === 'NoRoute') return { ok: false, error: 'no_route' };

  const routes = root.routes;
  if (!Array.isArray(routes)) return { ok: false, error: 'invalid_response' };
  if (routes.length === 0) return { ok: false, error: 'no_route' };

  const first = record(routes[0]);
  const distance = first?.distance;
  if (typeof distance !== 'number' || !Number.isFinite(distance) || distance < 0) {
    return { ok: false, error: 'invalid_response' };
  }

  return { ok: true, distanceMeters: Math.round(distance) };
}

/**
 * Consulta a Mapbox Directions la distancia de ruta (driving) origen → destino.
 *
 * No lanza: devuelve un `MapboxDistanceResult` tipado. Valida coordenadas ANTES
 * de tocar la red. El token viaja como query param (requisito de Mapbox) y jamás
 * se registra.
 */
export async function getDistanceByRoad(
  request: MapboxDistanceRequest,
  config: MapboxClientConfig,
): Promise<MapboxDistanceResult> {
  if (!isValidCoord(request.origin) || !isValidCoord(request.destination)) {
    return { ok: false, error: 'invalid_coordinates' };
  }

  const fetchImpl = config.fetchImpl ?? fetch;
  const baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const { origin, destination } = request;
  // Orden de Mapbox: lng,lat;lng,lat.
  const coords = `${origin.lng},${origin.lat};${destination.lng},${destination.lat}`;
  const url =
    `${baseUrl}/directions/v5/mapbox/driving/${coords}` +
    `?overview=false&alternatives=false&access_token=${encodeURIComponent(config.accessToken)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetchImpl(url, { method: 'GET', signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return { ok: false, error: 'timeout' };
    }
    return { ok: false, error: 'network_error' };
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    if (res.status === 401) return { ok: false, error: 'http_401' };
    if (res.status === 403) return { ok: false, error: 'http_403' };
    if (res.status >= 500 && res.status <= 599) return { ok: false, error: 'http_5xx' };
    return { ok: false, error: 'http_error' };
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return { ok: false, error: 'invalid_response' };
  }

  return extractDistanceMeters(json);
}
