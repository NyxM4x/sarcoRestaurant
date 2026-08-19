/**
 * Enlaces de mapa para la ubicación de entrega — módulo PURO.
 *
 * Solo construye una URL estándar de Google Maps a partir de coordenadas ya
 * existentes en la base. No embebe mapas, no usa SDKs, no expone datos técnicos:
 * únicamente latitud/longitud, que son el dato operativo que el repartidor
 * necesita. Si las coordenadas no son válidas devuelve `null` para que la UI no
 * muestre un botón roto.
 */

/** Coordenada válida = número finito dentro del rango geográfico real. */
function isValidLat(lat: number): boolean {
  return Number.isFinite(lat) && lat >= -90 && lat <= 90;
}

function isValidLon(lon: number): boolean {
  return Number.isFinite(lon) && lon >= -180 && lon <= 180;
}

/**
 * URL de Google Maps que apunta a la coordenada. `null` si falta alguna o está
 * fuera de rango. Usa el endpoint documentado `?api=1&query=lat,lon`, que abre
 * el punto tanto en web como en la app móvil de Maps.
 */
export function googleMapsUrl(
  lat: number | null | undefined,
  lon: number | null | undefined,
): string | null {
  if (lat == null || lon == null) return null;
  if (!isValidLat(lat) || !isValidLon(lon)) return null;
  return `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`;
}
