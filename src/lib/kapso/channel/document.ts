import type { ImageAttachment } from './image';

/**
 * DOCUMENTOS DE WHATSAPP — parseo PURO.
 *
 * Contrato OBSERVADO en Production el 27-08-2026 con un PDF real, no
 * documentación:
 *
 *   message.type = 'document'
 *   message.id   = WAMID propio
 *   message.document = { id, url, link, sha256, filename, mime_type, caption? }
 *   message.kapso = { has_media, media_url, media_data: { url, filename,
 *                     byte_size, content_type }, message_type_data: { caption } }
 *
 * ── Es el mismo contrato que la imagen, campo por campo ─────────────────────
 *
 * `document` trae exactamente las mismas claves que `image` más `filename`. Eso
 * NO se dio por supuesto: se comprobó contra el payload real antes de escribir
 * una línea, porque el mismo proveedor ya nos había sorprendido dos veces el
 * mismo día —un 302 hacia un bucket que no estaba en la lista blanca, y un
 * `context` siempre nulo que dejó `reply_to_qr` inalcanzable—.
 *
 * Por eso la forma de salida es `ImageAttachment` y no un tipo paralelo: los
 * datos son los mismos, y duplicar la estructura obligaría a duplicar también
 * cada función que la consume. El nombre del tipo se queda corto; inventar un
 * gemelo idéntico saldría más caro que eso.
 *
 * ── Por qué esto existe aparte del resolutor de imágenes ────────────────────
 *
 * Un PDF se captura como comprobante pero NO puede acabar en la entrada de
 * Vision del agente. Ese límite se sostiene en `media-resolver.ts`, que tiene
 * una puerta distinta para cada uno; aquí solo se lee el mensaje.
 *
 * ── Lo durable y lo transitorio ─────────────────────────────────────────────
 *
 * Igual que en `image.ts`: `facts` se persiste, `transient` son credenciales de
 * acceso temporal al archivo de un cliente y no pueden acabar en `agent_messages`,
 * en un log ni en un informe.
 */

/** `message.type` de un documento. */
export const KAPSO_MESSAGE_TYPE_DOCUMENT = 'document';

/**
 * MIME admitidos como documento. Solo PDF.
 *
 * Un comprobante bancario que no es una imagen es un PDF; admitir aquí ofimática
 * o archivos comprimidos ampliaría la superficie sin ganar un solo caso real. El
 * tipo declarado además NO decide nada por su cuenta: `validateProofBytes` vuelve
 * a mirar la firma real antes de guardar nada.
 */
export const SUPPORTED_DOCUMENT_MIME_TYPES: readonly string[] = ['application/pdf'];

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
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

export function isDocumentType(messageType: string | null | undefined): boolean {
  return messageType === KAPSO_MESSAGE_TYPE_DOCUMENT;
}

export function isDocumentMessage(message: Record<string, unknown> | undefined | null): boolean {
  return isDocumentType(str(message?.type));
}

/** ¿Es un MIME de documento que sabemos tratar? */
export function isSupportedDocumentMime(mimeType: string | null | undefined): boolean {
  if (!mimeType) return false;
  const base = mimeType.split(';')[0].trim().toLowerCase();
  return SUPPORTED_DOCUMENT_MIME_TYPES.includes(base);
}

/**
 * Caption del cliente. Mismo orden que en la imagen: el campo directo manda y el
 * respaldo estructural solo entra si dice algo — en el PDF observado llegó `""`,
 * y una cadena vacía es la ausencia del campo, no su valor.
 */
export function extractDocumentCaption(
  message: Record<string, unknown> | undefined,
): string | null {
  const directo = str(rec(message?.document)?.caption);
  if (directo !== null) return directo;
  return str(rec(rec(message?.kapso)?.message_type_data)?.caption);
}

/** Vista estructurada del documento, o `null` si el mensaje no es un documento. */
export function parseDocument(
  message: Record<string, unknown> | undefined,
): ImageAttachment | null {
  if (!isDocumentMessage(message)) return null;

  const document = rec(message?.document) ?? {};
  const kapso = rec(message?.kapso);
  const mediaData = rec(kapso?.media_data);

  return {
    facts: {
      mediaId: str(document.id),
      sha256: str(document.sha256),
      // `document.mime_type` es la fuente; `media_data.content_type` la confirma.
      mimeType: str(document.mime_type) ?? str(mediaData?.content_type),
      byteSize: num(mediaData?.byte_size),
      // El documento SÍ trae nombre propio, a diferencia de la imagen. Se
      // conserva como dato de auditoría, nunca para construir la ruta ni la
      // extensión del archivo guardado: `safeFilenameFor` lo reemplaza por uno
      // derivado del id y del tipo verificado, porque el nombre que manda el
      // cliente puede traer rutas o una extensión que contradiga el contenido.
      filename: str(document.filename) ?? str(mediaData?.filename),
    },
    transient: {
      kapsoMediaUrl: str(kapso?.media_url),
      link: str(document.link),
      metaUrl: str(document.url),
    },
    caption: extractDocumentCaption(message),
  };
}
