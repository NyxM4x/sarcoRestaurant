import { describe, it, expect } from 'vitest';
import { expandMapsLink } from './maps-link-service';

/**
 * La expansión del link corto: la única parte de este flujo que sale a la red,
 * y por tanto donde vive todo el riesgo.
 *
 * La URL la escribe el CLIENTE en un mensaje de WhatsApp. Lo que se prueba aquí
 * no es tanto que resuelva —eso lo hace Google— como que no se deje llevar a
 * ningún sitio que no sea Google.
 */

const CORTO = 'https://maps.app.goo.gl/5biYBaWPiPGPPcyB9';

/** La respuesta real de Google al link de arriba (medida el 01-09-2026). */
const LARGO =
  "https://www.google.com/maps/place/17%C2%B050'34.7%22S+63%C2%B010'44.9%22W/" +
  '@-17.8429809,-63.1817199,17z/data=!3m1!4b1!4m4!3m3!8m2!3d-17.8429809!4d-63.179145';

/** `fetch` falso: devuelve el `Location` que se le indique y registra llamadas. */
function fakeFetch(respuestas: Array<string | null>) {
  const urls: string[] = [];
  const fn = (async (input: string | URL | Request) => {
    urls.push(String(input));
    const location = respuestas[urls.length - 1] ?? null;
    return {
      headers: { get: (h: string) => (h.toLowerCase() === 'location' ? location : null) },
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fn, urls };
}

describe('expandMapsLink', () => {
  it('resuelve el link corto real en un salto', async () => {
    const f = fakeFetch([LARGO]);
    const res = await expandMapsLink(CORTO, { fetchImpl: f.fn });

    expect(res).toBe(LARGO);
    expect(f.urls).toEqual([CORTO]);
  });

  it('un link YA largo no gasta una petición', async () => {
    // No hay nada que expandir: pedirlo sería una llamada de red regalada, y
    // encima con el cliente esperando.
    const f = fakeFetch([]);
    const res = await expandMapsLink(LARGO, { fetchImpl: f.fn });

    expect(res).toBe(LARGO);
    expect(f.urls).toEqual([]);
  });

  it('NO sigue un redirect que se sale de Google', async () => {
    // La defensa que importa: el primer salto lo controla la respuesta de un
    // tercero, así que la allowlist se revisa en CADA salto y no solo al
    // principio. Sin esto, un redirect bastaría para apuntar nuestra petición
    // a donde quisiera quien mandó el mensaje.
    const f = fakeFetch(['https://evil.example.com/algo']);
    const res = await expandMapsLink(CORTO, { fetchImpl: f.fn });

    expect(res).toBeNull();
    expect(f.urls).toEqual([CORTO]); // no hubo segunda petición
  });

  it('tampoco a un dominio que solo PARECE Google', async () => {
    const f = fakeFetch(['https://google.com.atacante.net/maps/@-17.8,-63.1,17z']);
    expect(await expandMapsLink(CORTO, { fetchImpl: f.fn })).toBeNull();
  });

  it('un host que no está en la allowlist ni se intenta', async () => {
    const f = fakeFetch([LARGO]);
    const res = await expandMapsLink('https://evil.com/maps/abc', { fetchImpl: f.fn });

    expect(res).toBeNull();
    expect(f.urls).toEqual([]);
  });

  it('corta a los dos saltos en vez de perseguir una cadena', async () => {
    const otroCorto = 'https://maps.app.goo.gl/otro';
    const f = fakeFetch([otroCorto, otroCorto, otroCorto]);

    expect(await expandMapsLink(CORTO, { fetchImpl: f.fn })).toBeNull();
    expect(f.urls).toHaveLength(2);
  });

  it('sin cabecera Location no se inventa nada', async () => {
    const f = fakeFetch([null]);
    expect(await expandMapsLink(CORTO, { fetchImpl: f.fn })).toBeNull();
  });

  it('un fallo de red devuelve null, nunca lanza', async () => {
    // Esto corre dentro del webhook: una excepción aquí tumbaría la entrega
    // entera por un link que no se pudo resolver.
    const fn = (async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;

    await expect(expandMapsLink(CORTO, { fetchImpl: fn })).resolves.toBeNull();
  });

  it('el timeout aborta en vez de colgar al cliente', async () => {
    const fn = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as unknown as typeof fetch;

    await expect(
      expandMapsLink(CORTO, { fetchImpl: fn, timeoutMs: 10 }),
    ).resolves.toBeNull();
  });

  it('pide redirect manual: el runtime no sigue nada por su cuenta', async () => {
    let init: RequestInit | undefined;
    const fn = (async (_u: string | URL | Request, i?: RequestInit) => {
      init = i;
      return {
        headers: { get: () => LARGO },
      } as unknown as Response;
    }) as unknown as typeof fetch;

    await expandMapsLink(CORTO, { fetchImpl: fn });
    expect(init?.redirect).toBe('manual');
  });
});
