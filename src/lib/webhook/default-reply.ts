import type { OrderStatus } from '@/types';
import type { PaymentGateState } from '@/lib/payment-proof/payment-gate';
import { PROOF_TARGET_TTL_MS } from '@/lib/payment-proof/association';
import {
  isKitchenNoteRequest,
  isOrderChangeAnnouncement,
  isOrderChangeRequest,
  kitchenNoteFrom,
} from './order-change-intent';
import { isPickupSwitchRequest } from './pickup-switch-intent';

/**
 * QUÉ RECIBE EL CLIENTE CUANDO NO PIDIÓ NADA CONCRETO — módulo PURO (03-09-2026).
 *
 * ── El cambio de política que documenta este archivo ────────────────────────
 *
 * Hasta hoy el botón del menú salía por LISTA BLANCA: `menu-intent.ts` reconocía
 * un puñado de frases ("quiero pedir", "menú", "ver carta") y todo lo demás caía
 * al modelo. La lista se fue alargando conversación a conversación —el imperfecto
 * de cortesía, el saludo encadenado, el pedido dictado— y aun así el 03-09-2026
 * una conversación entera terminó sin menú y con el cliente escribiendo "me puede
 * responder sin ia si":
 *
 *   "buenas" · "noches" · "a cuanto"      →  "¿En qué puedo ayudarte esta noche?"
 *   "esta el trancapecho" · "disculpe"    →  "¿Quieres saber a cuánto están…?"
 *
 * Ninguna de esas frases estaba en la lista, y las dos respuestas fueron
 * preguntas: dos turnos gastados sin darle al cliente por dónde pedir.
 *
 * Así que la lista blanca deja de decidir quién recibe el botón. **El botón es
 * la respuesta por defecto** y lo que este módulo enumera son las EXCEPCIONES —
 * las situaciones en las que mandarlo sería peor que no mandarlo. Adivinar cómo
 * escribe la gente es un problema abierto; enumerar en qué estado está su pedido
 * es un problema cerrado, y esa es toda la diferencia.
 *
 * `menu-intent.ts` NO desaparece ni sobra: sigue decidiendo qué mensajes se
 * atienden ANTES que la ubicación y la cotización, y sigue poniendo
 * `explicit_request` en el ledger. Lo que ya no hace es ser la única puerta.
 *
 * ── Las cuatro excepciones ──────────────────────────────────────────────────
 *
 *   1. NO SABEMOS en qué estado está  → nada. Ver `state: null`.
 *   2. Un HUMANO está atendiendo      → nada. Es la más importante.
 *   3. Pide algo para la COCINA sobre un pedido que aún no se cocina
 *      ("sin cebolla") → se anota y se le contesta que sí.
 *   4. Quiere CAMBIAR lo que lleva su pedido y todavía no lo pagó
 *      ("mándame 2 sodas más", "puedo aumentar", "quiero armar de nuevo") → se
 *      le devuelve su pedido para rearmarlo. Vale también antes de que mande la
 *      ubicación: ver `ORDER_CHANGE_STATUSES`.
 *   5. Dice que pasa ÉL a recogerlo ("paso a recogerlo", "para llevar") → el
 *      pedido deja de ser delivery y se le confirma con el nuevo total.
 *   6. Tiene un pedido ESPERANDO SU COMPROBANTE → se le recuerda el comprobante.
 *   7. Tiene cualquier otro pedido ABIERTO      → nada; sigue el camino de hoy.
 *
 * Todo lo demás recibe el botón, escriba lo que escriba.
 */

/**
 * Estados en los que un pedido sigue VIVO para el cliente.
 *
 * `draft` queda fuera a propósito: es un carrito a medias del Flow, no un pedido
 * que nadie esté esperando. `delivered` y `cancelled` también: ese cliente
 * volvió a empezar, y a quien vuelve se le manda el menú como al primer día.
 */
export const OPEN_ORDER_STATUSES: readonly OrderStatus[] = [
  'awaiting_location',
  'confirmed',
  'preparing',
  'ready',
  'on_the_way',
];

/**
 * Cuánto atrás se mira un pedido abierto.
 *
 * El MISMO reloj con el que un pedido deja de admitir comprobantes
 * (`PROOF_TARGET_TTL_MS`), importado y no recopiado. Si los dos números
 * pudieran separarse, existiría la ventana en la que le callamos el menú a un
 * cliente por un pedido que ya no acepta su pago — lo peor de las dos reglas a
 * la vez.
 */
export const OPEN_ORDER_WINDOW_MS = PROOF_TARGET_TTL_MS;

/**
 * Cada cuánto, como mucho, se le repite a alguien que nos mande su comprobante.
 *
 * El recordatorio contesta a un mensaje del cliente, así que sin tope saldría
 * uno por cada cosa que escriba: tres mensajes seguidos, tres veces "mandanos el
 * comprobante". Quince minutos es la misma ventana que ya se le promete por
 * WhatsApp tras un rechazo (`REJECTION_GRACE_MS`), y es tiempo de sobra para
 * sacar la foto.
 */
export const PROOF_REMINDER_COOLDOWN_MS = 15 * 60 * 1000;

/**
 * Estados en los que un pedido todavía puede pasar a recojo.
 *
 * Son aquellos en los que NADIE salió aún hacia una puerta. `on_the_way` queda
 * fuera por lo evidente, y `awaiting_location` también, pero por lo contrario:
 * ese pedido aún no tiene total ni QR, así que no hay nada que recalcular ni
 * nada que confirmarle. Ese cliente sigue el camino de hoy.
 *
 * Las guardas finas —que el aviso de reparto no haya salido, que el envío no
 * conste cobrado— las pone `pickup-switch-service`, que es quien lee la fila.
 */
/**
 * Estados en los que el pedido todavía se puede REARMAR (04-09-2026).
 *
 * `awaiting_location` entró tarde y costó una prueba entera: el 04-09 se probó
 * el flujo del botón con un pedido recién creado —el cliente escribió "me
 * aumenta 2 papas" antes de mandar la ubicación— y no pasó nada, porque la
 * guarda solo miraba `confirmed`. Y es justo al revés: ese es el momento MÁS
 * seguro para rehacerlo. No hay ubicación, no hay total final, no hay QR, no
 * hay nada en la plancha; lo único que existe es un carrito con su número.
 *
 * Lo que sigue fuera es lo que ya salió: `preparing`, `ready` y `on_the_way`.
 * Ahí la comida está hecha y rehacer el pedido no la des-hace.
 */
export const ORDER_CHANGE_STATUSES: readonly OrderStatus[] = ['awaiting_location', 'confirmed'];

export const PICKUP_SWITCHABLE_STATUSES: readonly OrderStatus[] = [
  'confirmed',
  'preparing',
  'ready',
];

/** El pedido abierto del cliente, con lo justo para decidir y para escribirle. */
export interface OpenOrderSnapshot {
  /** Identificador interno. Solo lo usa quien tiene que ESCRIBIR en el pedido. */
  orderId: string;
  /** Interno (`ORD-260903-007`). El copy lo acorta; aquí viaja entero. */
  orderNumber: string;
  status: OrderStatus;
  /** Total ya cotizado, en Bs. Es la cifra que el cliente tiene que pagar. */
  totalAmount: number;
  /** Situación del pago, calculada con `paymentGateOf`: una sola regla. */
  payment: PaymentGateState;
  /**
   * ¿Llegó ALGUNA foto para este pedido? (04-09-2026)
   *
   * No es lo mismo que `payment`. `payment` se calcula desde
   * `payment_attempts`, y esa fila solo existe si el archivo se pudo descargar
   * y guardar. La noche del 04-09 la captura falló tres veces seguidas —
   * `capture_status: 'failed'`, sin bytes, sin hash— y el sistema quedó
   * creyendo que aquel cliente no había pagado: le ofreció rehacer un pedido ya
   * pagado y después le pidió el comprobante que acababa de mandar. Acabó con
   * dos pedidos y hablando con una persona.
   *
   * Esto mira la otra tabla, `payment_proofs`, donde la fila SÍ se escribe
   * aunque la descarga se caiga. Es una segunda fuente a propósito: si una falla,
   * la otra sigue sabiendo que ese cliente mandó algo.
   */
  proofReceived: boolean;
}

/**
 * Lo que hay que saber del cliente para decidir. Lo resuelve el wiring
 * server-only; aquí solo se lee.
 */
export interface CustomerStateSnapshot {
  /** ¿Hay una pausa VIGENTE? Es `isPauseActive`, no `state === 'paused'`. */
  paused: boolean;
  /** Su pedido abierto más reciente dentro de la ventana, si lo hay. */
  openOrder: OpenOrderSnapshot | null;
  /** ¿Ya se le recordó el comprobante hace poco? Ver `PROOF_REMINDER_COOLDOWN_MS`. */
  proofRemindedRecently: boolean;
  /**
   * Palabras de los productos que se venden, para distinguir una preferencia de
   * cocina de un cambio de pedido. Ver `order-change-intent.ts`.
   *
   * Solo se resuelve cuando hay un pedido que aún admite notas; el cliente sin
   * pedido no paga esa consulta. Ausente = lista vacía, y sin catálogo NINGUNA
   * frase se anota: sin poder descartar que nombre un producto, la única
   * respuesta segura es no tocar el pedido.
   */
  catalogTerms?: readonly string[];
}

/** Por qué este mensaje no recibe nada por defecto. Solo para el log. */
export type DefaultReplySkipReason =
  /** No es un texto entrante del cliente (foto, audio, pin, reacción, saliente). */
  | 'no_text'
  /** Es texto, pero otro mensaje de la MISMA entrega es el que contesta. */
  | 'not_anchor'
  /** Otro mensaje de esta entrega ya recibió el botón. Uno por entrega. */
  | 'already_sent'
  /** No se pudo consultar su estado, o el puerto no está cableado. */
  | 'unknown_state'
  /** Un humano tiene el control de la conversación. */
  | 'paused'
  /** Tiene un pedido en curso: el menú no es lo que necesita. */
  | 'open_order'
  /** Espera comprobante, pero ya se le recordó hace muy poco. */
  | 'reminded_recently'
  /** Ya mandó una foto para este pedido: ni se le pide otra ni se le ofrece rehacerlo. */
  | 'proof_received';

export type DefaultReplyDecision =
  | { action: 'menu' }
  /**
   * Hablarle de su pago. `variant` dice QUÉ, y sale del estado, no del texto:
   *
   *   `missing`   no consta ninguna foto  → "falta que nos mandes el comprobante"
   *   `received`  ya mandó una            → "lo tenemos, lo estamos revisando"
   *
   * Las dos comparten cooldown y camino a propósito: son la misma conversación
   * —el pago de este pedido— y el cliente no debería recibir las dos seguidas.
   */
  | { action: 'proof_reminder'; order: OpenOrderSnapshot; variant: 'missing' | 'received' }
  /** Anotar una preferencia para la plancha y confirmársela al cliente. */
  | { action: 'kitchen_note'; order: OpenOrderSnapshot; note: string }
  /** Mandarle el enlace que reabre SU pedido para cambiar lo que lleva dentro. */
  | { action: 'order_change'; order: OpenOrderSnapshot }
  /** Pasar su pedido a recojo: se lo lleva él y ya no hay envío que cobrar. */
  | { action: 'pickup_switch'; order: OpenOrderSnapshot }
  | { action: 'none'; reason: DefaultReplySkipReason };

export interface DefaultReplyInput {
  /**
   * El texto que escribió el cliente, o `null` si el mensaje no era texto suyo.
   *
   * Llega entero y no reducido a un booleano porque una de las decisiones —si
   * esto es una preferencia para la cocina— se toma leyéndolo. Se lee aquí, en
   * un módulo puro y con el catálogo delante; el webhook no interpreta nada.
   */
  text: string | null;
  /**
   * ¿Es el ÚLTIMO texto entrante de esta entrega?
   *
   * El buffering de Kapso agrupa las ráfagas, y este módulo se evalúa por
   * mensaje: sin esta condición, "buenas" / "noches" / "a cuanto" produciría
   * TRES botones en el mismo segundo. Contesta el último, que es el que cierra
   * la ráfaga — el mismo criterio con el que `pickTurnAnchor` ancla el turno del
   * agente, por la misma razón y con el mismo resultado.
   */
  isBatchAnchor: boolean;
  /**
   * ¿Ya salió un botón por otro mensaje de ESTA misma entrega?
   *
   * Un lote puede traer una frase que la puerta de intención reconoce ("quiero
   * pedir") y otra que no ("a cuanto"): la primera manda su CTA y la segunda es
   * el ancla, así que sin esta bandera el cliente recibiría dos botones seguidos
   * por escribir dos veces. Uno por entrega, venga de la puerta que venga.
   */
  menuAlreadySent: boolean;
  /**
   * ¿El cliente PIDIÓ el menú con todas las letras?
   *
   * Lo decide `menu-intent.ts` antes de llegar aquí. Cambia tres desenlaces, y
   * los tres en la misma dirección: quien pide algo expresamente tiene más
   * derecho a recibirlo que quien no dijo nada.
   *
   *   estado desconocido   →  se le manda igual (es el comportamiento de
   *                           siempre, y no romperlo es lo que permite que esta
   *                           política se despliegue sin un interruptor)
   *   pedido en curso      →  se le manda: querrá pedir algo más
   *   pausa / comprobante  →  NO cambia nada. Ver abajo.
   *
   * Que la pausa no ceda ante una petición explícita es deliberado: el cliente
   * no sabe que hay una persona escribiéndole, y quien tiene que mandarle el
   * menú en ese momento es esa persona. Y el que espera comprobante recibe su
   * recordatorio pida lo que pida, porque su pedido ya está armado.
   */
  explicitIntent: boolean;
  /**
   * Estado del cliente, o `null` si no se pudo averiguar.
   *
   * `null` NO es "está todo despejado": es "no lo sabemos". Y ante la duda no se
   * manda nada, porque el caso que no se puede descartar a ciegas es el de la
   * persona del equipo escribiéndole al cliente ahora mismo. Sin el puerto
   * cableado el comportamiento es EXACTAMENTE el anterior a este módulo: el
   * mensaje sigue su camino y lo atiende el agente.
   */
  state: CustomerStateSnapshot | null;
}

/**
 * ¿Qué le sale a este cliente por defecto?
 *
 * El orden de las guardas es el argumento entero, y va de lo que más daño hace
 * a lo que menos: primero se descarta pisar a un humano, después mandarle un
 * menú a quien ya pidió, y solo al final se manda el botón.
 */
export function decideDefaultReply(input: DefaultReplyInput): DefaultReplyDecision {
  const texto = typeof input.text === 'string' ? input.text : '';
  if (texto.trim() === '') return { action: 'none', reason: 'no_text' };
  if (input.menuAlreadySent) return { action: 'none', reason: 'already_sent' };

  // Quien lo pidió contesta aunque no sea el último de su ráfaga: su frase es la
  // petición, no el turno. El ancla solo ordena a los que no pidieron nada.
  if (!input.explicitIntent && !input.isBatchAnchor) {
    return { action: 'none', reason: 'not_anchor' };
  }

  const state = input.state;
  if (state === null) {
    // Sin saber nada, al que lo pidió se le manda —es lo que se hacía antes de
    // esta política, y una consulta caída no puede dejar de contestarle— y al
    // que no, no: ahí el silencio es lo de antes.
    return input.explicitIntent ? { action: 'menu' } : { action: 'none', reason: 'unknown_state' };
  }

  // Alguien del equipo está en esta conversación. Un botón automático encima de
  // una persona que responde es el fallo del 03-09-2026 repetido con más
  // insistencia: aquel cliente pidió expresamente que no le contestara la IA.
  //
  // Es un cambio de doctrina y está anotado donde vivía la anterior
  // (`agent/control/pause-gate.ts`): las comunicaciones determinísticas que
  // CIERRAN algo que el cliente empezó —su confirmación, su QR, su ubicación—
  // siguen saliendo durante una pausa. Esta no cierra nada: la abre.
  if (state.paused) return { action: 'none', reason: 'paused' };

  const order = state.openOrder;
  if (order !== null) {
    // ── "Paso yo a recogerlo" ──────────────────────────────────────────────
    //
    // Va ANTES que todo lo demás porque es lo más específico que puede traer un
    // mensaje en este punto, y lo único que cambia por dónde SALE el pedido.
    // Contestarle "mandanos el comprobante" a quien acaba de decir que pasa a
    // recogerlo no es solo no haberlo leído: manda además al repartidor a una
    // puerta donde ya no lo esperan.
    //
    // No mira el pago, y no es un descuido: pasar a recojo no cambia un centavo
    // de lo que se paga por QR, porque el envío nunca viajó en él —se cobra en
    // la puerta—. Lo único que desaparece es esa puerta.
    if (PICKUP_SWITCHABLE_STATUSES.includes(order.status) && isPickupSwitchRequest(texto)) {
      return { action: 'pickup_switch', order };
    }

    // ── "Sin cebolla" ──────────────────────────────────────────────────────
    //
    // Va ANTES que el recordatorio del pago, y también antes de su cooldown:
    // una preferencia es una petición nueva, no una repetición, y contestarle
    // "mandanos el comprobante" a quien acaba de decir "sin cebolla" es no
    // haberlo leído.
    //
    // Solo mientras el pedido siga en `confirmed`, que es el estado en el que
    // todavía no ha entrado a la plancha (la cocina arranca cuando se acepta el
    // pago). Con la comida ya haciéndose, un "claro que sí" sería una promesa
    // que no depende de nosotros.
    if (order.status === 'confirmed' && isKitchenNoteRequest(texto, state.catalogTerms ?? [])) {
      return { action: 'kitchen_note', order, note: kitchenNoteFrom(texto) };
    }

    // ── Ya mandó su comprobante ────────────────────────────────────────────
    //
    // Va después de la nota de cocina —"sin cebolla" se sigue anotando, que no
    // toca el total— y ANTES de todo lo que habla de dinero. Un pedido con foto
    // recibida no se rehace y no se le vuelve a pedir el comprobante, ni aunque
    // el intento de pago no conste: la foto llegó, y lo que falte por hacer con
    // ella es cosa nuestra, no del cliente.
    //
    // Esta guarda existe porque la de abajo no basta. `payment` sale de
    // `payment_attempts`, y esa fila desaparece si la descarga del archivo
    // falla; `proofReceived` sale de `payment_proofs`, que se escribe igual.
    // Ver `OpenOrderSnapshot.proofReceived`.
    if (order.proofReceived && order.payment !== 'accepted' && order.payment !== 'rejected_grace') {
      // Y se le CONTESTA, no se calla. Callar dejaba el turno libre y lo tomaba
      // el modelo, que el 04-09 le dijo a un cliente con el comprobante ya
      // mandado que hablara con una persona. Una respuesta determinística
      // cierra el turno: el agente ya no habla encima.
      return state.proofRemindedRecently
        ? { action: 'none', reason: 'reminded_recently' }
        : { action: 'proof_reminder', order, variant: 'received' };
    }

    // ── "Mándame 2 sodas más" ──────────────────────────────────────────────
    //
    // Esto sí cambia el total, el QR y la comanda, así que no se anota en
    // ningún sitio: se le devuelve su propio pedido para que lo rearme y el
    // sistema recalcule todo por el camino de siempre.
    //
    // Solo mientras NO haya mandado comprobante. En cuanto hay un pago en
    // revisión hay dinero de por medio contra un total concreto, y cambiar las
    // líneas por debajo dejaría al cliente pagando una cosa y recibiendo otra.
    // Ese caso sigue el camino de hoy y acaba donde acaban las excepciones.
    if (ORDER_CHANGE_STATUSES.includes(order.status) && order.payment === 'no_proof') {
      // Las DOS formas de pedirlo, y la segunda es la que llega primero: el
      // cliente pregunta si puede antes de decir qué quiere. Reconocer solo la
      // que nombra productos dejaba ese primer mensaje sin respuesta
      // determinística, y con él el turno se lo quedaba el modelo — que el
      // 04-09-2026 derivó la conversación a una persona y la calló dos horas.
      // Ver `isOrderChangeAnnouncement`.
      if (
        isOrderChangeRequest(texto, state.catalogTerms ?? []) ||
        isOrderChangeAnnouncement(texto)
      ) {
        return { action: 'order_change', order };
      }
    }

    // El pedido está cotizado, tiene su QR y no ha llegado ningún comprobante.
    // Lo que este cliente necesita es que le recordemos ESO, no un menú nuevo:
    // ya armó su pedido y lo que falta es la foto del pago.
    if (order.payment === 'no_proof') {
      return state.proofRemindedRecently
        ? { action: 'none', reason: 'reminded_recently' }
        : { action: 'proof_reminder', order, variant: 'missing' };
    }

    // Cualquier otro pedido vivo —esperando ubicación, con el pago ya en
    // revisión, aceptado, en la plancha o en camino— sigue el camino de
    // siempre. Mandarle el menú a quien está esperando su comida es contestarle
    // a otra persona… salvo que lo haya pedido él, que entonces es exactamente
    // lo que quería: encargar algo más.
    return input.explicitIntent ? { action: 'menu' } : { action: 'none', reason: 'open_order' };
  }

  return { action: 'menu' };
}
