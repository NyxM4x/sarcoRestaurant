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

  // Estado del canal de avisos al grupo de reparto. Va SIEMPRE, valide o no la
  // config de delivery: son dos funciones independientes y saber que una está
  // rota no dice nada de la otra.
  //
  // Sin estas dos variables, `notifyDeliveryGroup` retorna en silencio —es una
  // función apagada, no un error— y el grupo no recibe nada aunque el pedido se
  // confirme perfectamente. Ese silencio es indistinguible de un fallo de envío
  // si no se puede mirar aquí.
  //
  // El chat_id se devuelve entero: es un identificador de destino, no una
  // credencial, y verlo permite comprobar que apunta al grupo correcto (los
  // grupos empiezan con `-`). Del bot token, solo su longitud.
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const telegram = {
    enabled: Boolean(botToken) && Boolean(chatId),
    botToken: botToken === undefined ? { present: false } : { present: true, length: botToken.length },
    chatId: chatId === undefined ? { present: false } : { present: true, value: `'${chatId}'` },
  };

  const result = parseDeliveryConfig(process.env);

  if (!result.ok) {
    log.warn('delivery_config_invalid', { missing: result.missing });
    // `missing` no distingue "no está" de "está pero no valida", y cada caso
    // se arregla distinto (agregarla vs. corregir cómo se pegó). Para las que
    // NO son secretas se devuelve el valor crudo entre comillas simples: así
    // se ven los espacios y las comillas literales, que son el error clásico
    // al pegar variables en un panel y son invisibles de otro modo.
    const raw: Record<string, unknown> = {};
    for (const name of ['RESTAURANT_LAT', 'RESTAURANT_LNG', 'MAPBOX_DIRECTIONS_TIMEOUT_MS']) {
      const value = process.env[name];
      raw[name] = value === undefined ? { present: false } : { present: true, value: `'${value}'` };
    }
    const token = process.env.MAPBOX_ACCESS_TOKEN;
    raw.MAPBOX_ACCESS_TOKEN =
      token === undefined
        ? { present: false }
        : { present: true, length: token.length, prefix: token.slice(0, 3) };

    return Response.json({ ok: false, missing: result.missing, raw, telegram }, { status: 200 });
  }

  const { mapboxAccessToken, restaurantLat, restaurantLng, mapboxTimeoutMs } = result.config;

  return Response.json({
    ok: true,
    telegram,
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
