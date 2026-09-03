/**
 * Asociación de un comprobante con su pedido — módulo PURO.
 *
 * Decide a qué pedido pertenece un archivo que llegó por WhatsApp, y —cuando no
 * puede decidirlo con confianza— lo dice explícitamente en vez de adivinar.
 *
 * ── Lo que "no asociar" costaba de verdad (03-09-2026) ──────────────────────
 *
 * La regla original era "un comprobante mal asociado es peor que uno sin
 * asociar: el primero confirma el pago de otra persona". La segunda mitad de esa
 * frase es falsa, y hasta hoy nadie la había mirado de cerca: los candidatos
 * salen todos de `customer_phone`, así que la ambigüedad SIEMPRE es entre
 * pedidos del MISMO cliente. No hay ninguna otra persona a la que pagarle.
 *
 * Y no asociar no era neutral. Un comprobante con `order_id = null` no aparece
 * en ninguna pantalla: la cocina filtra el pedido por "todavía no llegó el
 * comprobante", y el panel del encargado busca los comprobantes por `order_id`.
 * El cliente pagaba, el archivo se guardaba, y el pedido no existía para nadie.
 *
 * Pasó con `ORD-260903-001`: el cliente tenía otros dos pedidos suyos abiertos
 * de esa misma jornada, así que su pago quedó `ambiguous` y su pedido nunca
 * llegó a la cocina. Con un cliente que repite —y repiten casi todos— el caso
 * no es raro: es lo normal en la segunda visita.
 *
 * Así que ante varios pedidos del mismo cliente ya no se calla: se elige el
 * destino más probable, se registra que hubo ambigüedad, y quien revisa el
 * comprobante decide como con cualquier otro. Equivocar el pedido de un cliente
 * es un error visible en el monto y reversible con un botón; perder el pago no
 * lo nota nadie hasta que el cliente llama.
 *
 * ── Por qué existe `routing_exception` además de `association_method` ───────
 *
 * No es lo mismo "no supe a qué pedido va" que "sé exactamente a cuál iba, pero
 * ese pedido ya no admite pagos". El segundo caso necesita quedar registrado con
 * su razón para que el operador entienda qué pasó, y por eso NUNCA se une a un
 * intento: la base lo impide con un CHECK (`routing_exception is null or
 * attempt_id is null`), y aquí se respeta la misma regla.
 */
import type { OrderStatus, PaymentMethod } from '@/types';
import type { ProofAssociationMethod, ProofRoutingException } from '@/types';

/**
 * Ventana durante la que un pedido sigue admitiendo comprobantes. Pasada esa
 * franja el pago se considera fuera de plazo y lo resuelve el operador a mano:
 * un comprobante que llega dos días tarde casi siempre es de otro pedido.
 */
export const PROOF_TARGET_TTL_MS = 24 * 60 * 60 * 1000;

/** Estados en los que el pedido ya no admite pago. */
const CLOSED_STATUSES: readonly OrderStatus[] = ['delivered', 'cancelled'];

/** Pedido candidato a recibir el comprobante, con lo justo para decidir. */
export interface ProofCandidateOrder {
  orderId: string;
  status: OrderStatus;
  paymentMethod: PaymentMethod | null;
  /** Instante de apertura del pedido: `confirmed_at ?? created_at`. */
  openedAt: string;
  /** ¿Este pedido ya tiene un intento de pago aceptado? */
  hasAcceptedPayment: boolean;
  /**
   * Cuándo vence la ventana de gracia de este pedido (ms), o `null` si no tiene
   * una corriendo (0028).
   *
   * ── Por qué el intake comparte este reloj ─────────────────────────────────
   *
   * La cancelación por vencimiento se DERIVA al leer: `orders.status` sigue
   * siendo `confirmed` hasta que alguien pulsa "Limpiar expirados". Si el
   * intake no mirara el mismo reloj, un comprobante que llega al minuto veinte
   * encontraría el pedido todavía vivo y abriría un intento normal — y el
   * resultado dependería de si alguien abrió el panel antes que el cliente
   * reenviara. El mismo caso daría dos desenlaces según el azar.
   *
   * Mirándolo aquí, el comprobante tardío se REGISTRA igual —nunca se pierde—
   * pero cae en `expired_target` y no abre intento: lo resuelve una persona.
   */
  rejectionGraceEndsAtMs: number | null;
}

export interface AssociationInput {
  /**
   * Pedido señalado por el mensaje al ser respuesta del QR que enviamos.
   * `null` si el cliente mandó el archivo suelto.
   */
  replyToOrderId: string | null;
  /** Pedidos del mismo teléfono que aún podrían estar esperando pago. */
  candidates: ProofCandidateOrder[];
  /** Comprobante anterior con el MISMO contenido, si lo hay. */
  duplicateOfProofId: string | null;
  nowMs: number;
  ttlMs?: number;
}

/**
 * Decisión de asociación, en la forma exacta que se guarda.
 *
 * `attemptEligible` es la única puerta para abrir o reutilizar un intento. Si
 * es `false`, el comprobante se registra igual —siempre se registra— pero no se
 * une a ningún episodio de revisión.
 */
export interface AssociationDecision {
  orderId: string | null;
  method: ProofAssociationMethod;
  routingException: ProofRoutingException | null;
  duplicateOfProofId: string | null;
  attemptEligible: boolean;
}

function isClosed(order: ProofCandidateOrder): boolean {
  return CLOSED_STATUSES.includes(order.status);
}

function isExpired(order: ProofCandidateOrder, nowMs: number, ttlMs: number): boolean {
  const opened = Date.parse(order.openedAt);
  if (Number.isNaN(opened)) return false; // fecha ilegible: no se inventa un vencimiento
  return nowMs - opened > ttlMs;
}

/** Excepción que impide usar este pedido, o `null` si el pedido sirve. */
function exceptionFor(
  order: ProofCandidateOrder,
  nowMs: number,
  ttlMs: number,
): ProofRoutingException | null {
  // El orden importa: se informa la razón MÁS específica primero. "Ya estaba
  // pagado" explica mejor que "está cerrado" un pedido entregado y pagado.
  if (order.hasAcceptedPayment) return 'payment_already_accepted';
  if (isClosed(order)) return 'closed_order';
  if (isExpired(order, nowMs, ttlMs)) return 'expired_target';
  // La ventana de gracia vencida: el pedido está muerto aunque su `status`
  // todavía no lo diga. Va después de `closed_order` porque un pedido ya
  // cancelado explica mejor lo mismo.
  if (order.rejectionGraceEndsAtMs !== null && nowMs >= order.rejectionGraceEndsAtMs) {
    return 'expired_target';
  }
  return null;
}

/** ¿El pedido está en condiciones de recibir un comprobante ahora mismo? */
function isOpenForPayment(
  order: ProofCandidateOrder,
  nowMs: number,
  ttlMs: number,
): boolean {
  return order.paymentMethod === 'qr' && exceptionFor(order, nowMs, ttlMs) === null;
}

/**
 * ¿A este pedido se le llegó a mandar el QR?
 *
 * El QR sale con la cotización, o sea al pasar a `confirmed`. Un pedido que
 * todavía espera la ubicación no tiene ni cifra que pagar ni QR que escanear,
 * así que un comprobante no puede ser suyo — y sin embargo contaba igual que
 * los demás a la hora de declarar la ambigüedad.
 */
function yaRecibioQr(order: ProofCandidateOrder): boolean {
  return order.status !== 'awaiting_location';
}

/**
 * Entre varios pedidos abiertos del MISMO cliente, a cuál va el comprobante.
 *
 * Dos criterios, en este orden:
 *
 *   1. Los que ya recibieron el QR ganan a los que aún no. No es una
 *      preferencia: un pedido sin QR no se puede pagar.
 *   2. Entre ellos, el más recientemente abierto —`confirmed_at`, que es
 *      cuando salió su QR—. Quien acaba de recibir un QR y manda una foto está
 *      pagando ESE pedido, no uno de hace doce horas.
 *
 * Es una elección, no una certeza, y por eso el método sigue siendo
 * `ambiguous`: queda escrito en la fila que aquí hubo más de un candidato, y se
 * puede auditar después con una consulta. Lo que cambia es que el comprobante
 * llega a una pantalla donde alguien lo mira.
 *
 * Una fecha ilegible va al fondo: nunca puede ganarle a una que sí se lee.
 */
function destinoMasProbable(open: ProofCandidateOrder[]): ProofCandidateOrder {
  const cuando = (o: ProofCandidateOrder): number => {
    const ms = Date.parse(o.openedAt);
    return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
  };
  return open.reduce((mejor, actual) => {
    const qrActual = yaRecibioQr(actual);
    const qrMejor = yaRecibioQr(mejor);
    if (qrActual !== qrMejor) return qrActual ? actual : mejor;
    return cuando(actual) > cuando(mejor) ? actual : mejor;
  });
}

/**
 * Decide la asociación de un comprobante.
 *
 * Precedencia:
 *   1. Duplicado por contenido — se registra como tal y NO alimenta un intento.
 *   2. Respuesta al QR — la señal más fuerte: el cliente dijo a qué pedido va.
 *   3. Un único pedido QR abierto — inequívoco por descarte.
 *   4. Varios candidatos — se elige el más probable y se marca `ambiguous`.
 *   5. Ninguno — sin resolver.
 */
export function decideAssociation(input: AssociationInput): AssociationDecision {
  const ttl = input.ttlMs ?? PROOF_TARGET_TTL_MS;
  const { candidates, nowMs } = input;

  // 1. Duplicado: el mismo archivo ya llegó antes. Se conserva el registro para
  //    dejar constancia del reenvío, pero no cuenta como evidencia nueva.
  if (input.duplicateOfProofId !== null) {
    const target = input.replyToOrderId
      ? candidates.find((c) => c.orderId === input.replyToOrderId)
      : undefined;
    return {
      orderId: target?.orderId ?? null,
      method: 'duplicate',
      routingException: null,
      duplicateOfProofId: input.duplicateOfProofId,
      attemptEligible: false,
    };
  }

  // 2. Respuesta al QR: el cliente señaló el pedido.
  if (input.replyToOrderId !== null) {
    const target = candidates.find((c) => c.orderId === input.replyToOrderId);

    // Señaló un pedido que no reconocemos como suyo. No se fuerza otro destino
    // aunque hubiera un único candidato abierto: la señal se contradice con lo
    // que sabemos, y resolverlo por nuestra cuenta arriesga pagar otro pedido.
    if (!target) {
      return {
        orderId: null,
        method: 'reply_to_qr',
        routingException: 'signal_conflict',
        duplicateOfProofId: null,
        attemptEligible: false,
      };
    }

    const exception = exceptionFor(target, nowMs, ttl);
    if (exception !== null) {
      return {
        orderId: target.orderId,
        method: 'reply_to_qr',
        routingException: exception,
        duplicateOfProofId: null,
        attemptEligible: false,
      };
    }

    return {
      orderId: target.orderId,
      method: 'reply_to_qr',
      routingException: null,
      duplicateOfProofId: null,
      attemptEligible: true,
    };
  }

  // 3-5. Sin señal explícita: decide el conjunto de pedidos abiertos.
  const open = candidates.filter((c) => isOpenForPayment(c, nowMs, ttl));

  if (open.length === 1) {
    return {
      orderId: open[0].orderId,
      method: 'single_open_qr_order',
      routingException: null,
      duplicateOfProofId: null,
      attemptEligible: true,
    };
  }

  if (open.length > 1) {
    // Se abre intento igual que con un destino inequívoco, y a propósito: sin
    // intento, el pedido entra al tablero pero su puerta se queda cerrada
    // (`no_proof`) y no hay ningún botón con el que aceptar el pago. Sería
    // enseñar el problema sin dar la herramienta para resolverlo.
    //
    // Quien revisa contrasta el comprobante contra "A cobrar por QR", que es lo
    // mismo que hace siempre; si el monto no cuadra, lo rechaza. La elección de
    // aquí no decide nada por él: le pone el archivo delante.
    return {
      orderId: destinoMasProbable(open).orderId,
      method: 'ambiguous',
      routingException: null,
      duplicateOfProofId: null,
      attemptEligible: true,
    };
  }

  // Ningún pedido abierto. Si había uno solo y su problema tiene nombre, se
  // informa la razón en vez de un genérico "no se pudo asociar".
  const qrCandidates = candidates.filter((c) => c.paymentMethod === 'qr');
  if (qrCandidates.length === 1) {
    const exception = exceptionFor(qrCandidates[0], nowMs, ttl);
    if (exception !== null) {
      return {
        orderId: qrCandidates[0].orderId,
        method: 'unresolved',
        routingException: exception,
        duplicateOfProofId: null,
        attemptEligible: false,
      };
    }
  }

  return {
    orderId: null,
    method: 'unresolved',
    routingException: null,
    duplicateOfProofId: null,
    attemptEligible: false,
  };
}

/**
 * Marca una decision ya tomada como DUPLICADO.
 *
 * El duplicado se descubre despues de descargar (hace falta el hash del
 * contenido), asi que llega cuando el enrutado ya decidio a que pedido va. No
 * es un resultado aparte: la fila se sigue capturando con normalidad, pero su
 * `matchMethod` pasa a `duplicate`, guarda a quien duplica, y deja de alimentar
 * un intento — un reenvio del mismo archivo no es evidencia nueva.
 *
 * El pedido asociado SE CONSERVA: saber a que pedido iba el reenvio es
 * justamente lo que hace util el registro.
 */
export function overrideAsDuplicate(
  decision: AssociationDecision,
  duplicateOfProofId: string,
): AssociationDecision {
  return {
    ...decision,
    method: 'duplicate',
    duplicateOfProofId,
    attemptEligible: false,
  };
}
