import 'server-only';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import { createSupabaseIntakeDataSource } from './intake-data-source';

/**
 * Abrir revisión sobre un comprobante SUELTO — wiring server-only.
 *
 * ── El callejón sin salida que esto abre ────────────────────────────────────
 *
 * Un comprobante puede quedar unido a su pedido pero SIN intento de revisión.
 * Pasa por varios caminos legítimos: el cliente reenvía el mismo archivo y se
 * marca `duplicate`, o el enrutado encuentra una excepción. La fila se guarda,
 * el panel la enseña —"Comprobante sin asociar a un intento"— y hasta hoy ahí
 * se acababa todo: no existía ningún botón, en ninguna pantalla, capaz de
 * convertir ese archivo en un pago aceptable.
 *
 * El 03-09-2026 un cliente mandó su comprobante dos veces —había pagado de más
 * y quería avisarlo—. El segundo llegó como duplicado, quien cocinaba se
 * encontró el comprobante delante y ningún botón con el que aceptarlo, y el
 * pedido acabó borrándose y atendiéndose por WhatsApp a mano. El dinero estaba
 * pagado y el archivo estaba guardado: lo único que faltaba era poder decir
 * "este sirve".
 *
 * ── Lo que esta acción NO hace ──────────────────────────────────────────────
 *
 * No mueve el comprobante de pedido, no acepta el pago y no avisa al cliente.
 * Solo abre —o reutiliza— el episodio de revisión del pedido que el comprobante
 * YA tenía, para que aparezcan CONFIRMAR y RECHAZAR y decida una persona. La
 * decisión sigue siendo de quien mira la imagen.
 */

export type LooseProofOutcome =
  | { ok: true; attemptId: string }
  | {
      ok: false;
      reason:
        /** No existe esa fila. */
        | 'not_found'
        /** El comprobante no está unido a ningún pedido: no hay qué revisar. */
        | 'no_order'
        /** Ya pertenece a un intento; sus botones son los de ese intento. */
        | 'already_linked'
        /** El pedido ya tiene un pago aceptado. Reabrir la revisión sería ruido. */
        | 'already_paid'
        | 'error';
    };

export async function openAttemptForLooseProof(proofId: string): Promise<LooseProofOutcome> {
  try {
    const supabase = getSupabaseAdmin();

    const { data, error } = await supabase
      .from('payment_proofs')
      .select('id,order_id,attempt_id')
      .eq('id', proofId)
      .maybeSingle();
    if (error) return { ok: false, reason: 'error' };
    if (!data) return { ok: false, reason: 'not_found' };

    const fila = data as { order_id: string | null; attempt_id: string | null };
    // Ya tiene episodio: no se abre otro. Sus botones son los de ese intento, y
    // duplicarlo partiría en dos la historia de un mismo pago.
    if (fila.attempt_id !== null) return { ok: false, reason: 'already_linked' };
    // Sin pedido no hay nada que revisar: no se sabe contra qué monto contrastar
    // ni a quién avisar. Esos se resuelven eligiendo pedido, que es otra acción.
    if (fila.order_id === null) return { ok: false, reason: 'no_order' };

    // Un pedido ya pagado no vuelve a revisión. El reenvío queda registrado —es
    // lo que hace útil el archivo— pero abrir un intento nuevo pondría en
    // pendiente un pago que alguien ya aceptó, y eso se lee como un problema.
    const { data: aceptados, error: errorAceptados } = await supabase
      .from('payment_attempts')
      .select('id')
      .eq('order_id', fila.order_id)
      .eq('review_status', 'accepted')
      .limit(1);
    if (errorAceptados) return { ok: false, reason: 'error' };
    if ((aceptados ?? []).length > 0) return { ok: false, reason: 'already_paid' };

    // El MISMO puerto que usa la captura: reutiliza el episodio pendiente del
    // pedido si lo hay, y si no abre uno. Reimplementarlo aquí sería tener dos
    // formas distintas de abrir un intento, y un día diferirían.
    const attemptId = await createSupabaseIntakeDataSource(supabase).attachToAttempt(
      proofId,
      fila.order_id,
    );
    return attemptId === null ? { ok: false, reason: 'error' } : { ok: true, attemptId };
  } catch {
    // Error de base sanitizado: nunca se expone SQL ni stack al navegador.
    return { ok: false, reason: 'error' };
  }
}
