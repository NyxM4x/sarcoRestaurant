import { describe, it, expect } from 'vitest';
import {
  PROOF_MAX_BYTES,
  extensionFor,
  isImageMime,
  isProofMimeType,
  normalizeMime,
  safeFilenameFor,
  sniffMimeType,
  validateProofBytes,
} from './mime';

/** Construye bytes con una firma dada y relleno hasta `size`. */
function file(signature: number[], size = 64): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set(signature, 0);
  return bytes;
}

const JPEG = [0xff, 0xd8, 0xff, 0xe0];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const GIF89 = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61];
const GIF87 = [0x47, 0x49, 0x46, 0x38, 0x37, 0x61];
const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34];

function webp(): Uint8Array {
  const bytes = new Uint8Array(64);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0); // "RIFF"
  bytes.set([0x00, 0x00, 0x01, 0x00], 4); // tamaño (irrelevante)
  bytes.set([0x57, 0x45, 0x42, 0x50], 8); // "WEBP"
  return bytes;
}

describe('formatos admitidos — reconocimiento por contenido', () => {
  it('reconoce JPEG, PNG, WebP, GIF y PDF por su firma', () => {
    expect(sniffMimeType(file(JPEG))).toBe('image/jpeg');
    expect(sniffMimeType(file(PNG))).toBe('image/png');
    expect(sniffMimeType(webp())).toBe('image/webp');
    expect(sniffMimeType(file(GIF89))).toBe('image/gif');
    expect(sniffMimeType(file(GIF87))).toBe('image/gif');
    expect(sniffMimeType(file(PDF))).toBe('application/pdf');
  });

  it('un contenido desconocido no se adivina', () => {
    expect(sniffMimeType(file([0x00, 0x01, 0x02, 0x03]))).toBeNull();
    expect(sniffMimeType(new Uint8Array(0))).toBeNull();
    // "RIFF" sin "WEBP" es otra cosa (un WAV, por ejemplo).
    const riffWav = new Uint8Array(64);
    riffWav.set([0x52, 0x49, 0x46, 0x46], 0);
    riffWav.set([0x57, 0x41, 0x56, 0x45], 8);
    expect(sniffMimeType(riffWav)).toBeNull();
  });

  it('no desborda con archivos más cortos que la firma', () => {
    expect(sniffMimeType(new Uint8Array([0xff]))).toBeNull();
    expect(sniffMimeType(new Uint8Array([0x47, 0x49, 0x46]))).toBeNull();
  });
});

describe('validación completa del comprobante', () => {
  it('acepta cada formato admitido y da su extensión segura', () => {
    const casos = [
      [file(JPEG), 'image/jpeg', 'jpg'],
      [file(PNG), 'image/png', 'png'],
      [webp(), 'image/webp', 'webp'],
      [file(GIF89), 'image/gif', 'gif'],
      [file(PDF), 'application/pdf', 'pdf'],
    ] as const;
    for (const [bytes, mime, ext] of casos) {
      const res = validateProofBytes(bytes, mime);
      expect(res.ok, mime).toBe(true);
      if (res.ok) {
        expect(res.mimeType).toBe(mime);
        expect(res.extension).toBe(ext);
        expect(res.declaredMatches).toBe(true);
      }
    }
  });

  it('rechaza un archivo vacío', () => {
    expect(validateProofBytes(new Uint8Array(0), 'image/png')).toEqual({
      ok: false,
      reason: 'empty',
    });
  });

  it('rechaza por encima de 8 MB', () => {
    expect(PROOF_MAX_BYTES).toBe(8 * 1024 * 1024);
    const grande = new Uint8Array(PROOF_MAX_BYTES + 1);
    grande.set(JPEG, 0);
    expect(validateProofBytes(grande, 'image/jpeg')).toEqual({ ok: false, reason: 'too_large' });
  });

  it('acepta justo en el límite de 8 MB', () => {
    const justo = new Uint8Array(PROOF_MAX_BYTES);
    justo.set(JPEG, 0);
    expect(validateProofBytes(justo, 'image/jpeg').ok).toBe(true);
  });

  it('rechaza un contenido que no es ninguno de los formatos admitidos', () => {
    // Un ejecutable renombrado a .pdf: el proveedor declara PDF, los bytes no lo son.
    const exe = file([0x4d, 0x5a, 0x90, 0x00]); // "MZ" (PE/DOS)
    expect(validateProofBytes(exe, 'application/pdf')).toEqual({
      ok: false,
      reason: 'unsupported_content',
    });
  });

  it('rechaza el archivo renombrado entre dos formatos admitidos', () => {
    // Un PNG declarado como PDF: ambos se admiten, pero no coinciden.
    expect(validateProofBytes(file(PNG), 'application/pdf')).toEqual({
      ok: false,
      reason: 'declared_mismatch',
    });
    expect(validateProofBytes(file(PDF), 'image/jpeg')).toEqual({
      ok: false,
      reason: 'declared_mismatch',
    });
  });

  it('si el proveedor no declara tipo, o declara uno que no admitimos, manda el contenido', () => {
    // El proveedor puede sencillamente no saberlo; el contenido sí lo sabemos.
    for (const declarado of [null, undefined, '', 'application/octet-stream']) {
      const res = validateProofBytes(file(PNG), declarado);
      expect(res.ok, String(declarado)).toBe(true);
      if (res.ok) {
        expect(res.mimeType).toBe('image/png');
        expect(res.declaredMatches).toBe(false);
      }
    }
  });

  it('tolera parámetros y mayúsculas en el tipo declarado', () => {
    expect(normalizeMime('IMAGE/PNG; charset=binary')).toBe('image/png');
    expect(validateProofBytes(file(PNG), 'Image/PNG; charset=binary').ok).toBe(true);
  });
});

describe('presentación y nombres seguros', () => {
  it('distingue imagen de documento para decidir miniatura', () => {
    expect(isImageMime('image/png')).toBe(true);
    expect(isImageMime('application/pdf')).toBe(false);
    expect(isImageMime(null)).toBe(false);
  });

  it('el nombre seguro no arrastra rutas ni la extensión del cliente', () => {
    const name = safeFilenameFor('../../etc/passwd', 'application/pdf');
    expect(name).not.toContain('/');
    expect(name).not.toContain('..');
    expect(name.endsWith('.pdf')).toBe(true);
  });

  it('el nombre seguro usa la extensión del tipo REAL', () => {
    expect(safeFilenameFor('abc-123', 'image/jpeg')).toBe('comprobante-abc-123.jpg');
    expect(extensionFor('image/webp')).toBe('webp');
  });

  it('isProofMimeType cierra el dominio', () => {
    expect(isProofMimeType('image/png')).toBe(true);
    expect(isProofMimeType('image/svg+xml')).toBe(false);
    expect(isProofMimeType(null)).toBe(false);
  });
});
