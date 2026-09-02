import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import type { MenuCategory } from '@/types';
import type { Promotion, PromotionComponent, PromotionDraft } from './promotion';

/**
 * Lectura y escritura de promociones — server-only.
 *
 * Traduce a Supabase lo que deciden `./promotion` (las reglas) y las Server
 * Actions (los permisos). Ninguna regla de negocio vive aquí: este módulo no
 * sabe qué es un ahorro ni cuándo un combo es vendible.
 *
 * ── El precio normal no se consulta, se deriva ──────────────────────────────
 *
 * Se traen los componentes con el precio VIGENTE de `menu_items` y el cálculo
 * lo hace `evaluatePromotion` en memoria. Podría pedirse a
 * `promotion_availability`, pero eso sería una llamada por promoción y el panel
 * las lista todas: con diez combos serían once viajes a la base para pintar una
 * pantalla.
 *
 * La función SQL sigue siendo la autoridad —es la que gobierna el cobro dentro
 * de la transacción del pedido—, y las dos implementan la misma regla. Aquí se
 * usa la de TypeScript porque esto solo PINTA.
 */

/** Lo que se lee de una promoción y sus componentes, en un solo viaje. */
const PROMOTION_SELECT =
  'id,name,description,promo_price,image_url,starts_at,ends_at,is_active,revision,updated_at,' +
  'promotion_items(quantity,menu_items(id,code,name,category,price,is_active))';

interface RawPromotionRow {
  id: string;
  name: string;
  description: string | null;
  promo_price: number | string;
  image_url: string | null;
  starts_at: string | null;
  ends_at: string | null;
  is_active: boolean;
  revision: number;
  updated_at: string;
  promotion_items: Array<{
    quantity: number;
    menu_items: {
      id: string;
      code: string;
      name: string;
      category: MenuCategory;
      price: number | string;
      is_active: boolean;
    } | null;
  }> | null;
}

/**
 * `numeric` de PostgreSQL llega como cadena según el driver. Convertir con
 * `Number` sin comprobar dejaría un `NaN` circulando hasta la pantalla.
 */
function toNumber(value: unknown): number {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}

function toPromotion(raw: RawPromotionRow): Promotion {
  const components: PromotionComponent[] = (raw.promotion_items ?? [])
    // Un componente sin producto no debería existir (la FK lo impide), pero un
    // `left join` que devuelva null no puede romper la pantalla del encargado.
    .filter((pi): pi is typeof pi & { menu_items: NonNullable<typeof pi.menu_items> } =>
      pi.menu_items !== null,
    )
    .map((pi) => ({
      menuItemId: pi.menu_items.id,
      code: pi.menu_items.code,
      name: pi.menu_items.name,
      category: pi.menu_items.category,
      unitPrice: toNumber(pi.menu_items.price),
      quantity: pi.quantity,
      isActive: pi.menu_items.is_active,
    }))
    // Orden del catálogo y no el que devuelva la base: la composición que ve el
    // cliente tiene que leerse en el mismo orden en el que los productos
    // aparecen más abajo en el menú, y ser igual en cada carga.
    .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));

  return {
    id: raw.id,
    name: raw.name,
    description: raw.description,
    promoPrice: toNumber(raw.promo_price),
    imageUrl: raw.image_url,
    startsAt: raw.starts_at,
    endsAt: raw.ends_at,
    isActive: raw.is_active,
    revision: raw.revision,
    updatedAt: raw.updated_at,
    components,
  };
}

export interface PromotionsRepository {
  /** Todas, para el panel: incluidas las apagadas, vencidas y rotas. */
  list(): Promise<Promotion[]>;
  /** Una sola, o `null`. */
  find(id: string): Promise<Promotion | null>;
  /** Crea la promoción APAGADA y devuelve su id. */
  create(draft: PromotionDraft): Promise<string>;
  /**
   * Edita. `expectedRevision` es el control optimista: si no coincide, nadie
   * escribe y se devuelve `'stale'`.
   */
  update(
    id: string,
    draft: PromotionDraft,
    expectedRevision: number,
  ): Promise<'ok' | 'stale' | 'not_found'>;
  /** Enciende o apaga. Determinista: nunca invierte lo que encuentre. */
  setActive(id: string, active: boolean): Promise<'ok' | 'not_found'>;
}

export function createPromotionsRepository(
  client: SupabaseClient = getSupabaseAdmin(),
): PromotionsRepository {
  /** Reescribe los componentes: se borran los de antes y se insertan los nuevos. */
  async function replaceComponents(
    promotionId: string,
    components: PromotionDraft['components'],
  ): Promise<void> {
    const { error: delError } = await client
      .from('promotion_items')
      .delete()
      .eq('promotion_id', promotionId);
    if (delError) throw new Error('promotion_components_clear_failed');

    if (components.length === 0) return;

    const { error: insError } = await client.from('promotion_items').insert(
      components.map((c) => ({
        promotion_id: promotionId,
        menu_item_id: c.menuItemId,
        quantity: c.quantity,
      })),
    );
    if (insError) throw new Error('promotion_components_insert_failed');
  }

  return {
    async list() {
      const { data, error } = await client
        .from('promotions')
        .select(PROMOTION_SELECT)
        .order('created_at', { ascending: false });
      if (error) throw new Error('promotions_list_failed');
      return ((data ?? []) as unknown as RawPromotionRow[]).map(toPromotion);
    },

    async find(id) {
      const { data, error } = await client
        .from('promotions')
        .select(PROMOTION_SELECT)
        .eq('id', id)
        .maybeSingle();
      if (error) throw new Error('promotion_find_failed');
      return data === null ? null : toPromotion(data as unknown as RawPromotionRow);
    },

    async create(draft) {
      // `is_active` NO se acepta del formulario: una promoción nueva nace
      // apagada siempre, y encenderla es un acto aparte y explícito.
      const { data, error } = await client
        .from('promotions')
        .insert({
          name: draft.name.trim(),
          description: draft.description,
          promo_price: draft.promoPrice,
          starts_at: draft.startsAt,
          ends_at: draft.endsAt,
          is_active: false,
        })
        .select('id')
        .single();
      if (error) throw new Error('promotion_create_failed');

      const id = (data as { id: string }).id;
      await replaceComponents(id, draft.components);
      return id;
    },

    async update(id, draft, expectedRevision) {
      // El `eq('revision', …)` ES el control optimista: si otra sesión guardó
      // entre medias, la revisión ya subió (trigger de 0031), no hay fila que
      // actualizar y no se pisa nada. No es un SELECT seguido de UPDATE — eso
      // tendría una ventana entre los dos pasos.
      const { data, error } = await client
        .from('promotions')
        .update({
          name: draft.name.trim(),
          description: draft.description,
          promo_price: draft.promoPrice,
          starts_at: draft.startsAt,
          ends_at: draft.endsAt,
        })
        .eq('id', id)
        .eq('revision', expectedRevision)
        .select('id');
      if (error) throw new Error('promotion_update_failed');

      if ((data ?? []).length === 0) {
        // Ninguna fila: o no existe, o la revisión ya no es esa. Se distingue
        // para poder decirle a quien edita cuál de las dos cosas pasó.
        const { data: existe } = await client
          .from('promotions')
          .select('id')
          .eq('id', id)
          .maybeSingle();
        return existe === null ? 'not_found' : 'stale';
      }

      await replaceComponents(id, draft.components);
      return 'ok';
    },

    async setActive(id, active) {
      // Se escribe el valor PEDIDO, no lo contrario de lo que haya. Dos
      // peticiones idénticas dejan el mismo estado: pulsar dos veces "activar"
      // no puede acabar apagándola.
      const { data, error } = await client
        .from('promotions')
        .update({ is_active: active })
        .eq('id', id)
        .select('id');
      if (error) throw new Error('promotion_set_active_failed');
      return (data ?? []).length === 0 ? 'not_found' : 'ok';
    },
  };
}
