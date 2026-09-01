import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * El LATIDO de los workers de recuperación.
 *
 * Lo que se prueba aquí es la puerta y el DIAGNÓSTICO, no el trabajo: los dos
 * workers ya tienen sus propios tests. Esta ruta existe porque los cron de
 * Vercel invocan por GET y sin cabeceras propias.
 *
 * Tres cosas pueden salir mal en ella, y las tres se prueban: que deje entrar a
 * quien no debe; que un worker caído impida que el otro corra; y —la que se
 * añadió después— que un latido que no movió nada se reporte como sano. Este
 * endpoint es la red de seguridad del sistema y su modo de fallo es silencioso,
 * así que un 200 incondicional lo convertía en un monitor que siempre dice que
 * todo va bien.
 */

const llamadas: string[] = [];
const fallos = { inbox: false, notifications: false, alerts: false };
/** Estado con el que responde cada worker cuando NO lanza. */
const estados = { inbox: 200, notifications: 200, alerts: 200 };

vi.mock('@/lib/log', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

vi.mock('@/lib/env/env', () => ({
  getServerEnv: () => ({ INTERNAL_API_TOKEN: 'token-interno-de-prueba' }),
}));

vi.mock('../../webhook-events/worker/tick/route', () => ({
  POST: async (req: Request) => {
    llamadas.push(`inbox:${req.method}:${req.headers.get('authorization')}`);
    if (fallos.inbox) throw new Error('inbox caído: SELECT * FROM webhook_events');
    return Response.json({ ok: true }, { status: estados.inbox });
  },
}));

vi.mock('../../order-notifications/worker/tick/route', () => ({
  POST: async (req: Request) => {
    llamadas.push(`notifications:${req.method}:${req.headers.get('authorization')}`);
    if (fallos.notifications) throw new Error('notificaciones caídas: 59171234567');
    return Response.json({ ok: true }, { status: estados.notifications });
  },
}));

vi.mock('../../telegram-alerts/worker/tick/route', () => ({
  POST: async (req: Request) => {
    llamadas.push(`alerts:${req.method}:${req.headers.get('authorization')}`);
    if (fallos.alerts) throw new Error('alertas caídas: 59171234567');
    return Response.json({ ok: true }, { status: estados.alerts });
  },
}));

const { GET } = await import('./route');

const TOKEN = 'token-interno-de-prueba';

function pedir(auth?: string): Request {
  return new Request('https://ejemplo.test/api/internal/cron/tick', {
    method: 'GET',
    headers: auth ? { authorization: auth } : {},
  });
}

beforeEach(() => {
  llamadas.length = 0;
  fallos.inbox = false;
  fallos.notifications = false;
  fallos.alerts = false;
  estados.inbox = 200;
  estados.alerts = 200;
  estados.notifications = 200;
  delete process.env.CRON_SECRET;
});

describe('la puerta del latido', () => {
  it('sin Bearer no dispara nada', async () => {
    const res = await GET(pedir());
    expect(res.status).toBe(401);
    expect(llamadas).toEqual([]);
  });

  it('con un token equivocado tampoco', async () => {
    const res = await GET(pedir('Bearer token-que-no-es'));
    expect(res.status).toBe(401);
    expect(llamadas).toEqual([]);
  });

  it('un prefijo del token correcto no basta', async () => {
    // La comparación es en tiempo constante y sobre la cadena entera.
    const res = await GET(pedir(`Bearer ${TOKEN.slice(0, -1)}`));
    expect(res.status).toBe(401);
  });

  it('acepta también CRON_SECRET, que es el que Vercel rellena solo', async () => {
    process.env.CRON_SECRET = 'secreto-de-vercel';
    const res = await GET(pedir('Bearer secreto-de-vercel'));
    expect(res.status).toBe(200);
  });
});

describe('el latido mueve los DOS workers', () => {
  it('con el token correcto los invoca por POST y con el Bearer interno', async () => {
    const res = await GET(pedir(`Bearer ${TOKEN}`));

    expect(res.status).toBe(200);
    // Los workers son POST: la ruta traduce el GET del cron, no los afloja.
    expect(llamadas).toContain(`inbox:POST:Bearer ${TOKEN}`);
    expect(llamadas).toContain(`notifications:POST:Bearer ${TOKEN}`);
    expect(llamadas).toContain(`alerts:POST:Bearer ${TOKEN}`);
  });

  it('si el inbox falla, las notificaciones se recuperan igual', async () => {
    // Son independientes: que uno caiga no puede dejar al otro sin correr, o un
    // fallo aislado se llevaría por delante toda la red de seguridad.
    fallos.inbox = true;

    const res = await GET(pedir(`Bearer ${TOKEN}`));

    expect(llamadas.some((l) => l.startsWith('notifications:'))).toBe(true);
    expect(await res.json()).toMatchObject({ ok: false, inbox: 'error', notifications: 200 });
  });

  it('y al revés', async () => {
    fallos.notifications = true;
    await GET(pedir(`Bearer ${TOKEN}`));
    expect(llamadas.some((l) => l.startsWith('inbox:'))).toBe(true);
  });

  it('los dos se invocan aunque el primero lance: nada de cortocircuito', async () => {
    fallos.inbox = true;
    fallos.notifications = true;
    await GET(pedir(`Bearer ${TOKEN}`));
    expect(llamadas.some((l) => l.startsWith('inbox:'))).toBe(true);
    expect(llamadas.some((l) => l.startsWith('notifications:'))).toBe(true);
  });
});

describe('el estado HTTP dice si el latido movió a los DOS', () => {
  it('200 solo cuando los dos responden 2xx', async () => {
    const res = await GET(pedir(`Bearer ${TOKEN}`));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, inbox: 200, notifications: 200 });
  });

  it('503 si un worker LANZA', async () => {
    fallos.inbox = true;
    expect((await GET(pedir(`Bearer ${TOKEN}`))).status).toBe(503);
  });

  it('503 si un worker responde 4xx', async () => {
    // Un 401 del worker significa que el token interno no cuadra: el latido no
    // recuperó nada ese minuto, y devolver 200 lo dejaría invisible para
    // siempre — es justo el fallo que hay que ver enseguida.
    estados.notifications = 401;
    const res = await GET(pedir(`Bearer ${TOKEN}`));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false, notifications: 401 });
  });

  it('503 si un worker responde 5xx', async () => {
    estados.inbox = 500;
    expect((await GET(pedir(`Bearer ${TOKEN}`))).status).toBe(503);
  });

  it('503 si los dos caen', async () => {
    fallos.inbox = true;
    estados.notifications = 500;
    expect((await GET(pedir(`Bearer ${TOKEN}`))).status).toBe(503);
  });

  it('cualquier 2xx cuenta como ejecutado, no solo el 200', async () => {
    // 204 queda fuera a propósito: `Response.json` no admite cuerpo con 204,
    // así que el doble no puede representarlo sin dejar de ser un doble fiel.
    estados.inbox = 202;
    estados.notifications = 299;
    const res = await GET(pedir(`Bearer ${TOKEN}`));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it('un evento que falló DENTRO del worker sigue siendo un tick ejecutado', async () => {
    // El worker responde 200 informando de que un evento falló. Ese evento ya
    // quedó reprogramado con su `next_attempt_at` y vuelve solo: es el sistema
    // funcionando. Teñir el latido de rojo por eso haría que la alarma sonara
    // todos los días y dejara de mirarse — y entonces no sonaría el día que el
    // latido de verdad se para.
    estados.inbox = 200;
    const res = await GET(pedir(`Bearer ${TOKEN}`));
    expect(res.status).toBe(200);
  });

  it('no hay reintento interno: cada worker se invoca UNA vez', async () => {
    // Un retry dentro de la misma invocación alargaría el tick hacia el
    // siguiente minuto. El reintento es el próximo Cron.
    fallos.inbox = true;
    await GET(pedir(`Bearer ${TOKEN}`));
    expect(llamadas.filter((l) => l.startsWith('inbox:'))).toHaveLength(1);
    expect(llamadas.filter((l) => l.startsWith('notifications:'))).toHaveLength(1);
  });
});

describe('la respuesta no filtra nada', () => {
  it('ni el token ni detalles internos viajan al cuerpo', async () => {
    const cuerpo = JSON.stringify(await (await GET(pedir(`Bearer ${TOKEN}`))).json());
    expect(cuerpo).not.toContain(TOKEN);
    expect(cuerpo).not.toContain('caído');
  });

  it('el 503 tampoco lleva la excepción, ni SQL, ni teléfonos', async () => {
    // Las excepciones de los workers llevan a propósito una consulta y un
    // teléfono: si algo de eso apareciera en el cuerpo, sería un endpoint que
    // filtra la base a quien tenga el Bearer.
    fallos.inbox = true;
    fallos.notifications = true;
    const res = await GET(pedir(`Bearer ${TOKEN}`));
    const cuerpo = JSON.stringify(await res.json());

    expect(res.status).toBe(503);
    expect(cuerpo).not.toContain('SELECT');
    expect(cuerpo).not.toContain('webhook_events');
    expect(cuerpo).not.toContain('59171234567');
    expect(cuerpo).not.toContain('caídas');
    // Lo único que se dice de un worker que lanzó es que lanzó.
    expect(cuerpo).toContain('error');
  });
});

// ── El fallback tiene que mover TODOS los workers ───────────────────────────
//
// Cuando se añadió el outbox de alertas (0028), el fallback movía dos de tres y
// nada lo decía: un latido que solo recupera parte del sistema informa `ok` como
// si lo hubiera recuperado entero. Es la misma clase de divergencia que ya costó
// un fallo en este repo —el worker del inbox ejecutando menos capacidades que el
// webhook— y se detecta igual de tarde.

describe('el latido no puede quedarse corto', () => {
  it('mueve los TRES workers en una sola invocación', async () => {
    await GET(pedir(`Bearer ${TOKEN}`));
    const movidos = llamadas.map((l) => l.split(':')[0]).sort();
    expect(movidos).toEqual(['alerts', 'inbox', 'notifications']);
  });

  it('un worker de alertas caído no impide que corran los otros dos', async () => {
    fallos.alerts = true;
    const res = await GET(pedir(`Bearer ${TOKEN}`));
    expect(llamadas.some((l) => l.startsWith('inbox:'))).toBe(true);
    expect(llamadas.some((l) => l.startsWith('notifications:'))).toBe(true);
    // Y el latido NO se reporta sano: el minuto no recuperó las alertas.
    expect(res.status).toBe(503);
  });

  it('si las alertas responden 401, el latido lo dice en vez de callar', async () => {
    estados.alerts = 401;
    const res = await GET(pedir(`Bearer ${TOKEN}`));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false, alerts: 401 });
  });

  it('el cuerpo nombra a cada worker por separado', async () => {
    // Un 503 sin decir cuál cayó obliga a abrir los logs para saber dónde mirar.
    const res = await GET(pedir(`Bearer ${TOKEN}`));
    expect(await res.json()).toEqual({
      ok: true,
      inbox: 200,
      notifications: 200,
      alerts: 200,
    });
  });
});
