import type { Coords } from './quote-request';

/**
 * Ubicación compartida como LINK de Google Maps, o escrita como coordenadas —
 * módulo puro (0029).
 *
 * ── El caso ─────────────────────────────────────────────────────────────────
 *
 * No todo el mundo manda su ubicación con el pin de WhatsApp. Mucha gente abre
 * Google Maps, busca su casa y le da a "compartir": lo que llega al chat es un
 * texto con un link corto. Para el cliente es exactamente el mismo gesto —"aquí
 * vivo"—, pero llega como `type: 'text'`, así que ni el parser de ubicación lo
 * ve ni el detector de "¿cuánto sale el envío?" lo reconoce, y termina en el
 * modelo, que contesta pidiéndole la ubicación que acaba de mandar.
 *
 * ── El link corto no tiene coordenadas ──────────────────────────────────────
 *
 * `maps.app.goo.gl/5biYBaWPiPGPPcyB9` es un identificador opaco: por dentro no
 * hay latitud ni longitud. Hay que pedirle a Google que lo expanda (un 302, ver
 * `maps-link-service.ts`) y trabajar sobre la URL larga. Este módulo es el que
 * sabe leerla; la petición vive fuera, para poder probar esto sin red.
 *
 * ── Y la URL larga trae TRES pares que no significan lo mismo ───────────────
 *
 * Medido sobre un link real del negocio (01-09-2026):
 *
 *   .../place/17°50'34.7"S+63°10'44.9"W/@-17.8429809,-63.1817199,17z/
 *      data=!3m1!4b1!4m4!3m3!8m2!3d-17.8429809!4d-63.179145!18m1!1e1
 *
 *   · `!3d!4d`  → -17.8429809, -63.179145   el LUGAR marcado
 *   · DMS       → -17.8429722, -63.1791389  el mismo lugar, ~1 m de diferencia
 *   · `@`       → -17.8429809, -63.1817199  el centro de la CÁMARA
 *
 * El `@` estaba **272 metros** al oeste de los otros dos. No es un empate ni un
 * redondeo: es la vista del mapa, y cambia según dónde tuviera el cliente la
 * pantalla al compartir. Es además el par más visible en la barra del navegador
 * y por eso el más fácil de agarrar por error — tres cuadras de error, con el
 * repartidor dando vueltas y el cliente esperando.
 *
 * De ahí el orden de abajo, que es lo único que de verdad importa de este
 * archivo: el `@` es el ÚLTIMO recurso, no el primer hallazgo.
 */

/**
 * Dominios cuyos links se aceptan. Allowlist cerrada, y no una lista de
 * bloqueo: esta URL la escribe el cliente, y lo que se hace con ella después es
 * una petición saliente desde nuestro servidor.
 */
const GOOGLE_MAPS_HOSTS: readonly string[] = [
  'maps.app.goo.gl',
  'goo.gl',
  'maps.google.com',
  'www.google.com',
  'google.com',
];

/** URLs dentro de esos dominios que sí son una ubicación. */
const MAPS_PATHS = /^\/(maps|maps\/|url)/;

/** Cualquier http(s) del texto; el filtro real es el host. */
const URL_EN_TEXTO = /https?:\/\/[^\s<>"']+/gi;

function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/** ¿Este host es uno de los nuestros? Compara el host COMPLETO, nunca sufijos. */
function isGoogleMapsHost(host: string): boolean {
  const limpio = host.toLowerCase();
  // `.includes()` o un `endsWith('google.com')` aceptarían
  // `google.com.atacante.net`. La comparación es exacta contra la lista.
  return GOOGLE_MAPS_HOSTS.includes(limpio);
}

/**
 * ¿Es un link de ubicación de Google Maps?
 *
 * `maps.app.goo.gl` y `goo.gl` sirven links cortos con la ruta como código, así
 * que ahí no se puede exigir `/maps`. En los dominios largos sí.
 */
export function isGoogleMapsUrl(raw: string): boolean {
  const url = parseUrl(raw);
  if (!url) return false;
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  if (!isGoogleMapsHost(url.hostname)) return false;

  const corto = url.hostname === 'maps.app.goo.gl' || url.hostname === 'goo.gl';
  if (corto) return url.pathname.length > 1;

  // `maps.google.com` ya es el dominio de mapas: ahí la ruta puede ser `/` y el
  // dato viaja en la query (`?q=`). Exigirle `/maps` dejaría fuera el formato
  // más viejo y más corto que existe.
  if (url.hostname === 'maps.google.com') return true;

  return MAPS_PATHS.test(url.pathname);
}

/** El primer link de Google Maps del mensaje, o `null`. */
export function findMapsLink(text: string | null | undefined): string | null {
  if (!text) return null;
  const encontrados = text.match(URL_EN_TEXTO);
  if (!encontrados) return null;

  for (const bruto of encontrados) {
    // La puntuación de la frase se pega al final del link: "mi casa es
    // https://maps.app.goo.gl/abc." — ese punto no es parte de la URL.
    const limpio = bruto.replace(/[.,;:)\]}>"']+$/, '');
    if (isGoogleMapsUrl(limpio)) return limpio;
  }
  return null;
}

/** ¿Hace falta expandirlo antes de poder leer nada? */
export function isShortMapsLink(raw: string): boolean {
  const url = parseUrl(raw);
  if (!url) return false;
  return url.hostname === 'maps.app.goo.gl' || url.hostname === 'goo.gl';
}

// ── Lectura de coordenadas ──────────────────────────────────────────────────

function enRango(lat: number, lng: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
}

function coords(lat: number, lng: number): Coords | null {
  return enRango(lat, lng) ? { lat, lng } : null;
}

/** `17°50'34.7"S` → -17.84297222 */
function dmsToDecimal(deg: string, min: string, sec: string, hemi: string): number {
  const valor = Number(deg) + Number(min) / 60 + Number(sec) / 3600;
  return hemi === 'S' || hemi === 'W' ? -valor : valor;
}

function decode(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    // Un `%` suelto rompe el decodificado; el resto de extractores no lo
    // necesitan, así que se sigue con la cadena tal cual.
    return raw;
  }
}

/** El par del LUGAR, dentro de `data=`: `!3d<lat>!4d<lng>`. */
function fromDataBlock(url: string): Coords | null {
  const m = /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/.exec(url);
  return m ? coords(Number(m[1]), Number(m[2])) : null;
}

/** `?q=<lat>,<lng>` y `?query=<lat>,<lng>` — coordenadas explícitas. */
function fromQueryParam(url: URL): Coords | null {
  for (const clave of ['q', 'query', 'destination', 'll', 'center']) {
    const valor = url.searchParams.get(clave);
    if (!valor) continue;
    const m = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(valor);
    if (m) {
      const c = coords(Number(m[1]), Number(m[2]));
      if (c) return c;
    }
  }
  return null;
}

/** El DMS del path: `/place/17°50'34.7"S+63°10'44.9"W/`. */
function fromDms(url: string): Coords | null {
  const texto = decode(url);
  const re = /(\d+)°(\d+)'([\d.]+)"([NSEW])/g;
  const encontrados = [...texto.matchAll(re)];
  if (encontrados.length < 2) return null;

  const [a, b] = encontrados;
  const uno = dmsToDecimal(a[1], a[2], a[3], a[4]);
  const dos = dmsToDecimal(b[1], b[2], b[3], b[4]);

  // El orden lo dicta el hemisferio, no la posición: N/S es latitud.
  const esLat = (h: string) => h === 'N' || h === 'S';
  if (esLat(a[4]) && !esLat(b[4])) return coords(uno, dos);
  if (!esLat(a[4]) && esLat(b[4])) return coords(dos, uno);
  return null;
}

/** El centro de la CÁMARA: `@<lat>,<lng>,<zoom>z`. Último recurso. */
function fromCamera(url: string): Coords | null {
  const m = /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/.exec(url);
  return m ? coords(Number(m[1]), Number(m[2])) : null;
}

/** De dónde salieron las coordenadas. Para el log: no todas valen lo mismo. */
export type CoordsSource = 'query' | 'place' | 'dms' | 'camera' | 'text';

export interface ExtractedCoords {
  coords: Coords;
  source: CoordsSource;
}

/**
 * Coordenadas de una URL de Google Maps YA EXPANDIDA.
 *
 * El orden es la parte importante, y está medido (ver la cabecera): primero lo
 * que Google marca como el lugar, y el centro de la cámara solo cuando no hay
 * nada más. Un link de RUTA (`/dir/`) no se lee: eso no es "aquí vivo", son dos
 * puntos y un trayecto, y adivinar cuál de los dos es la casa sería inventar.
 */
export function extractCoordsFromMapsUrl(raw: string): ExtractedCoords | null {
  const url = parseUrl(raw);
  if (!url) return null;
  if (!isGoogleMapsHost(url.hostname)) return null;
  if (/\/dir\//.test(url.pathname)) return null;

  const porQuery = fromQueryParam(url);
  if (porQuery) return { coords: porQuery, source: 'query' };

  const porLugar = fromDataBlock(raw);
  if (porLugar) return { coords: porLugar, source: 'place' };

  const porDms = fromDms(raw);
  if (porDms) return { coords: porDms, source: 'dms' };

  const porCamara = fromCamera(raw);
  if (porCamara) return { coords: porCamara, source: 'camera' };

  return null;
}

// ── Coordenadas escritas a mano ─────────────────────────────────────────────

/**
 * Coordenadas pegadas en el mensaje, sin ningún link.
 *
 * Sale gratis y sin red: es leer dos números. Cubre lo que copia y pega quien
 * abre el pin en Maps ("Lat: -17.842973, Long: -63.179229") y a quien manda el
 * par pelado.
 *
 * Exige DECIMALES en los dos números a propósito. Sin esa exigencia, "pedime 2,
 * 3 hamburguesas" sería un par de coordenadas perfectamente válido frente al
 * ecuador, y el cliente recibiría una tarifa de envío en vez de su pedido.
 */
export function parsePlainCoords(text: string | null | undefined): Coords | null {
  if (!text) return null;

  const re =
    /(?:lat(?:itud[e]?)?\s*[:=]?\s*)?(-?\d{1,3}\.\d+)\s*[,;]?\s*(?:lon(?:g(?:itud[e]?)?)?\s*[:=]?\s*)?(-?\d{1,3}\.\d+)/i;
  const m = re.exec(text);
  if (!m) return null;

  return coords(Number(m[1]), Number(m[2]));
}
