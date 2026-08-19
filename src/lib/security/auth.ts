import 'server-only';

// safeCompare vive en el módulo puro `./compare` para poder probarlo y
// reutilizarlo desde la lógica del webhook sin arrastrar `server-only`.
export { safeCompare } from './compare';

/**
 * Extrae el token `Bearer` del header Authorization. Devuelve `''` si no aplica.
 */
export function extractBearer(authorizationHeader: string | null): string {
  if (!authorizationHeader) return '';
  const prefix = 'Bearer ';
  return authorizationHeader.startsWith(prefix)
    ? authorizationHeader.slice(prefix.length).trim()
    : '';
}
