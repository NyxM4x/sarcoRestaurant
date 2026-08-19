/**
 * IMÁGENES DE WHATSAPP — parseo PURO (Fase 6D.2F.5C.5).
 *
 * Contrato OBSERVADO en Production el 18-08-2026, no documentación:
 *
 *   message.type = 'image'
 *   message.id   = WAMID propio
 *   message.image = { id, url, link, sha256, mime_type, caption? }
 *   message.kapso = { has_media, media_url, media_data: { url, filename,
 *                     byte_size, content_type }, message_type_data: { caption } }
 *
 * ── Lo durable y lo transitorio, que NO son lo mismo ────────────────────────
 *
 * De todo eso, solo una parte es un HECHO sobre el mensaje: el identificador de
 * media, el hash, el tipo y el tamaño. Las URLs —`image.url` (lookaside de
 * Meta), `image.link` y `kapso.media_url`— son credenciales de acceso temporal
 * al contenido de un cliente. Caducan, y mientras no caducan sirven para
 * descargar una foto de alguien.
 *
 * Por eso este módulo las separa en dos sitios distintos y con nombres
 * distintos: `media` es lo que se persiste, `transient` es lo que solo vale
 * DURANTE el procesamiento de este evento. Nada de `transient` puede acabar en
 * `agent_messages`, en un log ni en un informe.
 *
 * ── El caption sale de `image.caption`, nunca de `kapso.content` ────────────
 *
 * `kapso.content` trae una frase compuesta por el proveedor que MEZCLA el
 * caption real del cliente con filename, tamaño, MIME y URL:
 *
 *     "Que hamburguesa es esta? Image attached (...) URL: ..."
 *
 * Sacar el caption de ahí exigiría recortar una frase cuyo formato no
 * controlamos, y el premio por equivocarse es meter una URL con acceso al
 * contenido del cliente dentro de `agent_messages.content` — y de ahí al
 * contexto del modelo. La estructura ya trae el dato limpio.
 *
 * `kapso.message_type_data.caption` se admite como respaldo ESTRUCTURAL, y solo
 * si trae algo: en la foto sin caption llegó como `""`, así que una cadena vacía
 * no es un caption, es su ausencia.
 */

/** `message.type` de una imagen. */
export const KAPSO_MESSAGE_TYPE_IMAGE = 'image';

/**
 * MIME aceptados. Lista blanca: lo que no está aquí no se descarga ni se manda
 * al modelo. Un `image/svg+xml` no es una foto, es un documento ejecutable.
 */
export const SUPPORTED_IMAGE_MIME_TYPES: readonly string[] = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
];

/** Datos DURABLES de la media. Es lo único que se persiste. */
export interface ImageMediaFacts {
  mediaId: string | null;
  sha256: string | null;
  mimeType: string | null;
  byteSize: number | null;
  filename: string | null;
}

/**
 * Referencias de acceso VÁLIDAS SOLO DURANTE ESTE EVENTO.
 *
 * Nombre en inglés y explícito a propósito: quien vea `transient` en una firma
 * no puede alegar que no sabía que guardarlo era un error.
 */
export interface ImageTransientRefs {
  /** `kapso.media_url` — requiere la API key de Kapso. */
  kapsoMediaUrl: string | null;
  /** `image.link` — el mismo contenido servido por Kapso. */
  link: string | null;
  /** `image.url` — lookaside de Meta, temporal. */
  metaUrl: string | null;
}

export interface ImageAttachment {
  facts: ImageMediaFacts;
  transient: ImageTransientRefs;
  /** Caption REAL escrito por el cliente, o `null`. */
  caption: string | null;
}

function rec(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  // `byte_size` puede llegar como cadena según el serializador del proveedor.
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

export function isImageType(messageType: string | null | undefined): boolean {
  return messageType === KAPSO_MESSAGE_TYPE_IMAGE;
}

export function isImageMessage(message: Record<string, unknown> | undefined | null): boolean {
  return isImageType(str(message?.type));
}

/** ¿Es un MIME de imagen que sabemos tratar? */
export function isSupportedImageMime(mimeType: string | null | undefined): boolean {
  if (!mimeType) return false;
  // El proveedor puede añadir parámetros: `image/jpeg; charset=binary`.
  const base = mimeType.split(';')[0].trim().toLowerCase();
  return SUPPORTED_IMAGE_MIME_TYPES.includes(base);
}

/**
 * Caption del cliente.
 *
 * Orden: `image.caption` manda. `kapso.message_type_data.caption` solo entra si
 * el primero falta Y el respaldo dice algo — en la foto sin caption llegó `""`,
 * y una cadena vacía es la ausencia del campo, no su valor.
 */
export function extractCaption(message: Record<string, unknown> | undefined): string | null {
  const directo = str(rec(message?.image)?.caption);
  if (directo !== null) return directo;
  return str(rec(rec(message?.kapso)?.message_type_data)?.caption);
}

/** Vista estructurada de la imagen, o `null` si el mensaje no es una imagen. */
export function parseImage(message: Record<string, unknown> | undefined): ImageAttachment | null {
  if (!isImageMessage(message)) return null;

  const image = rec(message?.image) ?? {};
  const kapso = rec(message?.kapso);
  const mediaData = rec(kapso?.media_data);

  return {
    facts: {
      mediaId: str(image.id),
      sha256: str(image.sha256),
      // `image.mime_type` es la fuente; `media_data.content_type` la confirma.
      mimeType: str(image.mime_type) ?? str(mediaData?.content_type),
      byteSize: num(mediaData?.byte_size),
      filename: str(mediaData?.filename),
    },
    transient: {
      kapsoMediaUrl: str(kapso?.media_url),
      link: str(image.link),
      metaUrl: str(image.url),
    },
    caption: extractCaption(message),
  };
}

/**
 * `metadata` de un mensaje de imagen — la forma exacta que se persiste.
 *
 *     { "channel_event": "image",
 *       "media": { "media_id", "sha256", "mime_type", "byte_size", "filename" } }
 *
 * Las claves ausentes se OMITEN en vez de escribirse a `null`: un `filename:
 * null` afirma que se miró y no había, cuando lo cierto es que el proveedor no
 * lo mandó. Y sobre todo: aquí NO entra ninguna URL. Ni `image.url`, ni
 * `image.link`, ni `kapso.media_url`, ni `kapso.content`.
 *
 * `sha256` se guarda para poder RECONOCER que dos mensajes traen el mismo
 * archivo — nunca para deduplicarlos. El contrato real lo dejó claro: las dos
 * capturas de Production tenían el mismo `sha256` y el mismo `byte_size` con
 * WAMID distintos. Mandar dos veces la misma foto es algo que la gente hace.
 */
export function imageMetadata(
  message: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const parsed = parseImage(message);
  if (parsed === null) return { channel_event: KAPSO_MESSAGE_TYPE_IMAGE };

  const media: Record<string, unknown> = {};
  if (parsed.facts.mediaId !== null) media.media_id = parsed.facts.mediaId;
  if (parsed.facts.sha256 !== null) media.sha256 = parsed.facts.sha256;
  if (parsed.facts.mimeType !== null) media.mime_type = parsed.facts.mimeType;
  if (parsed.facts.byteSize !== null) media.byte_size = parsed.facts.byteSize;
  if (parsed.facts.filename !== null) media.filename = parsed.facts.filename;

  return Object.keys(media).length === 0
    ? { channel_event: KAPSO_MESSAGE_TYPE_IMAGE }
    : { channel_event: KAPSO_MESSAGE_TYPE_IMAGE, media };
}
