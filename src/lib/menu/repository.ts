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

    /**
     * TODOS los productos, activos y retirados, en el orden del menú.
     *
     * Es la vista del PANEL, no la del cliente: para gestionar disponibilidad y
     * para validar una promoción hace falta ver también lo retirado. Si aquí
     * solo llegaran los activos, un combo con un producto agotado se reportaría
     * como `unknown_component` —"ese producto no existe"— cuando lo cierto
     * es que existe y está agotado, que es un problema distinto y con otra
     * solución.
     */
    async listAll(): Promise<MenuItem[]> {
      const { data, error } = await supabase
        .from('menu_items')
        .select('*')
        .order('sort_order', { ascending: true });

      if (error) throw new Error(`menu.listAll: ${error.message}`);
      return (data ?? []) as MenuItem[];
    },

    /**
     * Pone un producto a la venta o lo retira. `false` si no existe.
     *
     * Se escribe el valor PEDIDO, no lo contrario de lo que haya: dos toques
     * seguidos —o un reintento por red lenta— dejan el mismo resultado. Un
     * "invertir lo que encuentres" podría volver a poner a la venta algo que
     * se acaba de agotar.
     *
     * Retirar un producto NO lo borra: los pedidos históricos lo referencian y
     * la promoción que lo incluya seguirá existiendo, apagada, hasta que vuelva.
     */
    async setActive(id: string, active: boolean): Promise<boolean> {
      const { data, error } = await supabase
        .from('menu_items')
        .update({ is_active: active })
        .eq('id', id)
        .select('id');

      if (error) throw new Error(`menu.setActive: ${error.message}`);
      return (data ?? []).length > 0;
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
