import 'server-only';
import type { SupabaseClient, PostgrestError } from '@supabase/supabase-js';
import type { MenuSession } from '@/types';

/**
 * Repositorio de sesiones de menú sobre Supabase (server-only).
 *
 * Persiste y recupera las sesiones temporales que se envían al cliente en la
 * URL del CTA.
 *
 * Idempotencia + Integridad:
 * - getOrCreate() intenta INSERT. Si conflicto UNIQUE por source_message_id,
 *   recupera la sesión existente y valida que los datos sean idénticos.
 * - No modifica silenciosamente una sesión existente (sesiones inmutables).
 * - Renueva expires_at si la sesión actual está vencida (reintento tardío).
 */

export class MenuSessionIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MenuSessionIntegrityError';
  }
}

export function createMenuSessionRepository(supabase: SupabaseClient) {
  return {
    /**
     * Crea una nueva sesión o retorna la existente (idempotente, con validación).
     *
     * Algoritmo:
     * 1. Intenta INSERT con source_message_id.
     * 2. Si conflicto UNIQUE (código 23505), recupera la fila existente.
     * 3. Valida que token_hash, customer_phone, phone_number_id coincidan.
     * 4. Si no coinciden: error de integridad (datos inconsistentes).
     * 5. Si vencida: renueva expires_at, mantiene token_hash.
     * 6. Devuelve la sesión (nueva o recuperada + renovada).
     */
    async getOrCreate(input: {
      source_message_id: string;
      token_hash: string;
      customer_phone: string;
      phone_number_id: string;
    }): Promise<MenuSession> {
      // 1. Intentar INSERT
      const { data: insertData, error: insertError } = await supabase
        .from('menu_sessions')
        .insert({
          source_message_id: input.source_message_id,
          token_hash: input.token_hash,
          customer_phone: input.customer_phone,
          phone_number_id: input.phone_number_id,
        })
        .select()
        .single();

      // Sin error: sesión nueva creada
      if (!insertError) {
        if (!insertData) throw new Error('session.getOrCreate: no data after insert');
        return insertData as MenuSession;
      }

      // 2. Verificar si es conflicto UNIQUE por source_message_id
      const isUniqueConflict = (insertError as PostgrestError & { code?: string }).code === '23505';
      if (!isUniqueConflict) {
        throw new Error(`session.getOrCreate (insert): ${insertError.message}`);
      }

      // 3. Recuperar la sesión existente
      const { data: existing, error: selectError } = await supabase
        .from('menu_sessions')
        .select()
        .eq('source_message_id', input.source_message_id)
        .maybeSingle();

      if (selectError) throw new Error(`session.getOrCreate (select existing): ${selectError.message}`);
      if (!existing) throw new Error('session.getOrCreate: conflicto detectado pero fila no encontrada');

      const existingSession = existing as MenuSession;

      // 4. Validar que los datos sean idénticos (sesiones inmutables)
      if (
        existingSession.token_hash !== input.token_hash ||
        existingSession.customer_phone !== input.customer_phone ||
        existingSession.phone_number_id !== input.phone_number_id
      ) {
        throw new MenuSessionIntegrityError(
          `session integrity violation: source_message_id=${input.source_message_id} ` +
            `has conflicting data (token_hash, customer_phone, or phone_number_id differ)`,
        );
      }

      // 5. Si vencida: renovar expires_at, mantener token_hash intacto
      const now = new Date();
      const expiresAt = new Date(existingSession.expires_at);
      if (expiresAt <= now) {
        const newExpiresAt = new Date(now.getTime() + 2 * 60 * 60 * 1000); // now + 2 horas
        const { data: renewed, error: renewError } = await supabase
          .from('menu_sessions')
          .update({ expires_at: newExpiresAt.toISOString() })
          .eq('id', existingSession.id)
          .select()
          .single();

        if (renewError) throw new Error(`session.getOrCreate (renew): ${renewError.message}`);
        if (!renewed) throw new Error('session.getOrCreate: no data after renew');
        return renewed as MenuSession;
      }

      // 6. Sesión válida y con datos consistentes: devolverla
      return existingSession;
    },

    /**
     * Busca una sesión válida (no vencida) por su hash.
     *
     * Devuelve `null` si no existe, si está vencida, o si ocurre un error DB.
     */
    async findByHash(tokenHash: string): Promise<MenuSession | null> {
      const { data, error } = await supabase
        .from('menu_sessions')
        .select()
        .eq('token_hash', tokenHash)
        .gt('expires_at', new Date().toISOString())
        .maybeSingle();

      if (error) throw new Error(`session.findByHash: ${error.message}`);
      return (data as MenuSession) ?? null;
    },

    /**
     * Devuelve solo el id de una sesión vigente, o `null`.
     *
     * Variante mínima de `findByHash` para el checkout web: proyecta únicamente
     * `id`, de modo que `customer_phone`, `phone_number_id` y `token_hash` nunca
     * salen de la base hacia la capa HTTP. El teléfono lo lee directamente la
     * RPC `create_order_web` desde `menu_sessions`.
     *
     * El error es genérico a propósito: no debe filtrar el hash consultado ni
     * ningún dato de la sesión.
     */
    async findValidIdByHash(tokenHash: string): Promise<string | null> {
      const { data, error } = await supabase
        .from('menu_sessions')
        .select('id')
        .eq('token_hash', tokenHash)
        .gt('expires_at', new Date().toISOString())
        .maybeSingle();

      if (error) throw new Error('session.findValidIdByHash: lookup failed');
      return (data as { id: string } | null)?.id ?? null;
    },

    /**
     * Busca la sesión VIGENTE (no vencida) más reciente de un teléfono (6D.2E).
     *
     * Sirve para reutilizar una sesión aún válida en vez de crear una nueva por
     * cada solicitud de menú del mismo cliente (evita llenar la tabla). Ordena por
     * `expires_at` desc para elegir de forma determinista la de mayor vigencia.
     * Devuelve la fila completa (incluye `source_message_id`, con el que se puede
     * regenerar el token de forma reproducible). `null` si no hay ninguna vigente.
     */
    async findValidByPhone(customerPhone: string): Promise<MenuSession | null> {
      const { data, error } = await supabase
        .from('menu_sessions')
        .select()
        .eq('customer_phone', customerPhone)
        .gt('expires_at', new Date().toISOString())
        .order('expires_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error) throw new Error('session.findValidByPhone: lookup failed');
      return (data as MenuSession) ?? null;
    },

    /**
     * ¿La sesión ya fue CONSUMIDA por un pedido? (6D.2E.final)
     *
     * `orders.menu_session_id` es UNIQUE (0003) y `create_order_web_*` bloquea con
     * P1003 un segundo carrito distinto sobre la misma sesión: una sesión es
     * efectivamente single-use. Por eso NO debe reutilizarse una sesión que ya
     * tiene pedido — el cliente no podría crear el segundo pedido. Proyecta solo
     * `id` (sin datos del pedido) y devuelve un booleano.
     */
    async sessionHasOrder(menuSessionId: string): Promise<boolean> {
      const { data, error } = await supabase
        .from('orders')
        .select('id')
        .eq('menu_session_id', menuSessionId)
        .limit(1)
        .maybeSingle();

      if (error) throw new Error('session.sessionHasOrder: lookup failed');
      return data != null;
    },

    /**
     * Busca una sesión por source_message_id (independientemente de expiración).
     *
     * Útil para validar que el token existe y para renovar si está vencida.
     */
    async findBySourceMessageId(sourceMessageId: string): Promise<MenuSession | null> {
      const { data, error } = await supabase
        .from('menu_sessions')
        .select()
        .eq('source_message_id', sourceMessageId)
        .maybeSingle();

      if (error) throw new Error(`session.findBySourceMessageId: ${error.message}`);
      return (data as MenuSession) ?? null;
    },
  };
}

export type MenuSessionRepository = ReturnType<typeof createMenuSessionRepository>;
