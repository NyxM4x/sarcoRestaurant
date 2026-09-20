import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  ClaimMenuDeliveryInput,
  ClaimMenuDeliveryResult,
  FinishMenuDeliveryInput,
  MenuDeliveryStatus,
  MenuDeliveryStore,
} from './dispatch';

/**
 * Ledger de envíos del menú sobre Supabase (server-only, Fase 6D.2F.5A).
 *
 * Es la autoridad del efecto: mientras el resto del despacho es lógica pura,
 * aquí ocurre la única operación que decide si alguien puede llamar a Kapso.
 *
 * Requiere la migración 0015 aplicada. Sin la tabla, `claim` lanza y el evento
 * queda `failed` (reintentable) — se prefiere no enviar a enviar sin control.
 */
export function createMenuDeliveryStore(supabase: SupabaseClient): MenuDeliveryStore {
  return {
    async claim(input: ClaimMenuDeliveryInput): Promise<ClaimMenuDeliveryResult> {
      // `ignoreDuplicates` = ON CONFLICT DO NOTHING sobre el UNIQUE de
      // source_message_id, en una sola sentencia ATÓMICA. Un
      // comprobar-y-luego-insertar dejaría abierta la ventana por la que se
      // colaría el segundo CTA.
      const inserted = await supabase
        .from('menu_send_deliveries')
        .upsert(
          {
            customer_phone: input.customerPhone,
            source_message_id: input.sourceMessageId,
            reason: input.reason,
            status: 'pending',
            claimed_at: input.claimedAt,
          },
          { onConflict: 'source_message_id', ignoreDuplicates: true },
        )
        .select('id');

      if (inserted.error) throw new Error(`menu.claimDelivery: ${inserted.error.message}`);
      if ((inserted.data?.length ?? 0) > 0) {
        return { result: 'claimed', deliveryId: inserted.data![0].id as string };
      }

      // Cero filas = ya existía. Se devuelve su estado para que el despacho
      // sepa QUÉ pasó con aquel intento, sin volver a enviar nada.
      const existing = await supabase
        .from('menu_send_deliveries')
        .select('id, status')
        .eq('source_message_id', input.sourceMessageId)
        .single();

      if (existing.error) throw new Error(`menu.claimDelivery(read): ${existing.error.message}`);
      return {
        result: 'exists',
        deliveryId: existing.data.id as string,
        status: existing.data.status as MenuDeliveryStatus,
      };
    },

    /**
     * Cuándo salió el último botón a este teléfono (20-09-2026).
     *
     * Solo `sent`: un intento fallido no llegó a la pantalla de nadie, y
     * contarlo dejaría al cliente sin el botón por un error nuestro. Se mira
     * `completed_at`, que es cuando Kapso aceptó el envío — `claimed_at` sería
     * cuando empezamos a intentarlo.
     *
     * `null` ante cualquier fallo de lectura: sin dato no hay eco, y el botón
     * sale como salía antes de existir esta ventana.
     */
    async lastSentAt(customerPhone: string): Promise<string | null> {
      try {
        const { data, error } = await supabase
          .from('menu_send_deliveries')
          .select('completed_at')
          .eq('customer_phone', customerPhone)
          .eq('status', 'sent')
          .not('completed_at', 'is', null)
          .order('completed_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (error || !data) return null;
        const valor = (data as { completed_at: unknown }).completed_at;
        return typeof valor === 'string' ? valor : null;
      } catch {
        return null;
      }
    },

    async finish(input: FinishMenuDeliveryInput): Promise<void> {
      const { error } = await supabase
        .from('menu_send_deliveries')
        .update({
          status: input.status,
          completed_at: input.completedAt,
          provider_message_id: input.providerMessageId ?? null,
          error_code: input.errorCode ?? null,
        })
        .eq('id', input.deliveryId);

      if (error) throw new Error(`menu.finishDelivery: ${error.message}`);
    },
  };
}
