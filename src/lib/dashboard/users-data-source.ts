import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import type { DashboardUser } from '@/types';
import type { UsersDataSource } from './users-repository';

/**
 * Adaptador Supabase (`service_role`) de los usuarios internos — server-only.
 *
 * Solo LEE `dashboard_users`; el alta y la baja se hacen a mano por SQL (ver
 * docs/SETUP.md). El `password_hash` sale de aqui hacia el repositorio puro y
 * no viaja mas alla: ninguna vista ni endpoint lo devuelve al navegador.
 */
const USER_COLUMNS = 'id,username,password_hash,role,is_active,created_at,updated_at';

/**
 * Neutraliza los comodines de LIKE en lo que teclea el usuario.
 *
 * Sin esto, teclear `%` como nombre de usuario haria match con CUALQUIER fila y
 * la consulta devolveria la primera cuenta de la tabla. El backslash es el
 * caracter de escape por defecto de LIKE en Postgres.
 *
 * El repositorio ademas exige coincidencia EXACTA del nombre devuelto, asi que
 * esto es la primera de dos barreras, no la unica.
 */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export function createSupabaseUsersDataSource(
  client: SupabaseClient = getSupabaseAdmin(),
): UsersDataSource {
  return {
    async findByUsername(username): Promise<DashboardUser | null> {
      // `ilike` y no `eq`: el nombre se guarda tal como se dio de alta (con sus
      // mayusculas), pero el login no debe distinguirlas. El indice unico de la
      // migracion 0020 es sobre `lower(username)`, que garantiza que como mucho
      // una fila puede coincidir sin distinguir caja.
      const { data, error } = await client
        .from('dashboard_users')
        .select(USER_COLUMNS)
        .ilike('username', escapeLikePattern(username))
        .eq('is_active', true)
        .limit(1);
      if (error) throw new Error('users_lookup_failed');
      return ((data ?? [])[0] as DashboardUser | undefined) ?? null;
    },
  };
}
