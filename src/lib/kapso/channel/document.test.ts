import { describe, it, expect } from 'vitest';
import {
  isDocumentMessage,
  isSupportedDocumentMime,
  parseDocument,
  extractDocumentCaption,
} from './document';

/**
 * DOCUMENTOS — contra el payload REAL capturado el 27-08-2026.
 *
 * El fixture reproduce la estructura exacta de un PDF que llegó por el webhook,
 * con la ruta y el token sanitizados. Nada de esto se dedujo del contrato de
 * WhatsApp: el mismo proveedor ya nos había sorprendido dos veces el mismo día
 * —un 302 hacia un bucket fuera de la lista blanca, y un `context` siempre nulo—
 * y escribir el parser contra una forma supuesta habría probado la suposición.
 */

/** Mensaje `document` tal como llegó, con las referencias sanitizadas. */
function documentEnvelope(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'wamid.DOCUMENTO_SANITIZADO',
    from: '59100000000',
    type: 'document',
    timestamp: '1787844142',
    context: null,
    document: {
      id: '2267829863993481',
      url: 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=SANITIZADO',
      link: 'https://app.kapso.ai/rails/active_storage/blobs/redirect/SANITIZADO/comprobante.pdf',
      sha256: 'bEhGt7Hn3JFXKMeZ2PJ2GlXyAOhX9BvS+tjb8RyGNYw=',
      filename: 'comprobante.pdf',
      mime_type: 'application/pdf',
      ...(over.document as Record<string, unknown> | undefined),
    },
    kapso: {
      origin: 'cloud_api',
      status: 'delivered',
      direction: 'inbound',
      has_media: true,
      media_url:
        'https://app.kapso.ai/rails/active_storage/blobs/redirect/SANITIZADO/comprobante.pdf',
      media_data: {
        url: 'https://app.kapso.ai/rails/active_storage/blobs/redirect/SANITIZADO/comprobante.pdf',
        filename: 'comprobante.pdf',
        byte_size: 792233,
        content_type: 'application/pdf',
      },
      // En el PDF observado llegó como cadena vacía, igual que en la imagen.
      message_type_data: { caption: '', has_media: true },
    },
    ...over,
  };
}

describe('document — reconocimiento', () => {
  it('reconoce el tipo del payload real', () => {
    expect(isDocumentMessage(documentEnvelope())).toBe(true);
  });

  it('no confunde una imagen ni un texto con un documento', () => {
    expect(isDocumentMessage({ type: 'image' })).toBe(false);
    expect(isDocumentMessage({ type: 'text' })).toBe(false);
    expect(isDocumentMessage(undefined)).toBe(false);
  });

  it('solo PDF: ni ofimática ni comprimidos', () => {
    expect(isSupportedDocumentMime('application/pdf')).toBe(true);
    // El proveedor puede añadir parámetros.
    expect(isSupportedDocumentMime('application/pdf; charset=binary')).toBe(true);
    expect(isSupportedDocumentMime('APPLICATION/PDF')).toBe(true);

    for (const mime of [
      'application/zip',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/octet-stream',
      'text/html',
      null,
      '',
    ]) {
      expect(isSupportedDocumentMime(mime), String(mime)).toBe(false);
    }
  });
});

describe('document — parseo del payload real', () => {
  it('separa los hechos durables de las referencias transitorias', () => {
    const parsed = parseDocument(documentEnvelope())!;

    expect(parsed.facts).toEqual({
      mediaId: '2267829863993481',
      sha256: 'bEhGt7Hn3JFXKMeZ2PJ2GlXyAOhX9BvS+tjb8RyGNYw=',
      mimeType: 'application/pdf',
      byteSize: 792233,
      filename: 'comprobante.pdf',
    });

    // Las tres referencias de acceso, cada una en su sitio.
    expect(parsed.transient.kapsoMediaUrl).toContain('app.kapso.ai');
    expect(parsed.transient.link).toContain('app.kapso.ai');
    expect(parsed.transient.metaUrl).toContain('lookaside.fbsbx.com');
  });

  it('ninguna URL se cuela entre los hechos que SÍ se persisten', () => {
    // `facts` es lo único que puede acabar en la base. Una URL ahí sería una
    // credencial de acceso al archivo de un cliente guardada para siempre.
    const parsed = parseDocument(documentEnvelope())!;
    expect(JSON.stringify(parsed.facts)).not.toContain('http');
  });

  it('el caption vacío es ausencia, no valor', () => {
    expect(extractDocumentCaption(documentEnvelope())).toBeNull();
  });

  it('un caption real se lee de `document.caption`', () => {
    const con = documentEnvelope({ document: { caption: 'Este es mi comprobante' } });
    expect(extractDocumentCaption(con)).toBe('Este es mi comprobante');
  });

  it('el tamaño llega aunque el proveedor lo mande como cadena', () => {
    const raro = documentEnvelope();
    (raro.kapso as Record<string, unknown>).media_data = { byte_size: '792233' };
    expect(parseDocument(raro)!.facts.byteSize).toBe(792233);
  });

  it('sin `document` no se inventa un adjunto', () => {
    expect(parseDocument({ type: 'document' })!.facts.mediaId).toBeNull();
    expect(parseDocument({ type: 'image' })).toBeNull();
  });

  it('el nombre del cliente se conserva como dato, no como ruta', () => {
    // Se guarda para auditoría, pero NUNCA construye la key ni la extensión:
    // eso lo hace `safeFilenameFor` a partir del id y del tipo verificado.
    const malicioso = documentEnvelope({
      document: { filename: '../../etc/passwd' },
    });
    expect(parseDocument(malicioso)!.facts.filename).toBe('../../etc/passwd');
  });
});
