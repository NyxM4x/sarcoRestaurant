/**
 * Fixtures de IMAGEN derivados de los payloads REALES capturados en Production
 * (18-08-2026, teléfono de pruebas, buffering ON).
 *
 * Sanitizado: teléfono, WAMIDs, media ids, sha256, URLs, `conversation.id`,
 * BSUID y `phone_number_id`.
 *
 * NO sanitizado: la ESTRUCTURA. Lo que distingue los dos casos se conserva
 * exactamente como llegó:
 *
 *   · SIN caption → `image.caption` AUSENTE
 *                   `kapso.message_type_data.caption` = ""   ← cadena vacía
 *   · CON caption → `image.caption` PRESENTE
 *                   `kapso.message_type_data.caption` con el mismo texto
 *
 * Las dos capturas reales compartían `sha256` y `byte_size` con WAMID y media
 * id distintos: era el mismo archivo enviado dos veces. Los fixtures lo
 * conservan porque es la evidencia de que NO se puede deduplicar por hash.
 *
 * `kapso.content` se conserva con su frase compuesta —caption + filename +
 * tamaño + MIME + URL— porque es exactamente la contaminación que 5C.5 impide
 * que llegue ni a `agent_messages` ni al modelo. Un fixture sin ella no probaría
 * nada.
 */

export const IMAGE_NO_CAPTION_WAMID = 'wamid.IMAGE_NO_CAPTION_SANITIZED';
export const IMAGE_CAPTION_WAMID = 'wamid.IMAGE_CAPTION_SANITIZED';

export const IMAGE_NO_CAPTION_MEDIA_ID = '1000000000000001';
export const IMAGE_CAPTION_MEDIA_ID = '1000000000000002';

/** El MISMO archivo en las dos pruebas: mismo hash, mismo tamaño. */
export const IMAGE_SHA256 = 'c0ffee00000000000000000000000000000000000000000000000000deadbeef';
export const IMAGE_BYTE_SIZE = 70332;
export const IMAGE_MIME_TYPE = 'image/jpeg';
export const IMAGE_FILENAME = 'imagen-sanitizada.jpg';

export const IMAGE_CAPTION_TEXT = 'Que hamburguesa es esta?';

/**
 * URLs sanitizadas. Transitorias por definición: nunca se persisten.
 *
 * Se sanitiza la RUTA y el token, nunca el HOST: desde el endurecimiento de
 * 5C.5 el host es lo que decide si la descarga ocurre (ver `media-url-policy`),
 * así que un fixture con un dominio inventado probaría el rechazo en vez del
 * camino real. Estos dos son los observados en Production el 18-08-2026.
 */
export const KAPSO_MEDIA_URL = 'https://app.kapso.ai/media/sanitized-token';
export const META_LOOKASIDE_URL = 'https://lookaside.fbsbx.com/whatsapp/sanitized';

/**
 * Destino del 302 de `app.kapso.ai` (observado el 27-08-2026).
 *
 * Kapso sirve los adjuntos por ActiveStorage: la URL de arriba NO devuelve el
 * archivo, devuelve un redirect a su bucket. Este es el host que de verdad
 * entrega los bytes, y por eso está en la lista blanca.
 *
 * La ruta va sanitizada porque lleva la firma del presigned URL. El host NO:
 * cambiarlo probaría el rechazo en vez del camino real, que es justo el que
 * estaba roto.
 */
export const KAPSO_R2_REDIRECT_URL =
  'https://kapso-ai-prod.d77f1e59818b5ed2ec009d1a9116b255.r2.cloudflarestorage.com/sanitized-key';

const CUSTOMER_PHONE = '59100000000';
const CONVERSATION_ID = '00000000-0000-4000-8000-000000000002';
const PHONE_NUMBER_ID = '000000000000000';
const BSUID = 'BOSANITIZED0000000000';

function envelope(message: Record<string, unknown>): Record<string, unknown> {
  return {
    message,
    conversation: {
      id: CONVERSATION_ID,
      phone_number: CUSTOMER_PHONE,
      business_scoped_user_id: BSUID,
    },
    is_new_conversation: false,
    phone_number_id: PHONE_NUMBER_ID,
  };
}

function kapsoBlock(caption: string, mediaId: string): Record<string, unknown> {
  return {
    direction: 'inbound',
    origin: 'business_app',
    status: 'received',
    has_media: true,
    media_url: KAPSO_MEDIA_URL,
    media_data: {
      url: KAPSO_MEDIA_URL,
      filename: IMAGE_FILENAME,
      byte_size: IMAGE_BYTE_SIZE,
      content_type: IMAGE_MIME_TYPE,
    },
    // La frase compuesta del proveedor: mezcla el caption con metadatos y URL.
    content:
      caption === ''
        ? `Image attached (${IMAGE_FILENAME}, ${IMAGE_BYTE_SIZE} bytes, ${IMAGE_MIME_TYPE}) URL: ${KAPSO_MEDIA_URL}`
        : `${caption} Image attached (${IMAGE_FILENAME}, ${IMAGE_BYTE_SIZE} bytes, ${IMAGE_MIME_TYPE}) URL: ${KAPSO_MEDIA_URL}`,
    message_type_data: {
      // En la foto SIN caption llegó como cadena vacía, no ausente.
      caption,
      has_media: true,
    },
    media_id: mediaId,
  };
}

/** Imagen SIN caption: `image.caption` AUSENTE, `message_type_data.caption` = "". */
export function imageNoCaptionEnvelope(
  wamid: string = IMAGE_NO_CAPTION_WAMID,
  mediaId: string = IMAGE_NO_CAPTION_MEDIA_ID,
): Record<string, unknown> {
  return envelope({
    id: wamid,
    type: 'image',
    from: CUSTOMER_PHONE,
    from_user_id: BSUID,
    timestamp: 1_760_000_000,
    image: {
      id: mediaId,
      url: META_LOOKASIDE_URL,
      link: KAPSO_MEDIA_URL,
      sha256: IMAGE_SHA256,
      mime_type: IMAGE_MIME_TYPE,
    },
    kapso: kapsoBlock('', mediaId),
  });
}

/** Imagen CON caption: `image.caption` PRESENTE. */
export function imageWithCaptionEnvelope(
  wamid: string = IMAGE_CAPTION_WAMID,
  mediaId: string = IMAGE_CAPTION_MEDIA_ID,
  caption: string = IMAGE_CAPTION_TEXT,
): Record<string, unknown> {
  return envelope({
    id: wamid,
    type: 'image',
    from: CUSTOMER_PHONE,
    from_user_id: BSUID,
    timestamp: 1_760_000_120,
    image: {
      id: mediaId,
      url: META_LOOKASIDE_URL,
      link: KAPSO_MEDIA_URL,
      sha256: IMAGE_SHA256,
      mime_type: IMAGE_MIME_TYPE,
      caption,
    },
    kapso: kapsoBlock(caption, mediaId),
  });
}
