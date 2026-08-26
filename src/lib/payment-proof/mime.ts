/**
 * Validación de comprobantes por CONTENIDO — módulo PURO.
 *
 * El tipo que declara el proveedor es una afirmación de un tercero sobre el
 * archivo de un cliente; no es un hecho. Este módulo mira los primeros bytes y
 * decide qué es el archivo REALMENTE, para que renombrar un ejecutable a
 * `comprobante.pdf` no lo convierta en un PDF.
 *
 * El tipo verificado es el que manda después: decide si el panel pinta una
 * miniatura o una tarjeta de documento, y es el que se devuelve como
 * `Content-Type` en el endpoint autenticado. El declarado se guarda solo como
 * dato de auditoría —que ambos difieran es justamente lo interesante.
 */

/** Formatos admitidos como comprobante. */
export const PROOF_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'application/pdf',
] as const;
export type ProofMimeType = (typeof PROOF_MIME_TYPES)[number];

/** Tope por comprobante: 8 MB. */
export const PROOF_MAX_BYTES = 8 * 1024 * 1024;

/** Extensión segura por tipo. Nunca se usa la que venga en el nombre original. */
const EXTENSIONS: Record<ProofMimeType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'application/pdf': 'pdf',
};

export function extensionFor(mime: ProofMimeType): string {
  return EXTENSIONS[mime];
}

/** ¿Es una imagen? (decide miniatura vs tarjeta de documento en el panel) */
export function isImageMime(mime: string | null | undefined): boolean {
  return typeof mime === 'string' && mime.startsWith('image/');
}

export function isProofMimeType(value: string | null | undefined): value is ProofMimeType {
  return typeof value === 'string' && (PROOF_MIME_TYPES as readonly string[]).includes(value);
}

/** Normaliza `image/jpeg; charset=x` → `image/jpeg`. */
export function normalizeMime(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const base = raw.split(';')[0].trim().toLowerCase();
  return base === '' ? null : base;
}

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  for (let i = 0; i < signature.length; i += 1) {
    if (bytes[offset + i] !== signature[i]) return false;
  }
  return true;
}

/**
 * Deduce el tipo REAL a partir de los primeros bytes. `null` si no reconoce
 * ninguna firma conocida — que es motivo de rechazo, no de suposición.
 */
export function sniffMimeType(bytes: Uint8Array): ProofMimeType | null {
  // JPEG: FF D8 FF
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  // GIF: "GIF87a" | "GIF89a"
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38]) && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) {
    return 'image/gif';
  }
  // WebP: "RIFF" .... "WEBP" (el tamaño va en medio, por eso el offset 8)
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) {
    return 'image/webp';
  }
  // PDF: "%PDF-"
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf';
  return null;
}

export type ProofRejection =
  | 'empty'
  | 'too_large'
  | 'unsupported_content'
  | 'declared_mismatch';

export type ProofValidation =
  | { ok: true; mimeType: ProofMimeType; extension: string; declaredMatches: boolean }
  | { ok: false; reason: ProofRejection };

/**
 * Valida un comprobante entrante: tamaño, contenido real y coherencia con lo
 * declarado.
 *
 * Fail-closed en todos los bordes. Un contenido que no reconocemos se rechaza
 * aunque el proveedor jure que es un PDF: preferimos perder un comprobante raro
 * a guardar cualquier cosa en el bucket con un tipo inventado.
 */
export function validateProofBytes(
  bytes: Uint8Array,
  declaredMime: string | null | undefined,
): ProofValidation {
  if (bytes.length === 0) return { ok: false, reason: 'empty' };
  if (bytes.length > PROOF_MAX_BYTES) return { ok: false, reason: 'too_large' };

  const real = sniffMimeType(bytes);
  if (real === null) return { ok: false, reason: 'unsupported_content' };

  const declared = normalizeMime(declaredMime);
  // Si el proveedor declaró un tipo ADMITIDO distinto del real, es un archivo
  // renombrado: se rechaza. Si declaró algo que no admitimos (o nada), manda el
  // contenido real — el proveedor puede sencillamente no saberlo.
  if (declared !== null && declared !== real && isProofMimeType(declared)) {
    return { ok: false, reason: 'declared_mismatch' };
  }

  return {
    ok: true,
    mimeType: real,
    extension: extensionFor(real),
    declaredMatches: declared === real,
  };
}

/**
 * Nombre seguro para mostrar y descargar. NO se usa el nombre original del
 * cliente: podría traer rutas (`../`), caracteres de control o una extensión
 * que contradiga el contenido.
 */
export function safeFilenameFor(proofId: string, mime: ProofMimeType): string {
  const id = proofId.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 36);
  return `comprobante-${id}.${extensionFor(mime)}`;
}
