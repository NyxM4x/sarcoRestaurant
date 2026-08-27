import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseAdmin } from '@/lib/supabase/server';

/**
 * Ajustes operativos del delivery — server-only (migración 0024).
 *
 * Hoy solo el recargo por lluvia. Vive APARTE de `quote-service.ts` a propósito:
 * aquel módulo ensambla el orquestador entero —Supabase, Kapso, Mapbox,
 * Telegram, las notificaciones— y basta importarlo para arrastrar todo eso.
 *
 * Quien necesita leer o escribir este interruptor es la Server Action del panel,
 * de la que dependen cinco componentes de cliente. Colgarles ese grafo de
 * imports para escribir un booleano es caro de compilar y frágil: cualquier
 * módulo `server-only` que aparezca en esa cadena puede romper el build del
 * cliente, y el error que se obtiene no señala al import que lo causó.
 *
 * Aquí solo hay dos consultas a una tabla de una fila.
 */

/** Fila única de `delivery_settings`, fijada por un CHECK en la migración. */
const SETTINGS_ID = 1;

/**
 * ¿Está activa la tarifa de lluvia (+3 Bs)?
 *
 * Fail-safe hacia ABAJO: si la fila no está o la consulta falla, devuelve
 * `false` y se cobra la tarifa normal. Cobrar 3 Bs de más por un fallo nuestro
 * es un problema con el cliente delante; cobrarlos de menos es una pérdida
 * nuestra que se corrige sola en la siguiente cotización.
 */
export async function readRainSurcharge(
  supabase: SupabaseClient = getSupabaseAdmin(),
): Promise<boolean> {
  const { data, error } = await supabase
    .from('delivery_settings')
    .select('rain_surcharge_active')
    .eq('id', SETTINGS_ID)
    .maybeSingle();
  if (error || !data) return false;
  return data.rain_surcharge_active === true;
}

/** Enciende o apaga la tarifa de lluvia. `false` si no se pudo escribir. */
export async function setRainSurcharge(
  active: boolean,
  supabase: SupabaseClient = getSupabaseAdmin(),
): Promise<boolean> {
  const { error } = await supabase
    .from('delivery_settings')
    .update({ rain_surcharge_active: active, updated_at: new Date().toISOString() })
    .eq('id', SETTINGS_ID);
  return !error;
}
