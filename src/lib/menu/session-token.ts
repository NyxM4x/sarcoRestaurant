/**
 * Tokens seguros para sesiones de menú — módulo puro.
 *
 * El token opaco viaja en la URL (`?session=TOKEN`). Solo el hash se persiste
 * en Supabase. Token generado de forma REPRODUCIBLE mediante HMAC-SHA256:
 * HMAC(MENU_SESSION_SECRET, source_message_id) → mismo token en reintentos.
 *
 * No hay dependencias externas: se usa Node crypto nativo.
 */
import { createHmac, createHash, timingSafeEqual } from 'node:crypto';

/**
 * Genera un token opaco reproducible basado en source_message_id y un secreto.
 *
 * - Entrada: wamid del mensaje entrante (message.id) + MENU_SESSION_SECRET
 * - Salida: token opaco base64url (determinista, sin Math.random)
 * - Idempotencia: mismo source_message_id → mismo token
 *
 * No expone el secreto: usa HMAC.
 */
export function generateMenuSessionToken(sourceMessageId: string, secret: string): string {
  return createHmac('sha256', secret)
    .update(sourceMessageId, 'utf8')
    .digest('base64url');
}

/**
 * Calcula el hash SHA-256 de un token.
 *
 * Se persiste esto en Supabase, nunca el token en texto plano. Para validar,
 * se hashea el token recibido y se compara con el hash guardado.
 */
export function hashMenuSessionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Valida que un token recibido corresponda al hash guardado.
 *
 * Usa timing-safe comparison para evitar timing attacks.
 */
export function verifyMenuSessionToken(token: string, savedHash: string): boolean {
  try {
    if (!token || !savedHash) return false;
    const computedHash = hashMenuSessionToken(token);
    if (computedHash.length !== savedHash.length) return false;
    // timingSafeEqual compara buffers en tiempo constante.
    const computedBuf = Buffer.from(computedHash, 'utf8');
    const savedBuf = Buffer.from(savedHash, 'utf8');
    return timingSafeEqual(computedBuf, savedBuf);
  } catch {
    return false;
  }
}
