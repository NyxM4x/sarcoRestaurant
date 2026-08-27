import 'server-only';
import { getServerEnv } from '@/lib/env/env';
import { log } from '@/lib/log';
import { isSupportedImageMime, type ImageAttachment } from './channel/image';
import { checkMediaUrl, shouldSendKapsoKey } from './media-url-policy';
import {
  imageIsProcessable,
  transientCandidates,
  MEDIA_MAX_BYTES,
  MEDIA_TIMEOUT_MS,
  type MediaResolverPort,
  type MediaSource,
  type ResolveImageOptions,
  type ResolveImageResult,
} from '@/lib/agent/core/media';

/**
 * RESOLUTOR DE MEDIA de Kapso — server-only (Fase 6D.2F.5C.5).
 *
 * Convierte el adjunto de una imagen en algo que el modelo pueda mirar: la
 * descarga y devuelve un data URL.
 *
 * ── Por qué se descarga en vez de pasar la URL ──────────────────────────────
 *
 * Las URLs del payload (`kapso.media_url`, `image.link`, `image.url`) son
 * credenciales de acceso al contenido del cliente. Pasárselas a OpenAI sería
 * entregarle a un tercero una llave a la foto de alguien, con la vida que le
 * quede. Y la de Kapso probablemente ni siquiera le serviría —parece exigir
 * NUESTRA clave—, con lo que un 401 del proveedor parecería un fallo del modelo.
 *
 * ── El destino lo elige un webhook: hay política de URL ─────────────────────
 *
 * `fetch` server-side hacia una URL que vino en un payload es la forma exacta de
 * un SSRF. Cada salto —el inicial y CADA redirect— pasa por `checkMediaUrl`:
 * HTTPS, sin credenciales embebidas, puerto 443 y hostname en una lista blanca
 * corta, sacada de payloads reales. Ver `media-url-policy.ts`.
 *
 * El redirect NO es un caso raro aquí: es el camino normal. `app.kapso.ai` sirve
 * los adjuntos por ActiveStorage y devuelve un 302 a su bucket, así que la
 * descarga que funciona son SIEMPRE dos saltos.
 *
 * Los redirects se siguen A MANO por eso mismo: `redirect: 'follow'` valida el
 * primer host y luego obedece a donde le manden, que es justo el agujero. Con
 * `manual` el destino de cada salto se vuelve a juzgar, y la cabecera de
 * autenticación se recalcula por salto para no arrastrar nuestra clave de Kapso
 * hasta un dominio de Meta.
 *
 * ── Fail closed en todos los bordes ─────────────────────────────────────────
 *
 * URL bloqueada, MIME fuera de la lista blanca, tamaño por encima del tope
 * —declarado o real—, timeout, demasiados saltos, o cualquier respuesta que no
 * sea 200: se devuelve un error tipado y NADIE inventa que vio la imagen. El
 * turno sigue con lo que tenga.
 *
 * ── Lo que NO hace ──────────────────────────────────────────────────────────
 *
 * No guarda nada, no cachea y no persiste el data URL. La imagen vive lo que
 * dura el turno, que es lo mismo que duran sus URLs.
 *
 * Resolver una URL FRESCA por `media_id` queda como dependencia inyectable y sin
 * implementar: el endpoint de Kapso para eso no está confirmado por
 * documentación que hayamos verificado, y escribir una llamada a un endpoint
 * adivinado fallaría en producción con un error que parecería de otra cosa.
 * Mientras no se confirme, agotadas las referencias transitorias se devuelve
 * `unavailable` — que es la verdad.
 */

/** Saltos máximos. Dos bastan para un CDN; tres deja margen sin abrir un bucle. */
const MEDIA_MAX_REDIRECTS = 3;

/** Familia del status, para poder informar sin registrar el cuerpo ni la URL. */
function statusClass(status: number): string {
  return `${Math.floor(status / 100)}xx`;
}

/**
 * Descarga con política de URL, timeout compartido y tope de tamaño.
 * Nunca lanza: devuelve el desenlace.
 *
 * El `AbortController` es UNO para toda la cadena de redirects a propósito: el
 * presupuesto es del intento, no de cada salto, y si no tres redirects lentos
 * multiplicarían el timeout que se acaba de acotar.
 */
async function descargar(
  urlInicial: string,
  source: MediaSource,
  apiKey: string | null,
  mimeDeclarado: string | null,
  timeoutMs: number,
): Promise<ResolveImageResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let url = urlInicial;

    for (let salto = 0; salto <= MEDIA_MAX_REDIRECTS; salto += 1) {
      // ── LA PUERTA. Se cruza en cada salto, no solo en el primero ───────────
      const permitida = checkMediaUrl(url);
      if (!permitida.ok) {
        // Hostname y motivo, nunca la URL: ahí viven la ruta y el token. Es lo
        // que hace falta para enterarse de que el proveedor cambió de dominio.
        log.warn('agent_media_url_blocked', {
          source,
          reason: permitida.reason,
          host: permitida.hostname,
          redirect_hop: salto,
        });
        return { ok: false, error: 'blocked_url' };
      }

      // La clave se decide POR SALTO: un redirect a Meta no la lleva.
      const headers: Record<string, string> = {};
      if (apiKey !== null && shouldSendKapsoKey(permitida.hostname)) {
        headers['X-API-Key'] = apiKey;
      }

      const res = await fetch(url, {
        headers,
        signal: controller.signal,
        // Manual: el destino de un redirect es otra URL elegida desde fuera, y
        // tiene que volver a pasar por la puerta.
        redirect: 'manual',
      });

      if (res.status >= 300 && res.status < 400) {
        const destino = res.headers.get('location');
        if (destino === null) return { ok: false, error: 'unavailable' };
        // `location` puede ser relativo; se resuelve contra el salto actual.
        try {
          url = new URL(destino, url).toString();
        } catch {
          return { ok: false, error: 'blocked_url' };
        }
        continue;
      }

      if (!res.ok) {
        log.warn('agent_media_fetch_failed', {
          source,
          host: permitida.hostname,
          status_class: statusClass(res.status),
        });
        return { ok: false, error: 'unavailable' };
      }

      // El tipo REAL manda sobre el declarado: es lo que de verdad se va a mandar
      // al modelo. Si el servidor dice otra cosa, se comprueba otra vez.
      const mimeReal = res.headers.get('content-type');
      const mimeType = (mimeReal ?? mimeDeclarado ?? '').split(';')[0].trim().toLowerCase();
      if (!isSupportedImageMime(mimeType)) return { ok: false, error: 'unsupported_mime' };

      // Corte por cabecera antes de leer el cuerpo, cuando el servidor la manda.
      const declarado = Number(res.headers.get('content-length') ?? '');
      if (Number.isFinite(declarado) && declarado > MEDIA_MAX_BYTES) {
        return { ok: false, error: 'too_large' };
      }

      const buffer = await res.arrayBuffer();
      // Y otra vez con el tamaño real: `content-length` puede faltar o mentir.
      if (buffer.byteLength > MEDIA_MAX_BYTES) return { ok: false, error: 'too_large' };
      if (buffer.byteLength === 0) return { ok: false, error: 'unavailable' };

      const base64 = Buffer.from(buffer).toString('base64');
      return {
        ok: true,
        dataUrl: `data:${mimeType};base64,${base64}`,
        source,
        byteSize: buffer.byteLength,
        mimeType,
      };
    }

    // Se agotaron los saltos sin llegar a un cuerpo.
    log.warn('agent_media_redirect_limit', { source });
    return { ok: false, error: 'unavailable' };
  } catch (error) {
    // `AbortError` es el timeout; el resto, red. Ningún mensaje del error viaja
    // hacia arriba: podría contener la URL.
    const abortado = error instanceof Error && error.name === 'AbortError';
    return { ok: false, error: abortado ? 'timeout' : 'unavailable' };
  } finally {
    clearTimeout(timer);
  }
}

export function createKapsoMediaResolver(): MediaResolverPort {
  return {
    async resolveImage(
      attachment: ImageAttachment,
      phoneNumberId: string | null,
      options?: ResolveImageOptions,
    ): Promise<ResolveImageResult> {
      // `phoneNumberId` es parte del contrato del puerto porque Kapso lo exige
      // para resolver una URL fresca a partir de `media_id`. Ese camino no está
      // implementado (ver la cabecera), así que hoy no se usa — pero el puerto
      // ya lo recibe, y por eso añadirlo no será un cambio de firma.
      void phoneNumberId;

      // Se juzga con lo que el propio mensaje declara ANTES de tocar la red: un
      // SVG o un archivo de 40 MB se rechazan sin gastar una petición.
      const admisible = imageIsProcessable(attachment);
      if (!admisible.ok) return admisible;

      const env = getServerEnv();
      const apiKey = env.KAPSO_API_KEY ?? null;

      const candidatos = transientCandidates(attachment);
      if (candidatos.length === 0) return { ok: false, error: 'unavailable' };

      // El presupuesto del turno ya recortó esto; el techo individual sigue
      // valiendo por si nadie lo pasó.
      const timeoutMs = options?.timeoutMs ?? MEDIA_TIMEOUT_MS;
      if (timeoutMs <= 0) return { ok: false, error: 'timeout' };

      // Se intentan en orden. El primero que sirva gana; si uno falla se prueba
      // el siguiente, porque caducan de forma independiente.
      let ultimo: ResolveImageResult = { ok: false, error: 'unavailable' };
      for (const candidato of candidatos) {
        ultimo = await descargar(
          candidato.url,
          candidato.source,
          apiKey,
          attachment.facts.mimeType,
          timeoutMs,
        );
        if (ultimo.ok) return ultimo;
        // Estos tres no mejoran cambiando de URL: el archivo es el mismo y el
        // reloj es el del intento entero.
        if (
          ultimo.error === 'unsupported_mime' ||
          ultimo.error === 'too_large' ||
          ultimo.error === 'timeout'
        ) {
          return ultimo;
        }
      }
      return ultimo;
    },
  };
}
