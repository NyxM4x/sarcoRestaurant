import 'server-only';
import { log } from '@/lib/log';
import { isGoogleMapsUrl, isShortMapsLink } from './maps-link';

/**
 * Expansión de un link corto de Google Maps (0029) — la única parte con red.
 *
 * `maps.app.goo.gl/5biYBaWPiPGPPcyB9` no lleva coordenadas dentro: es un
 * identificador. Google las devuelve en la cabecera `Location` de un 302, con
 * el cuerpo vacío (`Content-Length: 0`), así que esto no descarga ninguna
 * página — lee una cabecera y corta.
 *
 * ── La URL la escribe el cliente ────────────────────────────────────────────
 *
 * Eso es lo que decide el diseño. Un mensaje de WhatsApp puede traer cualquier
 * cosa, y esto la convierte en una petición saliente desde nuestro servidor.
 * Las defensas, todas juntas y ninguna suficiente sola:
 *
 *   1. ALLOWLIST de dominios, exacta, comprobada ANTES de la primera petición y
 *      OTRA VEZ en cada salto. Un redirect que sale de Google no se sigue.
 *   2. `redirect: 'manual'` — el runtime no sigue nada por su cuenta; cada
 *      salto se inspecciona aquí.
 *   3. Máximo dos saltos. En la práctica es uno.
 *   4. Timeout corto: esto corre dentro del webhook, y un cliente esperando su
 *      cotización no puede quedarse colgado de la red de un tercero.
 *   5. Solo se lee la cabecera. El cuerpo nunca se toca.
 *
 * Nunca lanza: si algo falla, devuelve `null` y quien llama le pide el pin
 * normal. Un link que no se pudo resolver es una molestia; una excepción aquí
 * tumbaría la entrega entera.
 */

/** Un link corto se resuelve en un salto; dos es margen, no expectativa. */
const MAX_SALTOS = 2;

/** El cliente está esperando: esto no puede colgar el webhook. */
const EXPAND_TIMEOUT_MS = 3000;

export interface ExpandMapsLinkDeps {
  /** Inyectable para tests; por defecto el `fetch` global. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Devuelve la URL larga de un link de Maps, o `null` si no se pudo.
 *
 * Un link que YA es largo se devuelve tal cual: no hay nada que expandir y
 * pedirlo sería una llamada de red regalada.
 */
export async function expandMapsLink(
  raw: string,
  deps: ExpandMapsLinkDeps = {},
): Promise<string | null> {
  if (!isGoogleMapsUrl(raw)) return null;
  if (!isShortMapsLink(raw)) return raw;

  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? EXPAND_TIMEOUT_MS;

  let actual = raw;

  for (let salto = 0; salto < MAX_SALTOS; salto += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetchImpl(actual, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
      });

      const location = res.headers.get('location');
      if (!location) {
        // Sin redirect: o ya era la final, o Google contestó otra cosa. Si la
        // que tenemos en la mano ya no es corta, sirve.
        return isShortMapsLink(actual) ? null : actual;
      }

      // `location` puede ser relativa; se resuelve contra la actual.
      const siguiente = new URL(location, actual).toString();

      // La allowlist se revisa EN CADA SALTO. Comprobarla solo al principio
      // dejaría que el primer redirect nos llevara a cualquier sitio.
      if (!isGoogleMapsUrl(siguiente)) {
        log.warn('maps_link_redirect_off_allowlist');
        return null;
      }

      actual = siguiente;
      if (!isShortMapsLink(actual)) return actual;
    } catch {
      // Timeout, red caída o URL imposible de resolver.
      log.warn('maps_link_expand_failed');
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  // Se acabaron los saltos y sigue siendo corta: no se insiste.
  log.warn('maps_link_too_many_redirects');
  return null;
}
