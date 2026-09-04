/**
 * La puerta del pago — módulo PURO.
 *
 * Responde UNA pregunta: ¿se puede empezar a cocinar este pedido?
 *
 * ── Lo que había antes ──────────────────────────────────────────────────────
 *
 * En el KDS conviven dos botones que no se conocían entre sí. ACEPTAR/RECHAZAR
 * escribía `payment_attempts.review_status` y avisaba al cliente; INICIAR
 * escribía `orders.status` y NUNCA consultaba el pago. La migración 0022 lo
 * decía con todas las letras: "No toca orders.status. Revisar un pago y avanzar
 * el pedido son decisiones distintas".
 *
 * El efecto era que se podía pulsar INICIAR sin haber mirado el comprobante, o
 * después de haberlo rechazado. Y mientras tanto el agente le prometía al
 * cliente que "la cocina empieza cuando el pago está confirmado", que era
 * simplemente falso.
 *
 * Aquí las dos decisiones se juntan: aceptar es lo que abre la plancha.
 *
 * ── Por qué esto NO frena la cocina ─────────────────────────────────────────
 *
 * Quien cocina puede aceptar el pago él mismo —`canReviewPayments` incluye a
 * cocina desde 0021— así que la puerta no le hace esperar a nadie: mira el
 * comprobante, acepta y arranca. Lo único que impide es arrancar SIN mirar.
 *
 * ── Ante la duda, se cocina ─────────────────────────────────────────────────
 *
 * Si no se pudo consultar el pago, la puerta se abre y lo dice en pantalla.
 * Cerrarla ahí detendría el servicio entero por un fallo de la base en plena
 * hora punta, y sin ninguna forma de saltársela desde una tablet. Un pedido de
 * más se recupera; una noche con la cocina parada, no.
 */
import type { PaymentMethod, PaymentReviewStatus } from '@/types';

/**
 * Lo UNICO que esta puerta mira de un pago: en que quedo cada intento.
 *
 * Es un tipo estructural, no la vista del panel. `PaymentView` encaja aqui tal
 * cual —la pantalla del KDS sigue pasando la suya sin cambiar una linea— y a la
 * vez el webhook puede preguntar por el estado de un pago sin construir
 * comprobantes, etiquetas ni tonos que nadie va a pintar.
 *
 * Que la firma pida lo minimo es lo que impide que esta regla se copie: quien
 * solo tiene los intentos ya no necesita una segunda version de la puerta.
 */
export interface PaymentAttemptsSnapshot {
  attempts: readonly { status: PaymentReviewStatus; reviewedAt: string | null }[];
}

/**
 * Cuánto tiene el cliente para reenviar un comprobante después de un rechazo.
 *
 * Quince minutos es lo que se le promete por WhatsApp, palabra por palabra, así
 * que esta constante y ese texto tienen que cambiar juntos. Vive aquí porque es
 * la regla, no el mensaje.
 */
export const REJECTION_GRACE_MS = 15 * 60 * 1000;

/**
 * Situación del pago de un pedido.
 *
 * Es un dominio cerrado a propósito: cada estado tiene una consecuencia
 * distinta en pantalla, y un `boolean` los aplastaría todos en "no se puede",
 * dejando al cocinero sin saber si falta revisar, si el cliente tiene que
 * reenviar o si el pedido ya murió.
 */
export type PaymentGateState =
  /** No se paga por QR (efectivo o histórico sin método): no espera nada. */
  | 'not_required'
  /** Hay un intento aceptado. Se cocina. */
  | 'accepted'
  /** Llegó comprobante y espera que alguien decida. */
  | 'awaiting_review'
  /** No ha llegado ningún comprobante todavía. */
  | 'no_proof'
  /** Rechazado, y el cliente aún está dentro de su ventana para reenviar. */
  | 'rejected_grace'
  /** Rechazado y vencido: el pedido ya no debe cocinarse. */
  | 'expired'
  /** No se pudo consultar el pago. NO es "no pagó": es "no lo sabemos". */
  | 'unknown';

export interface PaymentGate {
  state: PaymentGateState;
  /** ¿Puede cocina pulsar INICIAR? */
  canStart: boolean;
  /**
   * Instante en que vence la ventana de gracia (ms). Solo en `rejected_grace`,
   * para poder pintar la cuenta atrás sin recalcular la regla en la pantalla.
   */
  graceEndsAtMs: number | null;
}

/**
 * Los cuatro estados que abren la puerta y los que no.
 *
 * `unknown` abre — ver la cabecera. `expired` la cierra igual que `no_proof`:
 * los dos significan que nadie ha pagado esto.
 */
function abre(state: PaymentGateState): boolean {
  return state === 'not_required' || state === 'accepted' || state === 'unknown';
}

/**
 * ¿En qué situación está el pago de este pedido?
 *
 * @param paymentMethod  Cómo se cobra. `'qr'` es el único que espera algo.
 * @param payment        Intentos y comprobantes. `null` = no se pudo consultar.
 * @param nowMs          Reloj inyectado: la expiración se DERIVA al leer.
 */
export function paymentGateOf(
  paymentMethod: PaymentMethod | null,
  payment: PaymentAttemptsSnapshot | null,
  nowMs: number,
): PaymentGate {
  const gate = (state: PaymentGateState, graceEndsAtMs: number | null = null): PaymentGate => ({
    state,
    canStart: abre(state),
    graceEndsAtMs,
  });

  // Efectivo y pedidos históricos sin método: no hay comprobante que esperar, y
  // exigirles uno los dejaría bloqueados para siempre.
  if (paymentMethod !== 'qr') return gate('not_required');

  // `null` NO es "no hay pagos": es "no se pudo preguntar". Confundirlos es lo
  // que vaciaba el tablero entero cuando fallaba una consulta.
  if (payment === null) return gate('unknown');

  // ── Un pago aceptado es definitivo ────────────────────────────────────────
  //
  // ALGUNO aceptado, no "el último". Una vez que un pago se acepta el pedido
  // está pagado, y un comprobante posterior —un duplicado, o un archivo que el
  // cliente reenvía por si acaso— no puede volver a dejarlo a deber ni
  // reabrir una ventana de gracia ya cerrada.
  if (payment.attempts.some((a) => a.status === 'accepted')) return gate('accepted');

  // ── El reenvío PARA el reloj ──────────────────────────────────────────────
  //
  // Un intento esperando revisión significa que el cliente ya cumplió su parte.
  // A partir de ahí el pedido no puede morir por una demora nuestra: la cocina
  // en hora punta tarda más de un minuto en mirar un comprobante, y cancelar
  // con el pago bueno delante castigaría al cliente por lo que tardamos
  // nosotros.
  if (payment.attempts.some((a) => a.status === 'pending_review')) return gate('awaiting_review');

  // ── La ventana de gracia ──────────────────────────────────────────────────
  //
  // Se cuenta desde el rechazo MÁS RECIENTE: cada rechazo le da al cliente una
  // ventana limpia, porque cada uno viene con su propio aviso por WhatsApp
  // diciéndole que tiene quince minutos.
  const rechazos = payment.attempts
    .filter((a) => a.status === 'rejected')
    .map((a) => (a.reviewedAt === null ? NaN : Date.parse(a.reviewedAt)))
    .filter((ms) => !Number.isNaN(ms));

  if (rechazos.length > 0) {
    const ultimo = Math.max(...rechazos);
    const vence = ultimo + REJECTION_GRACE_MS;
    return nowMs >= vence ? gate('expired') : gate('rejected_grace', vence);
  }

  // Hay filas de pago pero ningún intento decidido ni pendiente. Es el pedido
  // al que aún no le ha llegado nada.
  return gate('no_proof');
}

/**
 * ¿Este pedido debe cancelarse por haber vencido su ventana?
 *
 * Separado de `paymentGateOf` porque son dos preguntas: aquella decide si se
 * cocina AHORA —y `unknown` la abre— y esta decide si el pedido ya murió, donde
 * `unknown` no puede afirmar nada. Una consulta que falla no cancela pedidos.
 */
export function shouldCancelForExpiry(
  paymentMethod: PaymentMethod | null,
  payment: PaymentAttemptsSnapshot | null,
  nowMs: number,
): boolean {
  return paymentGateOf(paymentMethod, payment, nowMs).state === 'expired';
}
