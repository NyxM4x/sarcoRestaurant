import { isSupportedImageMime } from '@/lib/kapso/channel/image';
import type { ImageAttachment } from '@/lib/kapso/channel/image';

/**
 * PUERTO DE MEDIA — módulo puro (Fase 6D.2F.5C.5).
 *
 * Agent Core no descarga nada ni conoce Kapso: pide una imagen por esta
 * interfaz y recibe algo que el modelo pueda mirar. El adaptador real vive en
 * `@/lib/kapso/media-resolver` y en pruebas se inyecta un doble.
 *
 * ── Por qué el resultado es un data URL y no una URL ────────────────────────
 *
 * Porque mandarle a OpenAI la URL de Kapso significaría entregarle a un tercero
 * una credencial de acceso al contenido del cliente, con la vida que le quede.
 * Descargando aquí, lo que sale de nuestro perímetro es la imagen concreta que
 * decidimos mandar, y nada más. También evita el fallo silencioso de que el
 * proveedor no pueda autenticarse contra una URL que sí requiere nuestra clave.
 *
 * ── Por qué NO se guarda el resultado ───────────────────────────────────────
 *
 * Un data URL es la foto entera. Persistirlo convertiría `agent_messages` en un
 * almacén de imágenes por la puerta de atrás, sin haber decidido retención,
 * coste ni acceso. La memoria visual durable es una decisión aparte (§9), y
 * mientras no se tome, la imagen vive lo que dura el turno.
 */

/** Tope de descarga POR IMAGEN. Una foto de WhatsApp real ronda decenas de KB. */
export const MEDIA_MAX_BYTES = 8 * 1024 * 1024;
/** Timeout de red de UNA descarga. */
export const MEDIA_TIMEOUT_MS = 8_000;

/**
 * PRESUPUESTO DEL TURNO (endurecimiento pre-push de 5C.5).
 *
 * El tope por imagen no basta. Un lote admite hasta 10 mensajes, y diez fotos de
 * 8 MB serían 80 MB descargados… que en base64 son ~107 MB de cadena, además del
 * buffer, dentro de una función serverless. Y en tiempo: diez descargas
 * secuenciales de 8 s son 80 s de procesamiento asíncrono por un solo turno.
 *
 * Así que hay tres límites, y los tres son necesarios porque miden cosas
 * distintas: cuántas, cuánto pesan en total y cuánto se puede tardar en
 * conseguirlas.
 *
 * Los valores son deliberadamente conservadores:
 *
 *   · 3 imágenes — mandar tres fotos seguidas es un caso real (el mismo plato
 *     desde varios ángulos); mandar diez es un lote que no se está pidiendo
 *     interpretar de una vez.
 *   · 12 MB en total — con fotos reales de decenas de KB no se roza nunca, y
 *     acota la memoria del proceso aunque las tres vengan al máximo por imagen.
 *   · 12 s para el conjunto — cabe una descarga lenta entera (8 s) más otra
 *     rápida, y el turno sigue lejos del límite de la invocación.
 *
 * NO se exponen por entorno: una variable que nadie ha necesitado ajustar todavía
 * es una variable que se puede configurar mal en Production sin que ningún test
 * lo note. El día que haga falta moverlos, se mueven aquí y se despliega.
 */
export interface TurnMediaLimits {
  /** Cuántas imágenes se INTENTAN resolver en un turno. */
  maxImages: number;
  /** Suma de bytes de todas las imágenes del turno. */
  maxTotalBytes: number;
  /** Tiempo total para resolver el CONJUNTO, no cada una. */
  maxTotalMs: number;
  /** Techo por descarga individual. Nunca se supera aunque quede presupuesto. */
  maxPerImageMs: number;
}

export const DEFAULT_TURN_MEDIA_LIMITS: TurnMediaLimits = {
  maxImages: 3,
  maxTotalBytes: 12 * 1024 * 1024,
  maxTotalMs: 12_000,
  maxPerImageMs: MEDIA_TIMEOUT_MS,
};

export type MediaResolveError =
  /** El MIME no está en la lista blanca de imágenes. */
  | 'unsupported_mime'
  /** Supera `MEDIA_MAX_BYTES`, declarado o real. */
  | 'too_large'
  | 'timeout'
  /** No hay ninguna referencia utilizable, o el origen respondió mal. */
  | 'unavailable'
  /** Falta configuración para poder descargar. Nunca se intentó la red. */
  | 'not_configured'
  /** La URL no pasó la política de host/protocolo. Nunca se tocó la red. */
  | 'blocked_url'
  /** El turno ya alcanzó su cupo de imágenes. */
  | 'too_many_images'
  /** Entraría por encima del total de bytes del turno. */
  | 'turn_bytes_exceeded'
  /** Se agotó el tiempo del CONJUNTO antes de llegar a esta imagen. */
  | 'turn_budget_exhausted';

export type MediaSource = 'transient_kapso' | 'transient_link' | 'transient_meta' | 'media_id';

export type ResolveImageResult =
  | {
      ok: true;
      /** `data:<mime>;base64,<...>` listo para `input_image`. NUNCA se persiste. */
      dataUrl: string;
      source: MediaSource;
      byteSize: number;
      mimeType: string;
    }
  | { ok: false; error: MediaResolveError };

export interface ResolveImageOptions {
  /**
   * Techo de tiempo para ESTA descarga, ya recortado por lo que quede del
   * presupuesto del turno. Ausente = `MEDIA_TIMEOUT_MS`.
   */
  timeoutMs?: number;
}

export interface MediaResolverPort {
  resolveImage(
    attachment: ImageAttachment,
    phoneNumberId: string | null,
    options?: ResolveImageOptions,
  ): Promise<ResolveImageResult>;
}

/**
 * Contable del presupuesto de un turno. Se crea uno por turno y decide, imagen a
 * imagen y ANTES de tocar la red, si hay sitio.
 *
 * FAIL CLOSED: cuando no hay sitio, la imagen NO se descarga y devuelve un error
 * tipado. No se intenta "cargar todas igualmente" ni se recorta la foto: lo que
 * no cabe no se mira, y el turno se entera de que no lo miró.
 *
 * El orden se preserva solo, porque las decisiones se toman recorriendo el burst
 * de principio a fin: las que entran son las PRIMERAS, en su posición original.
 *
 * El reloj se inyecta —y en el turno es el MISMO `deps.now` que fecha el run—
 * para que el presupuesto sea comprobable sin esperar de verdad.
 */
export interface TurnMediaBudget {
  /** ¿Cabe esta imagen? Devuelve el timeout que le corresponde si sí. */
  admit(
    declaredBytes: number | null,
  ): { ok: true; timeoutMs: number } | { ok: false; error: MediaResolveError };
  /**
   * Apunta los bytes REALES de una descarga ya hecha. Puede rechazarla a
   * posteriori: `content-length` puede faltar o mentir, y el total del turno se
   * mide con lo que de verdad llegó.
   */
  account(byteSize: number): { ok: true } | { ok: false; error: MediaResolveError };
  /** Bytes acumulados que SÍ viajan al modelo. Para la observabilidad del turno. */
  totalBytes(): number;
}

export function createTurnMediaBudget(options?: {
  limits?: TurnMediaLimits;
  now?: () => number;
}): TurnMediaBudget {
  const limits = options?.limits ?? DEFAULT_TURN_MEDIA_LIMITS;
  const now = options?.now ?? (() => Date.now());
  const deadline = now() + limits.maxTotalMs;

  /** Intentos consumidos, no éxitos: un fallo también gastó tiempo y una plaza. */
  let intentos = 0;
  let bytes = 0;

  return {
    admit(declaredBytes) {
      if (intentos >= limits.maxImages) return { ok: false, error: 'too_many_images' };
      // Con el tamaño declarado se puede rechazar SIN gastar la petición. Si no
      // viene, se deja pasar y lo corta `account` con los bytes reales.
      if (declaredBytes !== null && bytes + declaredBytes > limits.maxTotalBytes) {
        return { ok: false, error: 'turn_bytes_exceeded' };
      }
      const restante = deadline - now();
      if (restante <= 0) return { ok: false, error: 'turn_budget_exhausted' };

      intentos += 1;
      // Lo que quede del turno, nunca más que el techo individual.
      return { ok: true, timeoutMs: Math.min(limits.maxPerImageMs, restante) };
    },
    account(byteSize) {
      if (bytes + byteSize > limits.maxTotalBytes) {
        // Descargada pero descartada: es el precio de que el servidor mintiera
        // sobre el tamaño, y sigue siendo mejor que mandarla.
        return { ok: false, error: 'turn_bytes_exceeded' };
      }
      bytes += byteSize;
      return { ok: true };
    },
    totalBytes: () => bytes,
  };
}

/**
 * ¿Merece la pena intentar descargar esto?
 *
 * Se comprueba ANTES de tocar la red, con lo que el propio mensaje declara. Un
 * `image/svg+xml` o un archivo de 40 MB se rechazan sin gastar una petición, y
 * —más importante— sin que el fallo dependa de que el servidor remoto se porte
 * bien.
 *
 * Fail closed: si el MIME no consta, NO se descarga. Adivinar el tipo de un
 * binario que va a viajar a un modelo multimodal es justo lo que no queremos.
 */
export function imageIsProcessable(
  attachment: ImageAttachment,
): { ok: true } | { ok: false; error: MediaResolveError } {
  if (!isSupportedImageMime(attachment.facts.mimeType)) {
    return { ok: false, error: 'unsupported_mime' };
  }
  if (attachment.facts.byteSize !== null && attachment.facts.byteSize > MEDIA_MAX_BYTES) {
    return { ok: false, error: 'too_large' };
  }
  return { ok: true };
}

/**
 * Orden de preferencia de las referencias transitorias.
 *
 * `kapso.media_url` primero porque es la que el proveedor documenta como
 * disponible de inmediato para media entrante; `image.link` es la misma
 * familia; el lookaside de Meta va último porque es el que menos control nos da.
 *
 * Devuelve pares (url, origen) para que la observabilidad pueda decir POR DÓNDE
 * se obtuvo sin registrar jamás la URL.
 */
export function transientCandidates(
  attachment: ImageAttachment,
): readonly { url: string; source: MediaSource }[] {
  const out: { url: string; source: MediaSource }[] = [];
  const { kapsoMediaUrl, link, metaUrl } = attachment.transient;
  if (kapsoMediaUrl !== null) out.push({ url: kapsoMediaUrl, source: 'transient_kapso' });
  if (link !== null && link !== kapsoMediaUrl) out.push({ url: link, source: 'transient_link' });
  if (metaUrl !== null) out.push({ url: metaUrl, source: 'transient_meta' });
  return out;
}
