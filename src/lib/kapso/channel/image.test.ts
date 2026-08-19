import { describe, it, expect } from 'vitest';
import {
  extractCaption,
  imageMetadata,
  isImageMessage,
  isSupportedImageMime,
  parseImage,
} from './image';
import { parseKapsoProvenance, KAPSO_EVENT_RECEIVED } from './provenance';
import {
  imageNoCaptionEnvelope,
  imageWithCaptionEnvelope,
  IMAGE_BYTE_SIZE,
  IMAGE_CAPTION_MEDIA_ID,
  IMAGE_CAPTION_TEXT,
  IMAGE_CAPTION_WAMID,
  IMAGE_FILENAME,
  IMAGE_MIME_TYPE,
  IMAGE_NO_CAPTION_MEDIA_ID,
  IMAGE_NO_CAPTION_WAMID,
  IMAGE_SHA256,
  KAPSO_MEDIA_URL,
  META_LOOKASIDE_URL,
} from './image.fixtures';

/**
 * IMÁGENES (Fase 6D.2F.5C.5).
 *
 * Los fixtures son el contrato REAL capturado en Production, sanitizado. Lo que
 * más importa aquí no es que el parser lea bien: es que ninguna URL de acceso al
 * contenido del cliente acabe en lo que se persiste, y que el caption salga de
 * la estructura y nunca de la frase compuesta de `kapso.content`.
 */

function mensajeDe(envelope: Record<string, unknown>): Record<string, unknown> {
  return envelope.message as Record<string, unknown>;
}

describe('image — parseo del contrato real', () => {
  it('1 · SIN caption: image.caption ausente y message_type_data.caption vacío', () => {
    const message = mensajeDe(imageNoCaptionEnvelope());

    // El contrato observado: la clave no viene en `image`, y el respaldo llega
    // como cadena vacía. Ninguna de las dos es un caption.
    expect('caption' in (message.image as Record<string, unknown>)).toBe(false);
    expect(
      ((message.kapso as Record<string, unknown>).message_type_data as Record<string, unknown>)
        .caption,
    ).toBe('');

    const parsed = parseImage(message);
    expect(parsed?.caption).toBeNull();
    expect(parsed?.facts).toEqual({
      mediaId: IMAGE_NO_CAPTION_MEDIA_ID,
      sha256: IMAGE_SHA256,
      mimeType: IMAGE_MIME_TYPE,
      byteSize: IMAGE_BYTE_SIZE,
      filename: IMAGE_FILENAME,
    });
  });

  it('2 · CON caption: sale de image.caption', () => {
    const parsed = parseImage(mensajeDe(imageWithCaptionEnvelope()));

    expect(parsed?.caption).toBe(IMAGE_CAPTION_TEXT);
    expect(parsed?.facts.mediaId).toBe(IMAGE_CAPTION_MEDIA_ID);
  });

  it('5 · kapso.content NUNCA se convierte en caption', () => {
    const message = mensajeDe(imageNoCaptionEnvelope());
    const compuesta = (message.kapso as Record<string, unknown>).content as string;

    // La frase existe y mezcla filename, tamaño, MIME y URL.
    expect(compuesta).toContain(IMAGE_FILENAME);
    expect(compuesta).toContain(KAPSO_MEDIA_URL);
    // Y aun así no hay caption.
    expect(extractCaption(message)).toBeNull();
  });

  it('el respaldo estructural solo entra si dice algo', () => {
    // Sin `image.caption` pero con `message_type_data.caption` real.
    const message = {
      type: 'image',
      image: { id: 'm1', mime_type: 'image/jpeg' },
      kapso: { message_type_data: { caption: 'desde el respaldo' } },
    };
    expect(extractCaption(message)).toBe('desde el respaldo');

    // Cadena vacía = ausencia, no valor.
    const vacio = { type: 'image', image: { id: 'm1' }, kapso: { message_type_data: { caption: '   ' } } };
    expect(extractCaption(vacio)).toBeNull();
  });

  it('un mensaje que no es imagen no se parsea como tal', () => {
    expect(isImageMessage({ type: 'text', text: { body: 'hola' } })).toBe(false);
    expect(parseImage({ type: 'reaction' })).toBeNull();
  });

  it('la lista blanca de MIME rechaza lo que no es una foto', () => {
    expect(isSupportedImageMime('image/jpeg')).toBe(true);
    expect(isSupportedImageMime('image/jpeg; charset=binary')).toBe(true);
    expect(isSupportedImageMime('image/svg+xml')).toBe(false);
    expect(isSupportedImageMime('application/pdf')).toBe(false);
    expect(isSupportedImageMime(null)).toBe(false);
  });
});

describe('image — metadata durable', () => {
  it('3 · guarda media_id, sha256, mime, tamaño y filename', () => {
    expect(imageMetadata(mensajeDe(imageWithCaptionEnvelope()))).toEqual({
      channel_event: 'image',
      media: {
        media_id: IMAGE_CAPTION_MEDIA_ID,
        sha256: IMAGE_SHA256,
        mime_type: IMAGE_MIME_TYPE,
        byte_size: IMAGE_BYTE_SIZE,
        filename: IMAGE_FILENAME,
      },
    });
  });

  it('4 · NINGUNA url llega a la metadata que se persiste', () => {
    for (const envelope of [imageNoCaptionEnvelope(), imageWithCaptionEnvelope()]) {
      const dump = JSON.stringify(imageMetadata(mensajeDe(envelope)));

      expect(dump).not.toContain(KAPSO_MEDIA_URL);
      expect(dump).not.toContain(META_LOOKASIDE_URL);
      expect(dump).not.toContain('http');
      // Ni la frase compuesta del proveedor.
      expect(dump).not.toContain('Image attached');
    }
  });

  it('las claves ausentes se omiten en vez de escribirse a null', () => {
    const metadata = imageMetadata({ type: 'image', image: { id: 'solo-id' } });

    expect(metadata).toEqual({ channel_event: 'image', media: { media_id: 'solo-id' } });
  });

  it('las URLs transitorias sí viajan aparte, para el turno actual', () => {
    const parsed = parseImage(mensajeDe(imageNoCaptionEnvelope()));

    expect(parsed?.transient.kapsoMediaUrl).toBe(KAPSO_MEDIA_URL);
    expect(parsed?.transient.metaUrl).toBe(META_LOOKASIDE_URL);
  });
});

describe('image — provenance', () => {
  it('content = caption, content_type = image', () => {
    const conCaption = parseKapsoProvenance(KAPSO_EVENT_RECEIVED, imageWithCaptionEnvelope());
    const sinCaption = parseKapsoProvenance(KAPSO_EVENT_RECEIVED, imageNoCaptionEnvelope());

    const uno = (conCaption as { message: { content: string | null; contentType: string } }).message;
    const dos = (sinCaption as { message: { content: string | null; contentType: string } }).message;

    expect(uno.content).toBe(IMAGE_CAPTION_TEXT);
    expect(uno.contentType).toBe('image');
    // Sin caption: NULL. No se fabrica texto que el cliente no escribió.
    expect(dos.content).toBeNull();
    expect(dos.contentType).toBe('image');
  });

  it('14 · mismo sha256 con OTRO WAMID son dos mensajes válidos', () => {
    // Las dos capturas reales eran el mismo archivo enviado dos veces.
    const a = parseKapsoProvenance(KAPSO_EVENT_RECEIVED, imageNoCaptionEnvelope());
    const b = parseKapsoProvenance(KAPSO_EVENT_RECEIVED, imageWithCaptionEnvelope());

    const uno = (a as { message: { providerMessageId: string | null; metadata: Record<string, unknown> | null } }).message;
    const dos = (b as { message: { providerMessageId: string | null; metadata: Record<string, unknown> | null } }).message;

    expect(uno.providerMessageId).toBe(IMAGE_NO_CAPTION_WAMID);
    expect(dos.providerMessageId).toBe(IMAGE_CAPTION_WAMID);
    expect(uno.providerMessageId).not.toBe(dos.providerMessageId);
    // Mismo hash: se guarda para reconocer, jamás para deduplicar.
    const hashUno = (uno.metadata?.media as Record<string, unknown>).sha256;
    const hashDos = (dos.metadata?.media as Record<string, unknown>).sha256;
    expect(hashUno).toBe(hashDos);
  });

  it('el adjunto transitorio viaja en el mensaje, fuera de metadata', () => {
    const provenance = parseKapsoProvenance(KAPSO_EVENT_RECEIVED, imageWithCaptionEnvelope());
    const message = (provenance as {
      message: { image?: { transient: { kapsoMediaUrl: string | null } } | null;
                 metadata: Record<string, unknown> | null };
    }).message;

    expect(message.image?.transient.kapsoMediaUrl).toBe(KAPSO_MEDIA_URL);
    // Y no se ha colado en lo que se persiste.
    expect(JSON.stringify(message.metadata)).not.toContain(KAPSO_MEDIA_URL);
  });
});
