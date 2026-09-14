import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { log } from '@/lib/log';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import { NORMAL_MODE, promoModeAt, type PromoMode } from './promo-mode';
import { createPromotionsRepository } from './repository';

/**
 * El modo del menú AHORA, leído de la base — server-only (14-09-2026).
 *
 * Lo usan las tres puertas que no son el menú: el checkout del servidor, el
 * botón de WhatsApp y el agente. El menú no pasa por aquí porque ya tiene las
 * promociones cargadas y su propio reloj.
 *
 * Nunca lanza. Si las promociones no se pueden leer devuelve el menú de
 * siempre, que es lo mismo que ve el cliente en ese caso: `menu/page.tsx`
 * también se queda sin combos cuando esa lectura falla.
 */
export async function readCurrentPromoMode(
  client: SupabaseClient = getSupabaseAdmin(),
): Promise<PromoMode> {
  try {
    const promotions = await createPromotionsRepository(client).list();
    return promoModeAt(promotions, Date.now());
  } catch (error) {
    log.error('promotions.current_mode_failed', {
      error: error instanceof Error ? error.message : 'unknown',
    });
    return NORMAL_MODE;
  }
}
