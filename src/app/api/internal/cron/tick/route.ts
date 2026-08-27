import { log } from '@/lib/log';
import { getServerEnv } from '@/lib/env/env';
import { safeCompare } from '@/lib/security/compare';
import { POST as tickWebhookInbox } from '../../webhook-events/worker/tick/route';
import { POST as tickNotifications } from '../../order-notifications/worker/tick/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `GET /api/internal/cron/tick` — el LATIDO de los workers de recuperación.
 *
 * ── Por qué hace falta ──────────────────────────────────────────────────────
 *
 * El webhook acepta el evento, lo escribe en el inbox y hace el trabajo en un
 * `after()`. Eso es rapidez, no durabilidad: si la función se congela o muere a
 * mitad, la fila queda reclamada con un lease que vence y nadie vuelve a por
 * ella. El código del webhook lo dice y cuenta con que "el worker de recovery la
 * recoge" — pero ese worker solo corre si alguien lo llama.
 *
 * Sin este latido, un mensaje perdido así no da error en ninguna parte: el
 * pedido simplemente no se confirma, o el comprobante no se captura, y nadie se
 * entera hasta que el cliente reclama. Es el fallo más caro de todos porque es
 * silencioso, y se vuelve más probable cuanto más carga hay — justo en la hora
 * punta.
 *
 * ── Por qué GET y por qué una ruta aparte ───────────────────────────────────
 *
 * Los cron de Vercel invocan por GET y no permiten cabeceras propias: mandan
 * `Authorization: Bearer <CRON_SECRET>`. Los workers son POST y esperan el
 * Bearer interno. En vez de aflojar los workers —abrirles un GET sería invitar a
 * que se disparen desde una barra de direcciones— esta ruta traduce: valida el
 * secreto y los invoca con un POST sintético.
 *
 * Un solo cron mueve los dos workers, así que el plan de Vercel solo tiene que
 * dar para una entrada.
 *
 * ── Los dos workers son independientes ──────────────────────────────────────
 *
 * Se lanzan con `allSettled`: que el inbox falle no puede impedir que las
 * notificaciones se recuperen, ni al revés. Cada uno ya es idempotente y
 * reclama su propio trabajo, así que dos latidos solapados no se pisan.
 */

/** Token esperado. Acepta `CRON_SECRET` para no obligar a duplicar el valor. */
function expectedToken(): string | null {
  try {
    const env = getServerEnv();
    // `CRON_SECRET` es el nombre que Vercel rellena solo; `INTERNAL_API_TOKEN`
    // es el que ya usan los workers. Vale cualquiera de los dos para no obligar
    // a mantener el mismo secreto escrito dos veces.
    return process.env.CRON_SECRET || env.INTERNAL_API_TOKEN || null;
  } catch {
    return null;
  }
}

function bearerOf(header: string | null): string {
  if (!header) return '';
  const [scheme, ...rest] = header.trim().split(/\s+/);
  return scheme?.toLowerCase() === 'bearer' ? rest.join(' ') : '';
}

export async function GET(request: Request): Promise<Response> {
  const esperado = expectedToken();
  // Fail closed: sin secreto configurado nadie dispara nada. Un worker abierto
  // dejaría que cualquiera forzara reprocesos desde fuera.
  if (!esperado) {
    log.error('cron_tick_not_configured');
    return Response.json({ error: 'not_configured' }, { status: 500 });
  }

  const provided = bearerOf(request.headers.get('authorization'));
  if (!safeCompare(provided, esperado)) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  // POST sintético con el Bearer que los workers esperan. No se reenvía nada del
  // request original: ni cabeceras, ni cuerpo, ni query.
  const interno = () =>
    new Request('https://internal.invalid/worker/tick', {
      method: 'POST',
      headers: { authorization: `Bearer ${esperado}` },
    });

  const [inbox, notifications] = await Promise.allSettled([
    tickWebhookInbox(interno()),
    tickNotifications(interno()),
  ]);

  const estado = (r: PromiseSettledResult<Response>): number | 'error' =>
    r.status === 'fulfilled' ? r.value.status : 'error';

  log.info('cron_tick_done', {
    inbox: estado(inbox),
    notifications: estado(notifications),
  });

  // 200 siempre que el latido se haya ejecutado: el resultado de cada worker es
  // observabilidad, no un fallo del cron. Un 500 aquí solo haría que Vercel
  // marcara el cron en rojo por un evento que ya se reintentará al minuto
  // siguiente.
  return Response.json({
    ok: true,
    inbox: estado(inbox),
    notifications: estado(notifications),
  });
}
