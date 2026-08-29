import 'server-only';
import { getKapsoClient } from '@/lib/kapso/client';
import { notifyDeliveryGroup } from '@/lib/alerts/delivery-notice-service';
import { pauseAgentAfterPaymentReview as pauseAgentAfterReview } from '@/lib/agent/service';
import {
  createSupabaseProofsDataSource,
  type ProofsDataSource,
} from '@/lib/dashboard/proofs-data-source';
import { paymentDecisionText } from './notify-text';
import {
  shouldNotifyCustomer,
  toReviewResult,
  type ReviewDecision,
  type ReviewResult,
} from './review-result';

/**
 * Flujo de decisión de un pago — server-only.
 *
 * Orquesta tres cosas en un orden que importa:
 *
 *   1. La RPC decide (CAS atómico). La base es la fuente de verdad.
 *   2. SOLO si esta llamada ganó, se avisa al cliente por WhatsApp.
 *   3. Un fallo del aviso NO revierte la decisión.
 *
 * ── Por qué el WhatsApp va después y nunca revierte ─────────────────────────
 *
 * Si se enviara antes, un fallo al persistir dejaría al cliente con un "pago
 * confirmado" que la base no respalda. Y si un error de red revirtiera la
 * decisión, dos operadores podrían decidir en bucle sobre el mismo pago.
 *
 * Cuando el envío falla, la decisión queda firme y el resultado lo dice
 * (`notification: 'failed'`) para que el panel avise al operador de que
 * contacte al cliente a mano. Perder un mensaje es recuperable; perder la
 * decisión, o mandarla dos veces, no.
 *
 * ── El teléfono nunca viene del navegador ───────────────────────────────────
 *
 * Se lee en servidor a partir del `order_id` que devuelve la propia RPC. Si la
 * acción aceptara un teléfono del cliente, cualquiera con sesión podría hacer
 * que el sistema mandara mensajes a un número arbitrario.
 */

export interface DecideDeps {
  source: ProofsDataSource;
  /** Envía el texto al cliente. Inyectable para poder probar sin red. */
  sendText(phone: string, text: string): Promise<{ ok: boolean }>;
  /**
   * Avisa al grupo de reparto. Opcional: sin él la decisión funciona igual y no
   * se manda nada, que es lo que necesitan los tests para no tocar Telegram.
   * Nunca lanza y su resultado no altera la decisión.
   */
  notifyDeliveryGroup?(orderId: string): Promise<void>;
  /**
   * Calla al agente tras la decisión. Mismas reglas que el aviso al reparto:
   * opcional —los tests no tocan Supabase—, nunca lanza y no altera nada.
   */
  pauseAgentAfterReview?(customerPhone: string): Promise<void>;
}

function defaultDeps(): DecideDeps {
  return {
    source: createSupabaseProofsDataSource(),
    async sendText(phone, text) {
      try {
        const res = await getKapsoClient().sendText(phone, text);
        return { ok: res.ok };
      } catch {
        // Kapso mal configurado o caído: es un fallo de aviso, no de decisión.
        return { ok: false };
      }
    },
    notifyDeliveryGroup,
    pauseAgentAfterReview,
  };
}

/**
 * Decide un intento y avisa al cliente si corresponde.
 *
 * Nunca lanza: cualquier fallo se traduce a un `ReviewResult` saneado. El
 * navegador no ve SQL, ni stack, ni el teléfono del cliente.
 */
export async function decidePaymentAttempt(
  attemptId: string,
  decision: ReviewDecision,
  deps: DecideDeps = defaultDeps(),
): Promise<ReviewResult> {
  let row;
  try {
    row = await deps.source.decide(attemptId, decision);
  } catch {
    return { ok: false, reason: 'error' };
  }

  if (!row) return { ok: false, reason: 'error' };

  // `repeated` y `conflict` NO avisan: el primero ya avisó en su momento, y el
  // segundo mandaría un mensaje que contradice la decisión que realmente ganó.
  if (!shouldNotifyCustomer(row.outcome)) {
    return toReviewResult(row);
  }

  // Ganamos: toca avisar exactamente una vez.
  let notification: 'sent' | 'failed' = 'failed';
  const orderId = row.order_id ?? null;
  let customerPhone: string | null = null;
  try {
    const contacto = orderId
      ? await deps.source.getOrderContact(orderId)
      : { customerPhone: null, deliveryType: null };
    customerPhone = contacto.customerPhone;
    if (customerPhone) {
      // El tipo de entrega decide qué pasa DESPUÉS del pago, y es lo único que
      // el cliente todavía no sabe: si esperar una llamada o pasar a buscarlo.
      const res = await deps.sendText(
        customerPhone,
        paymentDecisionText(decision, contacto.deliveryType),
      );
      notification = res.ok ? 'sent' : 'failed';
    }
  } catch {
    // La decisión ya está persistida; esto solo cambia si avisamos o no.
    notification = 'failed';
  }

  // ── El agente se calla a partir de aquí ───────────────────────────────────
  //
  // El aviso que acaba de salir abre una conversación sobre el pago, y en un
  // rechazo el cliente va a querer discutirla. Un agente contestando en medio
  // "atendemos de seis de la tarde a cuatro" le hace creer que su pedido se
  // pasó por alto — que es exactamente lo que este silencio viene a evitar.
  //
  // En ACEPTAR y en RECHAZAR: los dos abren esa conversación. En `repeated` y
  // `conflict` no se llega hasta aquí, por la misma razón por la que tampoco se
  // avisa.
  //
  // Va DESPUÉS del aviso y no puede alterar el resultado: la decisión ya está
  // firme en la base, y el teléfono es el que ya se resolvió en servidor —nunca
  // uno que venga del navegador.
  if (customerPhone && deps.pauseAgentAfterReview) {
    try {
      await deps.pauseAgentAfterReview(customerPhone);
    } catch {
      // `pauseAgentAfterReview` ya es best-effort; este catch garantiza que ni
      // un fallo inesperado toque la decisión.
    }
  }

  // ── El reparto se entera cuando el pago está COBRADO ──────────────────────
  //
  // Antes salía al cotizar, junto con el QR: el grupo veía el pedido antes de
  // que el cliente hubiera pagado, y si no pagaba nunca, alguien podía salir a
  // repartir algo que no se cobró.
  //
  // Solo en `accept`: un rechazo no despacha nada.
  //
  // Va DESPUÉS del aviso al cliente y no puede alterar el resultado: la decisión
  // ya está firme en la base. Si Telegram falla, su propia marca de claim deja
  // el aviso sin enviar y el pedido sigue estando en el panel y en cocina —
  // perder el aviso es recuperable, perder la decisión no.
  if (decision === 'accept' && orderId && deps.notifyDeliveryGroup) {
    try {
      await deps.notifyDeliveryGroup(orderId);
    } catch {
      // `notifyDeliveryGroup` ya es best-effort y no lanza; este catch es la
      // garantía de que ni siquiera un fallo inesperado toque la decisión.
    }
  }

  return toReviewResult(row, notification);
}
