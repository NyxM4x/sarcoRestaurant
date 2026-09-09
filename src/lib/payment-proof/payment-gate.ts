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
 * Cuánto vive un pedido al que NUNCA le llegó un comprobante (09-09-2026).
 *
 * ── El pedido zombi que este reloj mata ─────────────────────────────────────
 *
 * Hasta hoy `no_proof` era el único estado sin reloj: el pedido cotizado al que
 * no llega la foto del pago se quedaba vivo hasta que su ventana de 24 h
 * (`PROOF_TARGET_TTL_MS`) lo sacaba de la vista, y durante todo ese tiempo era
 * el pedido "abierto" del cliente. El 09-09-2026 se probó el flujo y se vio lo
 * que eso significa: un pedido de las 00:32 sin comprobante seguía contestando
 * "falta que nos mandes la foto" a las 12:17 del día siguiente, doce horas
 * después, a un cliente que solo quería el menú.
 *
 * Dos horas es lo que el dueño consideró suficiente: da de sobra para buscar la
 * foto y volver, y no llega a la mañana siguiente.
 *
 * ── Por qué NO es el mismo número que la gracia del rechazo ─────────────────
 *
 * `REJECTION_GRACE_MS` son quince minutos porque al cliente rechazado se le
 * prometen quince minutos por WhatsApp, con esas palabras. Aquí no se le promete
 * nada —no hay ningún mensaje que anuncie un plazo—, y el punto de partida es
 * otro: allí el cliente ya pagó una vez y solo tiene que reenviar; aquí todavía
 * tiene que ir al banco. Unificarlos habría matado en quince minutos a quien no
 * había hecho nada malo.
 *
 * ── El reloj arranca cuando el cliente supo cuánto pagar ────────────────────
 *
 * Se cuenta desde `confirmed_at ?? created_at`, y esa preferencia importa: el
 * pedido web con delivery nace `awaiting_location` sin total ni QR, y solo sella
 * `confirmed_at` cuando la cotización lo confirma (migración 0009) — que es el
 * instante exacto en que se le manda el QR. Contar desde `created_at` en ese
 * caso le descontaría al cliente el rato que tardó en mandar su ubicación, y
 * podría matar el pedido antes de que llegara a ver la cifra.
 */
export const PROOF_WINDOW_MS = 2 * 60 * 60 * 1000;

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
  /**
   * Vencido: el pedido ya no debe cocinarse.
   *
   * Se llega por DOS caminos que aquí dan lo mismo —el pedido está muerto y por
   * la misma razón, nadie pagó esto—: un rechazo cuya gracia se agotó
   * (`REJECTION_GRACE_MS`), o un comprobante que nunca llegó dentro de su
   * ventana (`PROOF_WINDOW_MS`).
   */
  | 'expired'
  /** No se pudo consultar el pago. NO es "no pagó": es "no lo sabemos". */
  | 'unknown';

export interface PaymentGate {
  state: PaymentGateState;
  /** ¿Puede cocina pulsar INICIAR? */
  canStart: boolean;
  /**
   * Instante en que vence la ventana que este pedido tiene corriendo (ms), para
   * poder pintar la cuenta atrás sin recalcular la regla en la pantalla.
   *
   * Lo llevan los dos estados que están esperando algo con reloj:
   * `rejected_grace` —lo que le queda al cliente para reenviar— y `no_proof`
   * —lo que le queda para mandar su primer comprobante—. En el resto es `null`,
   * `expired` incluido: ahí ya no queda nada que contar.
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
 * El instante desde el que corre `PROOF_WINDOW_MS`, en ms.
 *
 * `confirmed_at` primero y `created_at` de respaldo: es la MISMA semántica de
 * "apertura del pedido" que ya usan el intake (`ProofCandidateOrder.openedAt`)
 * y la antigüedad del KDS (`enteredAtOf`). Vive aquí, junto a la regla que la
 * consume, porque tres sitios calculando lo mismo por su cuenta es la forma en
 * que dos de ellos acaban discrepando.
 *
 * `null` cuando no hay ninguna fecha legible. Ver `paymentGateOf`: sin fecha no
 * se inventa un vencimiento.
 */
export function openedAtMsOf(
  confirmedAt: string | null | undefined,
  createdAt: string | null | undefined,
): number | null {
  for (const iso of [confirmedAt, createdAt]) {
    if (typeof iso !== 'string') continue;
    const ms = Date.parse(iso);
    if (!Number.isNaN(ms)) return ms;
  }
  return null;
}

/**
 * Cuándo deja este pedido de admitir un pago (ms), o `null` si no hay ninguna
 * cuenta atrás corriendo.
 *
 * ── El ÚNICO sitio donde se calcula el plazo ────────────────────────────────
 *
 * Lo usan la puerta (`paymentGateOf`, para decidir si ya venció) y el intake de
 * comprobantes (`intake-data-source`, para decidir si un archivo que acaba de
 * llegar todavía abre un intento). Antes eran dos cálculos separados con el
 * mismo contenido, y esa era una divergencia esperando a ocurrir: el día que
 * uno de los dos cambiara, el desenlace de un comprobante dependería de por qué
 * camino se mirara el mismo pedido.
 *
 * `null` en los tres casos en los que no corre ningún reloj: el pago aceptado
 * —el pedido está pagado—, el comprobante esperando revisión —el cliente
 * cumplió y la demora es nuestra— y el pedido sin fecha de apertura legible ni
 * rechazos fechados, donde no hay nada desde lo que contar.
 */
export function paymentDeadlineMsOf(
  payment: PaymentAttemptsSnapshot,
  openedAtMs: number | null,
): number | null {
  if (payment.attempts.some((a) => a.status === 'accepted')) return null;
  if (payment.attempts.some((a) => a.status === 'pending_review')) return null;

  // Se cuenta desde el rechazo MÁS RECIENTE: cada rechazo le da al cliente una
  // ventana limpia, porque cada uno viene con su propio aviso por WhatsApp
  // diciéndole que tiene quince minutos.
  const rechazos = payment.attempts
    .filter((a) => a.status === 'rejected')
    .map((a) => (a.reviewedAt === null ? NaN : Date.parse(a.reviewedAt)))
    .filter((ms) => !Number.isNaN(ms));
  if (rechazos.length > 0) return Math.max(...rechazos) + REJECTION_GRACE_MS;

  // Nunca llegó nada: el reloj es el del propio pedido.
  return openedAtMs === null || Number.isNaN(openedAtMs) ? null : openedAtMs + PROOF_WINDOW_MS;
}

/**
 * ¿Hay algún rechazo FECHADO en este pago?
 *
 * Es lo que separa las dos causas de un mismo plazo: con un rechazo detrás, el
 * cliente está reenviando (`rejected_grace`); sin él, todavía no ha mandado
 * nada (`no_proof`). Un rechazo sin fecha no cuenta, por la misma razón por la
 * que no abre ventana: no se puede contar desde una fecha que no se puede leer.
 */
function hayRechazoFechado(payment: PaymentAttemptsSnapshot): boolean {
  return payment.attempts.some(
    (a) => a.status === 'rejected' && a.reviewedAt !== null && !Number.isNaN(Date.parse(a.reviewedAt)),
  );
}

/**
 * ¿En qué situación está el pago de este pedido?
 *
 * @param paymentMethod  Cómo se cobra. `'qr'` es el único que espera algo.
 * @param payment        Intentos y comprobantes. `null` = no se pudo consultar.
 * @param nowMs          Reloj inyectado: la expiración se DERIVA al leer.
 * @param openedAtMs     Cuándo supo el cliente cuánto pagar (`confirmed_at ??
 *                       created_at`, en ms). `null` = no se pudo saber, y
 *                       entonces el pedido no vence por falta de comprobante:
 *                       ver `PROOF_WINDOW_MS`. Es OBLIGATORIO a propósito —
 *                       opcional, cualquier llamador nuevo se saltaría la regla
 *                       sin enterarse, y el compilador no diría nada.
 */
export function paymentGateOf(
  paymentMethod: PaymentMethod | null,
  payment: PaymentAttemptsSnapshot | null,
  nowMs: number,
  openedAtMs: number | null,
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

  // ── El plazo, sea cual sea su reloj ───────────────────────────────────────
  //
  // A partir de aquí el pedido está esperando un pago que no ha llegado, y solo
  // queda saber si le queda tiempo. El plazo lo calcula `paymentDeadlineMsOf`
  // —quince minutos desde el rechazo, o dos horas desde que se abrió el
  // pedido—, y esta función no vuelve a decidir cuál corre: el intake mira ese
  // mismo número, y dos cálculos separados acabarían discrepando.
  const vence = paymentDeadlineMsOf(payment, openedAtMs);

  // Sin plazo no se inventa un vencimiento: una fecha que no se pudo leer es lo
  // mismo que un pago que no se pudo consultar, y ninguna de las dos cosas puede
  // matar un pedido. Se queda `no_proof` sin cuenta atrás, que es exactamente el
  // comportamiento anterior a esta regla.
  if (vence === null) return gate('no_proof');
  if (nowMs >= vence) return gate('expired');

  // Vivo, y con dos formas de estarlo: el que ya pagó una vez y está reenviando
  // tras un rechazo, y el que todavía no ha mandado nada. Al cocinero le dicen
  // cosas distintas —ver `motivoDeBloqueo`— aunque el reloj sea el mismo.
  return gate(hayRechazoFechado(payment) ? 'rejected_grace' : 'no_proof', vence);
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
  openedAtMs: number | null,
): boolean {
  return paymentGateOf(paymentMethod, payment, nowMs, openedAtMs).state === 'expired';
}
