import { getServerEnv } from '@/lib/env/env';
import { extractBearer, safeCompare } from '@/lib/security/auth';
import { log } from '@/lib/log';
import { parseDeliveryConfig } from '@/lib/delivery/config';

// Requiere APIs de Node (process.env server-side) — no Edge. Siempre dinámico:
// leer una config cacheada de build no diría nada del runtime real.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/internal/delivery/config-check
 *
 * Diagnóstico de la configuración de delivery TAL COMO LA VE EL SERVIDOR.
 * Protegido con el Bearer interno (`INTERNAL_API_TOKEN`).
 *
 * Existe porque un fallo de config es invisible desde fuera: cuando
 * `getDeliveryConfig()` no valida, la cotización muere en el catch del
 * orquestador y el pedido se queda en `delivery_quote_status = 'pending'` sin
 * confirmación ni mensaje. Comprobarlo requería leer logs de la plataforma, y
 * un despliegue con una variable mal pegada podía pasar días sin detectarse.
 *
 * NUNCA devuelve valores de secretos: del token solo se informa si está
 * presente y su longitud, que basta para detectar el error clásico de pegarlo
 * con comillas o truncado. Las coordenadas del restaurante sí se devuelven —
 * son públicas (aparecen en el menú) y verlas es justamente el objetivo.
 *
 * Usa `parseDeliveryConfig`, la misma función pura que consume
 * `getDeliveryConfig()`, en vez de reimplementar la validación: si divergieran,
 * este endpoint mentiría precisamente cuando más se lo necesita.
 */
export async function GET(request: Request): Promise<Response> {
  let internalToken: string | undefined;
  try {
    internalToken = getServerEnv().INTERNAL_API_TOKEN;
  } catch {
    // Entorno incompleto: nunca se detalla qué falta a un no autenticado.
    log.error('internal.delivery_config_check.env_unavailable');
    return Response.json({ error: 'internal_error' }, { status: 500 });
  }

  const token = extractBearer(request.headers.get('authorization'));
  if (!internalToken || !safeCompare(token, internalToken)) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  const result = parseDeliveryConfig(process.env);

  if (!result.ok) {
    log.warn('delivery_config_invalid', { missing: result.missing });
    return Response.json({ ok: false, missing: result.missing }, { status: 200 });
  }

  const { mapboxAccessToken, restaurantLat, restaurantLng, mapboxTimeoutMs } = result.config;

  return Response.json({
    ok: true,
    restaurant: { lat: restaurantLat, lng: restaurantLng },
    mapboxTimeoutMs,
    // Solo forma, nunca contenido: un token pegado con comillas o cortado se
    // delata por la longitud y el prefijo sin exponer el secreto.
    mapboxToken: {
      present: mapboxAccessToken.length > 0,
      length: mapboxAccessToken.length,
      prefix: mapboxAccessToken.slice(0, 3),
    },
  });
}
