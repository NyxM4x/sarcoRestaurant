/**
 * Hashing de contrasenas — modulo PURO (sin server-only, testeable).
 *
 * bcrypt, no SHA-256. `safeCompare` de `compare.ts` sirve para comparar
 * secretos que YA conocemos (tokens, firmas de webhook), pero no vale para
 * guardar contrasenas: SHA-256 es rapido a proposito, y eso es justo lo que un
 * atacante con la base robada necesita para probar millones por segundo. bcrypt
 * tiene coste ajustable, sal por contrasena, y verificacion en tiempo constante.
 *
 * Se usa `bcryptjs` (JavaScript puro) en lugar de `bcrypt` (binario nativo)
 * para no depender de compilacion nativa en el build serverless de Vercel.
 */
import bcrypt from 'bcryptjs';

/**
 * Coste de bcrypt. 12 son ~250 ms por verificacion en el runtime de Vercel:
 * imperceptible en un login manual, carisimo para una fuerza bruta masiva.
 */
export const PASSWORD_SALT_ROUNDS = 12;

/** Hashea una contrasena en claro. Cada llamada usa una sal nueva. */
export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, PASSWORD_SALT_ROUNDS);
}

/**
 * Verifica una contrasena contra su hash. NUNCA lanza: un hash corrupto o
 * vacio en la base devuelve `false`, no tumba el login de todo el restaurante.
 */
export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  if (!plain || !hash) return false;
  try {
    return await bcrypt.compare(plain, hash);
  } catch {
    return false;
  }
}
