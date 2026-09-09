import { z } from 'zod';
import { getServerEnv } from '@/lib/env/env';
import { extractBearer, safeCompare } from '@/lib/security/auth';
import { log } from '@/lib/log';
import { expireUnconfirmedCashOrders } from '@/lib/orders/cash-confirm-service';

// Requiere APIs de Node (service_role, POST a Kapso) — no Edge.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/**
 * Techo del barrido. Peor caso: 25 pedidos caducados (`MAX_POR_BARRIDO`), cada
 * uno con su UPDATE y su aviso por WhatsApp. Si Kapso se pone lento, esos 25
 * avisos son lo que puede estirar la invocación — y es exactamente el motivo
 * por el que este barrido tiene su propio endpoint y no viaja dentro de otro.
 */
export const maxDuration = 60;

/**
 * `POST /api/internal/orders/expiry/worker/tick` — el barrido de caducados.
 *
 * ── Por qué existe esta ruta ────────────────────────────────────────────────
 *
 * El barrido de pedidos en efectivo sin confirmar vivía DENTRO de
 * `GET /api/internal/cron/tick`, que es el fallback de los Cloudflare Workers y
 * lo despertaría un cron de Vercel. Pero el plan de Vercel no admite crons, así
 * que ese endpoint no lo llama nadie: el barrido estaba escrito, probado, y no
 * se ejecutó JAMÁS en producción.
 *
 * Se descubrió el 09-09-2026 mirando la base:
 *
 *     select count(*) from orders
 *      where payment_method='cash' and status='confirmed'
 *        and cash_confirmed_at is null;
 *     →  11 pedidos, el más antiguo de hacía TRES DÍAS
 *
 * Once clientes que nunca recibieron el aviso de que su pedido se canceló, con
 * un pedido fantasma tapándoles el menú durante 24 h cada uno. Y nadie se
 * enteró, porque un despertador que no suena no produce ningún error.
 *
 * ── Por qué un endpoint PROPIO y no colgarlo de otro worker ─────────────────
 *
 * Porque el peor caso de este barrido son 25 avisos por WhatsApp, y si Kapso se
 * pone lento eso se come el presupuesto de la invocación. Colgarlo del worker
 * de alertas de Telegram —que es el que ya corre cada minuto— pondría en riesgo
 * el aviso al grupo de reparto, y un aviso de reparto que no sale es un
 * repartidor que no sale.
 *
 * Nunca se arriesga el flujo de OPERACIONES —que la comida llegue— por un
 * proceso de LIMPIEZA. Es la misma razón por la que los otros tres workers son
 * tres despliegues y no uno.
 *
 * ── El fallback sigue llamándolo también ────────────────────────────────────
 *
 * `GET /api/internal/cron/tick` conserva su llamada al mismo barrido. Los dos
 * caminos ejecutan lo MISMO a propósito: un fallback que se quedara corto es la
 * clase de divergencia que ya costó un fallo en este repo, y el que se queda
 * corto no lo dice en ninguna parte. El barrido es idempotente —su UPDATE lleva
 * guarda sobre `cash_confirmed_at is null`— así que dos latidos solapados no se
 * pisan.
 *
 * Mismo contrato que los otros tres workers internos: Bearer, cuerpo vacío
 * estricto y solo recuentos en la respuesta.
 */
const tickRequestSchema = z.strictObject({});

function json(status: number, body: unknown): Response {
  return Response.json(body, { status });
}

export async function POST(request: Request): Promise<Response> {
  if (request.method !== 'POST') return json(405, { error: 'method_not_allowed' });

  let internalToken: string | undefined;
  try {
    internalToken = getServerEnv().INTERNAL_API_TOKEN;
  } catch {
    log.error('order_expiry_worker_env_unavailable');
    return json(500, { error: 'internal_error' });
  }

  // Sin token configurado se responde como con token inválido: nunca se abre.
  const provided = extractBearer(request.headers.get('authorization'));
  if (!internalToken || !safeCompare(provided, internalToken)) {
    return json(401, { error: 'unauthorized' });
  }

  const text = await request.text();
  let raw: unknown = {};
  if (text.trim() !== '') {
    try {
      raw = JSON.parse(text);
    } catch {
      return json(400, { error: 'invalid_json' });
    }
  }
  if (!tickRequestSchema.safeParse(raw).success) {
    return json(422, { error: 'validation_error' });
  }

  try {
    const result = await expireUnconfirmedCashOrders();
    // Solo recuentos: ni ids, ni números de pedido, ni teléfonos.
    log.info('order_expiry_tick', { ...result });
    return json(200, result);
  } catch {
    // `expireUnconfirmedCashOrders` no lanza; esto cubre lo que pudiera
    // escaparse por debajo (el cliente de Supabase al construirse, por ejemplo).
    log.error('order_expiry_tick_failed');
    return json(500, { error: 'internal_error' });
  }
}
