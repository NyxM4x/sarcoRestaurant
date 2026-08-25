/**
 * Repositorio de usuarios del acceso interno — modulo PURO con la fuente de
 * datos INYECTADA.
 *
 * Misma forma que `orders-repository.ts`: la logica de autenticacion vive aqui
 * (testeable sin base), y el adaptador Supabase (server-only) solo traduce
 * consultas. El `password_hash` entra en este modulo y NO sale: hacia afuera
 * solo viaja el rol probado, nunca el usuario completo.
 */
import type { DashboardUser } from '@/types';
import { verifyPassword } from '@/lib/security/password';
import type { SessionRole } from './session-token';

/** Adaptador de datos. La implementacion real (Supabase) es server-only. */
export interface UsersDataSource {
  /** Busca por nombre de usuario, sin distinguir mayusculas. */
  findByUsername(username: string): Promise<DashboardUser | null>;
}

export interface UsersRepository {
  /** Devuelve el rol probado, o `null` si las credenciales no valen. */
  authenticate(username: string, password: string): Promise<SessionRole | null>;
}

/**
 * Hash bcrypt fijo de una cadena que nadie usa como contrasena.
 *
 * Cuando el usuario no existe se verifica contra ESTE hash en vez de devolver
 * `null` de inmediato. Sin eso, un usuario inexistente respondería en
 * microsegundos y uno real en ~250 ms, y esa diferencia permite enumerar qué
 * nombres de usuario existen midiendo el tiempo de respuesta.
 */
const DUMMY_HASH = '$2b$12$w/E/Sxx96z9.2fCleLOCjO69ZHKcPydywu93bhqgqZgP0WFejRpr2';

/** Normaliza el usuario tecleado: sin espacios sobrantes, en minusculas. */
export function normalizeUsername(raw: string): string {
  return raw.trim().toLowerCase();
}

export function createUsersRepository(source: UsersDataSource): UsersRepository {
  return {
    async authenticate(username, password) {
      const clean = normalizeUsername(username ?? '');
      if (!clean || !password) {
        // Aun sin datos se paga el coste, para no distinguir "campo vacio" de
        // "usuario inexistente" por tiempo.
        await verifyPassword(password || 'x', DUMMY_HASH);
        return null;
      }

      const user = await source.findByUsername(clean);
      if (!user) {
        await verifyPassword(password, DUMMY_HASH);
        return null;
      }

      // Segunda barrera sobre la busqueda: el nombre devuelto debe ser
      // EXACTAMENTE el que se pidio (salvo mayusculas). La fuente busca con
      // `ilike`, y aunque ya escapa los comodines, aqui se exige la
      // coincidencia real para que ningun patron pueda entregar otra cuenta.
      if (normalizeUsername(user.username) !== clean) {
        await verifyPassword(password, DUMMY_HASH);
        return null;
      }

      // Defensa en profundidad: la fuente ya filtra por `is_active`, pero el
      // repositorio no lo da por hecho. Un usuario dado de baja no entra ni
      // aunque una consulta futura se olvide del filtro.
      if (!user.is_active) {
        await verifyPassword(password, DUMMY_HASH);
        return null;
      }

      const ok = await verifyPassword(password, user.password_hash);
      if (!ok) return null;

      // El rol viene de la BASE. El CHECK de la migracion ya restringe los
      // valores, pero un rol desconocido (base manipulada, migracion futura)
      // se rechaza en vez de colarse como sesion sin permisos definidos.
      if (user.role !== 'admin' && user.role !== 'kitchen') return null;
      return user.role;
    },
  };
}
