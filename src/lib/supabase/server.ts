import 'server-only';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getServerEnv } from '@/lib/env/env';

/**
 * Cliente de Supabase con `service_role` — SOLO backend.
 *
 * - Nunca debe importarse desde componentes cliente (el `import 'server-only'`
 *   lo garantiza en build).
 * - `service_role` omite RLS; por eso las tablas tienen RLS habilitado sin
 *   políticas públicas (ver migración 0001).
 * - La validación de entorno es lazy: ocurre aquí, la primera vez que se
 *   construye el cliente, no en build.
 */
let client: SupabaseClient | null = null;

export function getSupabaseAdmin(): SupabaseClient {
  if (client) return client;

  const env = getServerEnv();
  client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  return client;
}
