import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseImage, type ImageAttachment } from './channel/image';
import {
  imageNoCaptionEnvelope,
  KAPSO_MEDIA_URL,
  KAPSO_R2_REDIRECT_URL,
  META_LOOKASIDE_URL,
} from './channel/image.fixtures';
import { MEDIA_MAX_BYTES } from '@/lib/agent/core/media';

/**
 * RESOLUTOR DE MEDIA — la descarga real (endurecimiento pre-push de 5C.5).
 *
 * Lo que se prueba aquí es lo que `media-url-policy.test.ts` no puede: que la
 * política se aplique a CADA SALTO de la cadena de redirects, que la clave de
 * Kapso no viaje a un dominio ajeno, y que los topes de tamaño y tiempo corten
 * de verdad.
 */

const API_KEY = 'kapso-key-de-prueba';

vi.mock('@/lib/env/env', () => ({
  getServerEnv: () => ({ KAPSO_API_KEY: API_KEY }),
}));

// El logger escupe JSON por consola; aquí estorba, pero además interesa MIRARLO:
// una URL de media es una credencial de acceso al archivo del cliente, y el sitio
// donde se filtraría sin que nadie se diera cuenta es justamente un log de error.
const logSpy = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock('@/lib/log', () => ({ log: logSpy }));

const { createKapsoMediaResolver } = await import('./media-resolver');

/** Adjunto real, con sus dos referencias transitorias. */
function adjunto(over: Partial<ImageAttachment['facts']> = {}): ImageAttachment {
  const base = parseImage(imageNoCaptionEnvelope().message as Record<string, unknown>)!;
  return { ...base, facts: { ...base.facts, ...over } };
}

/** Adjunto con UNA sola referencia, para que el orden no enturbie la lectura. */
function soloKapso(): ImageAttachment {
  return {
    ...adjunto(),
    transient: { kapsoMediaUrl: KAPSO_MEDIA_URL, link: null, metaUrl: null },
  };
}

interface RespuestaFalsa {
  status: number;
  headers?: Record<string, string>;
  body?: Uint8Array;
}

function respuesta({ status, headers = {}, body }: RespuestaFalsa): Response {
  const mapa = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => mapa.get(name.toLowerCase()) ?? null },
    arrayBuffer: async () => (body ?? new Uint8Array([1, 2, 3])).buffer,
  } as unknown as Response;
}

const IMAGEN_OK = respuesta({ status: 200, headers: { 'content-type': 'image/jpeg' } });

/** `fetch` guionizado: una respuesta por llamada, y registro de a dónde fue. */
function fetchGuion(...respuestas: (Response | Error)[]) {
  const llamadas: { url: string; headers: Record<string, string> }[] = [];
  let paso = 0;
  const fn = vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
    llamadas.push({ url, headers: init?.headers ?? {} });
    const siguiente = respuestas[Math.min(paso, respuestas.length - 1)];
    paso += 1;
    if (siguiente instanceof Error) throw siguiente;
    return siguiente;
  });
  return { fn, llamadas };
}

function stubFetch(guion: ReturnType<typeof fetchGuion>): void {
  vi.stubGlobal('fetch', guion.fn as unknown as typeof fetch);
}

beforeEach(() => {
  vi.unstubAllGlobals();
  logSpy.info.mockClear();
  logSpy.warn.mockClear();
  logSpy.error.mockClear();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('media-resolver — el camino que funciona', () => {
  it('descarga y devuelve un data URL, nunca la URL de origen', async () => {
    const guion = fetchGuion(IMAGEN_OK);
    stubFetch(guion);

    const res = await createKapsoMediaResolver().resolveImage(soloKapso(), null);

    expect(res).toMatchObject({
      ok: true,
      source: 'transient_kapso',
      mimeType: 'image/jpeg',
      byteSize: 3,
    });
    expect(res.ok && res.dataUrl.startsWith('data:image/jpeg;base64,')).toBe(true);
    // Lo que sale hacia el modelo no contiene la referencia de acceso.
    expect(res.ok && res.dataUrl).not.toContain('kapso.ai');
  });

  it('la clave de Kapso viaja a app.kapso.ai y solo ahí', async () => {
    const guion = fetchGuion(IMAGEN_OK);
    stubFetch(guion);

    await createKapsoMediaResolver().resolveImage(soloKapso(), null);

    expect(guion.llamadas[0].headers['X-API-Key']).toBe(API_KEY);
  });

  it('al lookaside de Meta NO se le manda nuestra clave', async () => {
    const guion = fetchGuion(IMAGEN_OK);
    stubFetch(guion);

    const soloMeta: ImageAttachment = {
      ...adjunto(),
      transient: { kapsoMediaUrl: null, link: null, metaUrl: META_LOOKASIDE_URL },
    };
    const res = await createKapsoMediaResolver().resolveImage(soloMeta, null);

    expect(res).toMatchObject({ ok: true, source: 'transient_meta' });
    expect(guion.llamadas[0].headers['X-API-Key']).toBeUndefined();
  });

  it('si la primera referencia cae, se prueba la siguiente', async () => {
    const guion = fetchGuion(respuesta({ status: 404 }), IMAGEN_OK);
    stubFetch(guion);

    // El adjunto real trae kapso y meta (link coincide con kapso y se deduplica).
    const res = await createKapsoMediaResolver().resolveImage(adjunto(), null);

    expect(res).toMatchObject({ ok: true, source: 'transient_meta' });
    expect(guion.fn).toHaveBeenCalledTimes(2);
  });
});

describe('media-resolver — SSRF: la puerta se cruza en cada salto', () => {
  it('un redirect a un host DESCONOCIDO no se sigue', async () => {
    const guion = fetchGuion(
      respuesta({ status: 302, headers: { location: 'https://evil.example.com/foto.jpg' } }),
      IMAGEN_OK,
    );
    stubFetch(guion);

    const res = await createKapsoMediaResolver().resolveImage(soloKapso(), null);

    expect(res).toEqual({ ok: false, error: 'blocked_url' });
    // Y sobre todo: NUNCA se llamó al host desconocido.
    expect(guion.fn).toHaveBeenCalledTimes(1);
    expect(guion.llamadas.some((l) => l.url.includes('evil.example.com'))).toBe(false);
  });

  it('un redirect a localhost tampoco', async () => {
    const guion = fetchGuion(
      respuesta({ status: 307, headers: { location: 'http://127.0.0.1:3000/api/internal' } }),
      IMAGEN_OK,
    );
    stubFetch(guion);

    expect(await createKapsoMediaResolver().resolveImage(soloKapso(), null)).toEqual({
      ok: false,
      error: 'blocked_url',
    });
    expect(guion.fn).toHaveBeenCalledTimes(1);
  });

  it('un redirect ENTRE hosts permitidos sí se sigue, y sin arrastrar la clave', async () => {
    const guion = fetchGuion(
      respuesta({ status: 302, headers: { location: META_LOOKASIDE_URL } }),
      IMAGEN_OK,
    );
    stubFetch(guion);

    const res = await createKapsoMediaResolver().resolveImage(soloKapso(), null);

    expect(res).toMatchObject({ ok: true, source: 'transient_kapso' });
    expect(guion.fn).toHaveBeenCalledTimes(2);
    expect(guion.llamadas[0].headers['X-API-Key']).toBe(API_KEY);
    // El segundo salto es de Meta: nuestra credencial no va ahí.
    expect(guion.llamadas[1].headers['X-API-Key']).toBeUndefined();
  });

  it('LA CADENA REAL: app.kapso.ai → 302 → su bucket de R2 → los bytes', async () => {
    // Reproduce exactamente lo observado en Production el 27-08-2026. Antes de
    // añadir el host de R2 esto moría en el salto 1 con `blocked_url`, y cada
    // comprobante quedaba `failed` con el archivo inalcanzable.
    const guion = fetchGuion(
      respuesta({ status: 302, headers: { location: KAPSO_R2_REDIRECT_URL } }),
      respuesta({
        status: 200,
        headers: { 'content-type': 'image/jpeg', 'content-length': '66375' },
      }),
    );
    stubFetch(guion);

    const res = await createKapsoMediaResolver().resolveImage(soloKapso(), null);

    expect(res).toMatchObject({ ok: true, source: 'transient_kapso', mimeType: 'image/jpeg' });
    expect(guion.fn).toHaveBeenCalledTimes(2);
    // La clave va al primer salto —Kapso la exige para emitir el 302— y NO al
    // segundo: R2 es Cloudflare y la URL ya viene firmada.
    expect(guion.llamadas[0].headers['X-API-Key']).toBe(API_KEY);
    expect(guion.llamadas[1].headers['X-API-Key']).toBeUndefined();
    // Y lo que sale no lleva ninguna de las dos referencias de acceso.
    expect(res.ok && res.dataUrl).not.toContain('cloudflarestorage');
    expect(res.ok && res.dataUrl).not.toContain('kapso.ai');
  });

  it('un redirect al bucket de OTRO en R2 no se sigue', async () => {
    // El salto 1 es una URL elegida por el proveedor. Que el destino comparta
    // sufijo con el permitido no lo convierte en permitido.
    const guion = fetchGuion(
      respuesta({
        status: 302,
        headers: { location: 'https://evil.r2.cloudflarestorage.com/objeto' },
      }),
      IMAGEN_OK,
    );
    stubFetch(guion);

    expect(await createKapsoMediaResolver().resolveImage(soloKapso(), null)).toEqual({
      ok: false,
      error: 'blocked_url',
    });
    expect(guion.fn).toHaveBeenCalledTimes(1);
    expect(guion.llamadas.some((l) => l.url.includes('evil.r2'))).toBe(false);
  });

  it('el bucket de R2 tampoco se salta el MIME ni el tope de tamaño', async () => {
    // Estar en la lista blanca no exime del resto de la política: lo que llega
    // por el salto final se juzga igual que por el primero.
    const guion = fetchGuion(
      respuesta({ status: 302, headers: { location: KAPSO_R2_REDIRECT_URL } }),
      respuesta({ status: 200, headers: { 'content-type': 'text/html' } }),
    );
    stubFetch(guion);
    expect(await createKapsoMediaResolver().resolveImage(soloKapso(), null)).toEqual({
      ok: false,
      error: 'unsupported_mime',
    });

    const guion2 = fetchGuion(
      respuesta({ status: 302, headers: { location: KAPSO_R2_REDIRECT_URL } }),
      respuesta({
        status: 200,
        headers: {
          'content-type': 'image/jpeg',
          'content-length': String(MEDIA_MAX_BYTES + 1),
        },
      }),
    );
    stubFetch(guion2);
    expect(await createKapsoMediaResolver().resolveImage(soloKapso(), null)).toEqual({
      ok: false,
      error: 'too_large',
    });
  });

  it('un redirect RELATIVO se resuelve contra el salto actual', async () => {
    const guion = fetchGuion(
      respuesta({ status: 302, headers: { location: '/media/otro-token' } }),
      IMAGEN_OK,
    );
    stubFetch(guion);

    const res = await createKapsoMediaResolver().resolveImage(soloKapso(), null);

    expect(res.ok).toBe(true);
    expect(guion.llamadas[1].url).toBe('https://app.kapso.ai/media/otro-token');
  });

  it('una cadena de redirects sin fin se corta', async () => {
    const guion = fetchGuion(
      respuesta({ status: 302, headers: { location: KAPSO_MEDIA_URL } }),
    );
    stubFetch(guion);

    expect(await createKapsoMediaResolver().resolveImage(soloKapso(), null)).toEqual({
      ok: false,
      error: 'unavailable',
    });
    // Salto inicial + 3 permitidos. No más.
    expect(guion.fn).toHaveBeenCalledTimes(4);
  });

  it('un 302 sin Location no se inventa un destino', async () => {
    const guion = fetchGuion(respuesta({ status: 302 }));
    stubFetch(guion);

    expect(await createKapsoMediaResolver().resolveImage(soloKapso(), null)).toEqual({
      ok: false,
      error: 'unavailable',
    });
  });

  it('una referencia con host prohibido no gasta ni una petición', async () => {
    const guion = fetchGuion(IMAGEN_OK);
    stubFetch(guion);

    const raro: ImageAttachment = {
      ...adjunto(),
      transient: {
        kapsoMediaUrl: 'https://cdn.desconocido.example/foto.jpg',
        link: null,
        metaUrl: null,
      },
    };

    expect(await createKapsoMediaResolver().resolveImage(raro, null)).toEqual({
      ok: false,
      error: 'blocked_url',
    });
    expect(guion.fn).not.toHaveBeenCalled();
  });
});

describe('media-resolver — topes y desenlaces', () => {
  it('el MIME declarado manda antes de tocar la red', async () => {
    const guion = fetchGuion(IMAGEN_OK);
    stubFetch(guion);

    const svg = { ...soloKapso(), facts: { ...adjunto().facts, mimeType: 'image/svg+xml' } };
    expect(await createKapsoMediaResolver().resolveImage(svg, null)).toEqual({
      ok: false,
      error: 'unsupported_mime',
    });
    expect(guion.fn).not.toHaveBeenCalled();
  });

  it('el content-type REAL vuelve a juzgarse aunque el declarado fuera bueno', async () => {
    const guion = fetchGuion(
      respuesta({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }),
    );
    stubFetch(guion);

    expect(await createKapsoMediaResolver().resolveImage(soloKapso(), null)).toEqual({
      ok: false,
      error: 'unsupported_mime',
    });
  });

  it('content-length por encima del tope: se corta sin leer el cuerpo', async () => {
    const guion = fetchGuion(
      respuesta({
        status: 200,
        headers: { 'content-type': 'image/jpeg', 'content-length': String(MEDIA_MAX_BYTES + 1) },
      }),
    );
    stubFetch(guion);

    expect(await createKapsoMediaResolver().resolveImage(soloKapso(), null)).toEqual({
      ok: false,
      error: 'too_large',
    });
  });

  it('un servidor que MIENTE con content-length se corta con los bytes reales', async () => {
    const guion = fetchGuion(
      respuesta({
        status: 200,
        headers: { 'content-type': 'image/jpeg', 'content-length': '10' },
        body: new Uint8Array(MEDIA_MAX_BYTES + 1),
      }),
    );
    stubFetch(guion);

    expect(await createKapsoMediaResolver().resolveImage(soloKapso(), null)).toEqual({
      ok: false,
      error: 'too_large',
    });
  });

  it('un cuerpo vacío no es una imagen', async () => {
    const guion = fetchGuion(
      respuesta({
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
        body: new Uint8Array(0),
      }),
    );
    stubFetch(guion);

    expect(await createKapsoMediaResolver().resolveImage(soloKapso(), null)).toEqual({
      ok: false,
      error: 'unavailable',
    });
  });

  it('un abort se reporta como timeout, sin filtrar el mensaje del error', async () => {
    const abort = new Error('The operation was aborted');
    abort.name = 'AbortError';
    const guion = fetchGuion(abort);
    stubFetch(guion);

    expect(await createKapsoMediaResolver().resolveImage(soloKapso(), null)).toEqual({
      ok: false,
      error: 'timeout',
    });
  });

  it('sin presupuesto de tiempo no se abre ni la conexión', async () => {
    const guion = fetchGuion(IMAGEN_OK);
    stubFetch(guion);

    expect(
      await createKapsoMediaResolver().resolveImage(soloKapso(), null, { timeoutMs: 0 }),
    ).toEqual({ ok: false, error: 'timeout' });
    expect(guion.fn).not.toHaveBeenCalled();
  });

  it('un timeout NO se reintenta con la siguiente referencia', async () => {
    // El reloj es del intento entero: cambiar de URL no devuelve tiempo.
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    const guion = fetchGuion(abort, IMAGEN_OK);
    stubFetch(guion);

    expect(await createKapsoMediaResolver().resolveImage(adjunto(), null)).toEqual({
      ok: false,
      error: 'timeout',
    });
    expect(guion.fn).toHaveBeenCalledTimes(1);
  });

  it('sin ninguna referencia, unavailable y ni una petición', async () => {
    const guion = fetchGuion(IMAGEN_OK);
    stubFetch(guion);

    const sinUrls: ImageAttachment = {
      ...adjunto(),
      transient: { kapsoMediaUrl: null, link: null, metaUrl: null },
    };

    expect(await createKapsoMediaResolver().resolveImage(sinUrls, null)).toEqual({
      ok: false,
      error: 'unavailable',
    });
    expect(guion.fn).not.toHaveBeenCalled();
  });
});

describe('media-resolver — las URLs firmadas no salen por el log', () => {
  /**
   * Cada URL de aquí es una credencial: quien la tenga puede bajarse la foto del
   * cliente mientras siga viva, y la de R2 lleva la firma en el query string. El
   * contrato del módulo es que al log solo van el HOSTNAME y un motivo saneado.
   *
   * Se comprueba sobre el argumento entero serializado y no campo a campo: lo
   * que hay que impedir es que la URL aparezca EN ALGÚN sitio del registro, no
   * que un campo concreto esté limpio.
   */
  function registrado(): string {
    return JSON.stringify([
      ...logSpy.warn.mock.calls,
      ...logSpy.error.mock.calls,
      ...logSpy.info.mock.calls,
    ]);
  }

  /** Ni la ruta, ni el token, ni la firma: nada de lo que hay tras el host. */
  function noFiltra(texto: string): void {
    expect(texto).not.toContain('sanitized-token');
    expect(texto).not.toContain('sanitized-key');
    expect(texto).not.toContain(KAPSO_MEDIA_URL);
    expect(texto).not.toContain(KAPSO_R2_REDIRECT_URL);
    expect(texto).not.toContain('https://');
  }

  it('un destino bloqueado registra el host y el motivo, nunca la URL', async () => {
    const guion = fetchGuion(
      respuesta({
        status: 302,
        headers: { location: 'https://evil.r2.cloudflarestorage.com/objeto?firma=SECRETA' },
      }),
    );
    stubFetch(guion);

    await createKapsoMediaResolver().resolveImage(soloKapso(), null);

    expect(logSpy.warn).toHaveBeenCalledWith('agent_media_url_blocked', {
      source: 'transient_kapso',
      reason: 'host_not_allowed',
      host: 'evil.r2.cloudflarestorage.com',
      redirect_hop: 1,
    });
    const texto = registrado();
    expect(texto).not.toContain('firma=SECRETA');
    noFiltra(texto);
  });

  it('un fallo del bucket registra la familia del status, no el cuerpo ni la URL', async () => {
    const guion = fetchGuion(
      respuesta({ status: 302, headers: { location: KAPSO_R2_REDIRECT_URL } }),
      respuesta({ status: 403 }),
    );
    stubFetch(guion);

    await createKapsoMediaResolver().resolveImage(soloKapso(), null);

    expect(logSpy.warn).toHaveBeenCalledWith('agent_media_fetch_failed', {
      source: 'transient_kapso',
      host: 'kapso-ai-prod.d77f1e59818b5ed2ec009d1a9116b255.r2.cloudflarestorage.com',
      // La familia, no el 403 exacto ni el cuerpo de la respuesta.
      status_class: '4xx',
    });
    noFiltra(registrado());
  });

  it('la descarga que SÍ funciona no registra ninguna referencia', async () => {
    const guion = fetchGuion(
      respuesta({ status: 302, headers: { location: KAPSO_R2_REDIRECT_URL } }),
      respuesta({ status: 200, headers: { 'content-type': 'image/jpeg' } }),
    );
    stubFetch(guion);

    const res = await createKapsoMediaResolver().resolveImage(soloKapso(), null);

    expect(res.ok).toBe(true);
    noFiltra(registrado());
  });
});
