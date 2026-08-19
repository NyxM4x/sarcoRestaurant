import { describe, it, expect } from 'vitest';
import { getDistanceByRoad, type MapboxClientConfig } from './mapbox';

// Origen (restaurante) y destino (cliente) válidos para Santa Cruz.
const ORIGIN = { lat: -17.783, lng: -63.182 };
const DEST = { lat: -17.76, lng: -63.2 };

interface Captured {
  url: string;
  method: string | undefined;
}

/** `fetch` falso que responde con un status + JSON dados y captura la URL. */
function fakeFetch(
  status: number,
  body: unknown,
  captured?: Captured[],
  opts: { throwSyntaxOnJson?: boolean } = {},
): typeof fetch {
  return (async (url: string, init?: { method?: string }) => {
    captured?.push({ url: String(url), method: init?.method });
    return {
      ok: status >= 200 && status < 300,
      status,
      async json() {
        if (opts.throwSyntaxOnJson) throw new SyntaxError('Unexpected token');
        return body;
      },
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

function cfg(over: Partial<MapboxClientConfig> = {}): MapboxClientConfig {
  return { accessToken: 'pk.test-token', baseUrl: 'https://mapbox.test', ...over };
}

const okBody = (distance: number) => ({ code: 'Ok', routes: [{ distance }] });

describe('getDistanceByRoad — respuesta válida', () => {
  it('devuelve la distancia en metros enteros', async () => {
    const res = await getDistanceByRoad(
      { origin: ORIGIN, destination: DEST },
      cfg({ fetchImpl: fakeFetch(200, okBody(7623)) }),
    );
    expect(res).toEqual({ ok: true, distanceMeters: 7623 });
  });

  it('redondea una distancia decimal al metro más cercano (determinista)', async () => {
    const res = await getDistanceByRoad(
      { origin: ORIGIN, destination: DEST },
      cfg({ fetchImpl: fakeFetch(200, okBody(7623.4)) }),
    );
    expect(res).toEqual({ ok: true, distanceMeters: 7623 });

    const res2 = await getDistanceByRoad(
      { origin: ORIGIN, destination: DEST },
      cfg({ fetchImpl: fakeFetch(200, okBody(7623.6)) }),
    );
    expect(res2).toEqual({ ok: true, distanceMeters: 7624 });
  });

  it('construye la URL driving con lng,lat, overview=false y sin registrar el token en el resultado', async () => {
    const captured: Captured[] = [];
    const res = await getDistanceByRoad(
      { origin: ORIGIN, destination: DEST },
      cfg({ fetchImpl: fakeFetch(200, okBody(1000), captured) }),
    );
    expect(res.ok).toBe(true);
    const url = captured[0].url;
    expect(captured[0].method).toBe('GET');
    expect(url).toContain('/directions/v5/mapbox/driving/');
    // Orden lng,lat;lng,lat.
    expect(url).toContain(`${ORIGIN.lng},${ORIGIN.lat};${DEST.lng},${DEST.lat}`);
    expect(url).toContain('overview=false');
    expect(url).toContain('alternatives=false');
    // El token va en la query (requisito de Mapbox) pero jamás en el resultado.
    expect(JSON.stringify(res)).not.toContain('pk.test-token');
  });
});

describe('getDistanceByRoad — errores HTTP', () => {
  it('401 → http_401', async () => {
    const res = await getDistanceByRoad(
      { origin: ORIGIN, destination: DEST },
      cfg({ fetchImpl: fakeFetch(401, { message: 'Not Authorized' }) }),
    );
    expect(res).toEqual({ ok: false, error: 'http_401' });
  });

  it('403 → http_403', async () => {
    const res = await getDistanceByRoad(
      { origin: ORIGIN, destination: DEST },
      cfg({ fetchImpl: fakeFetch(403, { message: 'Forbidden' }) }),
    );
    expect(res).toEqual({ ok: false, error: 'http_403' });
  });

  it('500 → http_5xx', async () => {
    const res = await getDistanceByRoad(
      { origin: ORIGIN, destination: DEST },
      cfg({ fetchImpl: fakeFetch(500, { message: 'boom' }) }),
    );
    expect(res).toEqual({ ok: false, error: 'http_5xx' });
  });

  it('otros 4xx → http_error (representación segura, sin taxonomía innecesaria)', async () => {
    const res = await getDistanceByRoad(
      { origin: ORIGIN, destination: DEST },
      cfg({ fetchImpl: fakeFetch(422, { message: 'Invalid input' }) }),
    );
    expect(res).toEqual({ ok: false, error: 'http_error' });
  });
});

describe('getDistanceByRoad — timeout y red', () => {
  it('un abort del controller → timeout', async () => {
    const abortFetch = (async () => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      throw err;
    }) as unknown as typeof fetch;
    const res = await getDistanceByRoad(
      { origin: ORIGIN, destination: DEST },
      cfg({ fetchImpl: abortFetch, timeoutMs: 10 }),
    );
    expect(res).toEqual({ ok: false, error: 'timeout' });
  });

  it('un throw que no es abort → network_error', async () => {
    const netFetch = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const res = await getDistanceByRoad(
      { origin: ORIGIN, destination: DEST },
      cfg({ fetchImpl: netFetch }),
    );
    expect(res).toEqual({ ok: false, error: 'network_error' });
  });
});

describe('getDistanceByRoad — respuestas sin ruta / inválidas', () => {
  it('routes vacío → no_route', async () => {
    const res = await getDistanceByRoad(
      { origin: ORIGIN, destination: DEST },
      cfg({ fetchImpl: fakeFetch(200, { code: 'Ok', routes: [] }) }),
    );
    expect(res).toEqual({ ok: false, error: 'no_route' });
  });

  it('code NoRoute → no_route', async () => {
    const res = await getDistanceByRoad(
      { origin: ORIGIN, destination: DEST },
      cfg({ fetchImpl: fakeFetch(200, { code: 'NoRoute', routes: [] }) }),
    );
    expect(res).toEqual({ ok: false, error: 'no_route' });
  });

  it('JSON inválido → invalid_response', async () => {
    const res = await getDistanceByRoad(
      { origin: ORIGIN, destination: DEST },
      cfg({ fetchImpl: fakeFetch(200, null, undefined, { throwSyntaxOnJson: true }) }),
    );
    expect(res).toEqual({ ok: false, error: 'invalid_response' });
  });

  it('distance faltante → invalid_response', async () => {
    const res = await getDistanceByRoad(
      { origin: ORIGIN, destination: DEST },
      cfg({ fetchImpl: fakeFetch(200, { code: 'Ok', routes: [{}] }) }),
    );
    expect(res).toEqual({ ok: false, error: 'invalid_response' });
  });

  it('distance negativa → invalid_response', async () => {
    const res = await getDistanceByRoad(
      { origin: ORIGIN, destination: DEST },
      cfg({ fetchImpl: fakeFetch(200, okBody(-5)) }),
    );
    expect(res).toEqual({ ok: false, error: 'invalid_response' });
  });

  it('distance no numérica (string) → invalid_response', async () => {
    const res = await getDistanceByRoad(
      { origin: ORIGIN, destination: DEST },
      cfg({ fetchImpl: fakeFetch(200, { code: 'Ok', routes: [{ distance: '1000' }] }) }),
    );
    expect(res).toEqual({ ok: false, error: 'invalid_response' });
  });

  it('distance NaN → invalid_response', async () => {
    const res = await getDistanceByRoad(
      { origin: ORIGIN, destination: DEST },
      cfg({ fetchImpl: fakeFetch(200, { code: 'Ok', routes: [{ distance: Number.NaN }] }) }),
    );
    expect(res).toEqual({ ok: false, error: 'invalid_response' });
  });

  it('raíz no-objeto → invalid_response', async () => {
    const res = await getDistanceByRoad(
      { origin: ORIGIN, destination: DEST },
      cfg({ fetchImpl: fakeFetch(200, [1, 2, 3]) }),
    );
    expect(res).toEqual({ ok: false, error: 'invalid_response' });
  });
});

describe('getDistanceByRoad — coordenadas inválidas (sin tocar la red)', () => {
  it('destino fuera de rango → invalid_coordinates y NO se llama a fetch', async () => {
    const captured: Captured[] = [];
    const res = await getDistanceByRoad(
      { origin: ORIGIN, destination: { lat: 200, lng: -63 } },
      cfg({ fetchImpl: fakeFetch(200, okBody(1000), captured) }),
    );
    expect(res).toEqual({ ok: false, error: 'invalid_coordinates' });
    expect(captured).toHaveLength(0);
  });

  it('origen con NaN → invalid_coordinates', async () => {
    const captured: Captured[] = [];
    const res = await getDistanceByRoad(
      { origin: { lat: Number.NaN, lng: -63 }, destination: DEST },
      cfg({ fetchImpl: fakeFetch(200, okBody(1000), captured) }),
    );
    expect(res).toEqual({ ok: false, error: 'invalid_coordinates' });
    expect(captured).toHaveLength(0);
  });
});
