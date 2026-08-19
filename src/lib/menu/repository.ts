import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { MenuItem } from '@/types';

/**
 * Repositorio de menú sobre Supabase (server-only).
 *
 * Fuente de verdad de precios (IDEA.md §3, §9): nunca se confía en precios
 * enviados desde el teléfono del cliente.
 */
export function createMenuRepository(supabase: SupabaseClient) {
  return {
    /** Productos activos ordenados por `sort_order`. */
    async listActive(): Promise<MenuItem[]> {
      const { data, error } = await supabase
        .from('menu_items')
        .select('*')
        .eq('is_active', true)
        .order('sort_order', { ascending: true });

      if (error) throw new Error(`menu.listActive: ${error.message}`);
      return (data ?? []) as MenuItem[];
    },

    /** Productos activos filtrados por `code`. */
    async findActiveByCodes(codes: string[]): Promise<MenuItem[]> {
      if (codes.length === 0) return [];
      const { data, error } = await supabase
        .from('menu_items')
        .select('*')
        .eq('is_active', true)
        .in('code', codes);

      if (error) throw new Error(`menu.findActiveByCodes: ${error.message}`);
      return (data ?? []) as MenuItem[];
    },
  };
}

export type MenuRepository = ReturnType<typeof createMenuRepository>;
