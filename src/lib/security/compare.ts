import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Compara dos cadenas en tiempo constante.
 *
 * Se comparan hashes SHA-256 de longitud fija para no filtrar la longitud por el
 * tiempo de ejecución. Devuelve `false` ante entradas vacías.
 *
 * Módulo puro (sin `server-only`) para poder probarlo y reutilizarlo desde la
 * lógica del webhook.
 */
export function safeCompare(a: string, b: string): boolean {
  if (!a || !b) return false;
  const ah = createHash('sha256').update(a).digest();
  const bh = createHash('sha256').update(b).digest();
  return timingSafeEqual(ah, bh);
}

/** Un HMAC SHA-256 en hex son exactamente 64 caracteres hexadecimales. */
const HEX_SHA256_RE = /^[0-9a-fA-F]{64}$/;

/** ¿La cadena es una firma HMAC SHA-256 en hex válida (64 chars)? */
export function isHexSha256(signature: string): boolean {
  return HEX_SHA256_RE.test(signature);
}

/**
 * Verifica una firma HMAC SHA-256 (formato Kapso V2) sobre el cuerpo crudo.
 *
 * La firma es hexadecimal directo, sin prefijo `sha256=`. Se exige el formato
 * hex de 64 caracteres antes de comparar en tiempo constante.
 */
export function verifyHmacSha256(
  rawBody: string,
  providedSignature: string,
  secret: string,
): boolean {
  if (!secret || !providedSignature || !isHexSha256(providedSignature)) return false;
  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  return safeCompare(expected, providedSignature.toLowerCase());
}
