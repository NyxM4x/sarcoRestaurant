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
 *
 * Independencia en la EJECUCIÓN, no en el diagnóstico: los dos corren pase lo
 * que pase, y después el estado HTTP resume si los dos lo consiguieron.
 *
 * ── Esta ruta es el FALLBACK, no el despertador principal ────────────────────
 *
 * El camino oficial son los dos Cloudflare Workers dedicados
 * (`cloudflare/webhook-events-recovery-cron` y
 * `cloudflare/notification-recovery-cron`), que llaman por POST a cada worker
 * interno por separado, cada uno con su propio presupuesto de 55 s y su propia
 * observabilidad. Esa separación existe porque un evento del inbox puede llevar
 * un turno completo del agente —11-12 s medidos—: encadenar los dos recoveries
 * en una sola invocación hace que uno le coma el presupuesto al otro.
 *
 * Esta ruta se conserva porque no cuesta nada y cubre el caso en que Cloudflare
 * esté caído o los Workers todavía no estén desplegados: un solo cron de Vercel
 * mueve los dos. Pero mientras los Workers estén activos, el despertador
 * principal son ellos, y esto es la segunda cuerda.
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

  /**
   * Estado de UN worker, saneado.
   *
   * Una promesa rechazada sale como `'error'` y nada más: el mensaje de la
   * excepción puede llevar una consulta SQL, una URL con token o el teléfono de
   * un cliente, y esto se devuelve por HTTP.
   */
  const estado = (r: PromiseSettledResult<Response>): number | 'error' =>
    r.status === 'fulfilled' ? r.value.status : 'error';

  /**
   * ¿Este worker se EJECUTÓ?
   *
   * Un 2xx significa que el tick corrió y el worker informó de lo que hizo. Lo
   * que hizo puede incluir eventos que fallaron: esos ya quedaron reprogramados
   * dentro del worker, con su `next_attempt_at`, y volverán solos. Eso es el
   * sistema funcionando, no una avería, y no debe teñir el latido de rojo.
   *
   * Lo que sí es una avería es que el worker no llegara a responder —lanzó— o
   * respondiera 401, 4xx o 5xx: entonces el minuto entero no se recuperó nada y
   * nadie se enteraría si esto devolviera 200.
   */
  const ejecutado = (r: PromiseSettledResult<Response>): boolean =>
    r.status === 'fulfilled' && r.value.status >= 200 && r.value.status <= 299;

  const inboxOk = ejecutado(inbox);
  const notificationsOk = ejecutado(notifications);
  const ok = inboxOk && notificationsOk;

  log.info('cron_tick_done', {
    ok,
    inbox: estado(inbox),
    notifications: estado(notifications),
  });

  // ── 200 solo si los DOS se ejecutaron; 503 si alguno no ────────────────────
  //
  // El latido es la red de seguridad del sistema, y su modo de fallo es
  // silencioso: si deja de correr, no aparece ningún error en ninguna parte —
  // simplemente hay pedidos que no se confirman y comprobantes que no se
  // capturan, y nadie se entera hasta que reclama el cliente.
  //
  // Devolver 200 pase lo que pase convertía este endpoint en un monitor que
  // siempre dice que todo va bien. 503 —"servicio no disponible"— es la
  // respuesta correcta para "el latido no pudo mover a alguno de los dos": es
  // reintentable por naturaleza, y el propio Cron reintenta al minuto.
  //
  // NO se reintenta aquí. Un retry interno alargaría la invocación dentro de la
  // misma ventana y podría solaparse con el siguiente tick; el reintento es el
  // minuto que viene, con el trabajo intacto en la base.
  //
  // El cuerpo lleva los dos estados por separado a propósito: un 503 sin decir
  // cuál de los dos cayó obliga a abrir los logs para saber dónde mirar.
  return Response.json(
    { ok, inbox: estado(inbox), notifications: estado(notifications) },
    { status: ok ? 200 : 503 },
  );
}
