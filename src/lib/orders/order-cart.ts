import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import { log } from '@/lib/log';
import type { CartState } from '@/lib/cart/cart';

/**
 * El pedido, de vuelta en el carrito — server-only (0035).
 *
 * Lo usa el menú cuando el cliente entra por el botón "Cambiar mi pedido": sin
 * esto tendría que rearmar de cero los cinco productos que ya había elegido
 * para añadir una soda, y nadie hace eso — volvería a escribir por WhatsApp,
 * que es justo lo que este camino viene a evitar.
 *
 * ── Se leen los CÓDIGOS, no los precios ─────────────────────────────────────
 *
 * Solo salen de aquí `product_code` y `quantity`. Los precios los vuelve a leer
 * `create_order_web_v4` en el momento de confirmar, igual que en un pedido
 * normal: entre el pedido viejo y el corregido pueden haber cambiado, y el que
 * vale es el de ahora. Cargar los snapshots del pedido anterior sería
 * congelarle un precio que ya no existe.
 *
 * ── Y por qué los combos viajan aparte ──────────────────────────────────────
 *
 * Porque son otro carrito: `usePromoCart` tiene su propia clave en el navegador
 * y su propio cálculo. Un combo que ya no esté publicable simplemente no se
 * sembrará —el cliente lo verá al mirar su carrito— y el checkout lo rechazaría
 * de todas formas con su propio mensaje.
 */

export interface OrderCart {
  /** Número del pedido que se está cambiando. Se le muestra al cliente. */
  orderNumber: string;
  /** Productos: `{ código: cantidad }`, la forma exacta del carrito. */
  items: CartState;
  /** Combos: `{ promotion_id: cantidad }`. */
  promotions: CartState;
}

/**
 * Carga el pedido como carrito. `null` si no existe o no se pudo leer.
 *
 * NUNCA lanza: si esto falla, el menú se abre igual y vacío. Que el cliente
 * tenga que rearmar es peor que hoy, pero mucho mejor que una pantalla de error
 * cuando lo único que quería era añadir una soda.
 */
export async function loadOrderCart(
  orderId: string,
  supabase: SupabaseClient = getSupabaseAdmin(),
): Promise<OrderCart | null> {
  try {
    const { data: pedido, error: errorPedido } = await supabase
      .from('orders')
      .select('order_number')
      .eq('id', orderId)
      .maybeSingle();

    if (errorPedido || !pedido) return null;

    const { data: lineas, error: errorLineas } = await supabase
      .from('order_items')
      .select('product_code, quantity')
      .eq('order_id', orderId);

    if (errorLineas) return null;

    const items: Record<string, number> = {};
    for (const fila of (lineas ?? []) as Array<{ product_code: string; quantity: number }>) {
      // Se ACUMULA en vez de asignar: si un pedido viejo trajera el mismo código
      // en dos filas, quedarse con la última perdería unidades.
      items[fila.product_code] = (items[fila.product_code] ?? 0) + Number(fila.quantity);
    }

    const { data: combos } = await supabase
      .from('order_promotions')
      .select('promotion_id, quantity')
      .eq('order_id', orderId);

    const promotions: Record<string, number> = {};
    for (const fila of (combos ?? []) as Array<{
      promotion_id: string | null;
      quantity: number;
    }>) {
      // `promotion_id` es nullable: si la promoción se borró, la línea histórica
      // sobrevive sin ella y no hay nada que volver a poner en el carrito.
      if (!fila.promotion_id) continue;
      promotions[fila.promotion_id] =
        (promotions[fila.promotion_id] ?? 0) + Number(fila.quantity);
    }

    return {
      orderNumber: (pedido as { order_number: string }).order_number,
      items,
      promotions,
    };
  } catch {
    // Sin `error.message`: puede traer detalle técnico de Supabase.
    log.warn('order_cart_load_failed');
    return null;
  }
}
