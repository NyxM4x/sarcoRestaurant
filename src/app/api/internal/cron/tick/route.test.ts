import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * El LATIDO de los workers de recuperación.
 *
 * Lo que se prueba aquí es la puerta, no el trabajo: los dos workers ya tienen
 * sus propios tests. Esta ruta existe porque los cron de Vercel invocan por GET
 * y sin cabeceras propias, y lo único que puede salir mal en ella es que deje
 * entrar a quien no debe — o que un worker caído impida que el otro corra.
 */

const llamadas: string[] = [];
const fallos = { inbox: false, notifications: false };

vi.mock('@/lib/log', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

vi.mock('@/lib/env/env', () => ({
  getServerEnv: () => ({ INTERNAL_API_TOKEN: 'token-interno-de-prueba' }),
}));

vi.mock('../../webhook-events/worker/tick/route', () => ({
  POST: async (req: Request) => {
    llamadas.push(`inbox:${req.method}:${req.headers.get('authorization')}`);
    if (fallos.inbox) throw new Error('inbox caído');
    return Response.json({ ok: true });
  },
}));

vi.mock('../../order-notifications/worker/tick/route', () => ({
  POST: async (req: Request) => {
    llamadas.push(`notifications:${req.method}:${req.headers.get('authorization')}`);
    if (fallos.notifications) throw new Error('notificaciones caídas');
    return Response.json({ ok: true });
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
  });

  it('si el inbox falla, las notificaciones se recuperan igual', async () => {
    // Son independientes: que uno caiga no puede dejar al otro sin correr, o un
    // fallo aislado se llevaría por delante toda la red de seguridad.
    fallos.inbox = true;

    const res = await GET(pedir(`Bearer ${TOKEN}`));

    expect(res.status).toBe(200);
    expect(llamadas.some((l) => l.startsWith('notifications:'))).toBe(true);
    expect(await res.json()).toMatchObject({ inbox: 'error', notifications: 200 });
  });

  it('y al revés', async () => {
    fallos.notifications = true;
    const res = await GET(pedir(`Bearer ${TOKEN}`));
    expect(res.status).toBe(200);
    expect(llamadas.some((l) => l.startsWith('inbox:'))).toBe(true);
  });

  it('un worker caído no pone el cron en rojo', async () => {
    // Un 500 haría que Vercel marcara el cron como fallido por un evento que se
    // reintentará al minuto siguiente de todos modos.
    fallos.inbox = true;
    fallos.notifications = true;
    expect((await GET(pedir(`Bearer ${TOKEN}`))).status).toBe(200);
  });
});

describe('la respuesta no filtra nada', () => {
  it('ni el token ni detalles internos viajan al cuerpo', async () => {
    const cuerpo = JSON.stringify(await (await GET(pedir(`Bearer ${TOKEN}`))).json());
    expect(cuerpo).not.toContain(TOKEN);
    expect(cuerpo).not.toContain('caído');
  });
});
