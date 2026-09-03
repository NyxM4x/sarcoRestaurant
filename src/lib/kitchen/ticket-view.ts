/**
 * Sanitizacion del ticket de cocina — modulo PURO.
 *
 * El cocinero ve lo justo para cocinar: numero de pedido, cuando entro a
 * cocina, etapa, tipo de entrega, los platos y las notas. NUNCA telefono,
 * direccion ni coordenadas. No es solo que la pantalla no los pinte: es que no
 * viajan en la respuesta.
 *
 * ── Por que viaja un IMPORTE, y por que solo uno ────────────────────────────
 *
 * Desde que cocina revisa los comprobantes, el monto dejo de ser un dato
 * administrativo y paso a ser una herramienta de trabajo: sin el, mirar un
 * comprobante no es validarlo. Se puede aceptar un pago de Bs 20 para un pedido
 * de Bs 64 y nadie lo nota hasta el cierre de caja.
 *
 * Viaja UNA sola cifra: lo que el cliente debia transferir por QR. Ni total, ni
 * subtotal, ni envio por separado. Dos cifras en un ticket que se mira a un
 * metro y con prisa es una invitacion a comparar el comprobante contra la
 * equivocada — que es justo el error que este dato viene a evitar.
 *
 * ── Y por que ese importe NO es el total ────────────────────────────────────
 *
 * En delivery, por QR se cobra solo la comida: el envio lo paga el cliente al
 * recibir el pedido, y el mensaje del QR se lo advierte. Asi que el comprobante
 * correcto vale el SUBTOTAL, y comparar contra el total haria rechazar pagos
 * buenos — con el cliente esperando y la comida sin empezar.
 *
 * En recojo no hay envio que cobrar aparte, asi que se paga todo por QR y el
 * importe a validar es el total. La cifra correcta depende del tipo de entrega,
 * y por eso se calcula aqui una vez y no en cada pantalla que la use.
 */
import type { OrderStatus, DeliveryType, MenuCategory, PaymentMethod } from '@/types';
import type { PaymentView, ProofAmountLabelView } from '@/lib/dashboard/attempt-review';
import { amountDueByQrOf } from '@/lib/orders/amount-due';
import { stageFromOrderStatus, type KdsStage } from './kds-status';
import { paymentGateOf, type PaymentGate } from '@/lib/payment-proof/payment-gate';

/** Fila cruda minima de `orders` (mas `id`, solo para unir los items server-side). */
export interface RawKitchenOrderRow {
  id: string;
  order_number: string;
  status: OrderStatus;
  delivery_type: DeliveryType;
  notes: string | null;
  created_at: string;
  /** Instante en que el pedido quedo confirmado; base de la antiguedad en cocina. */
  confirmed_at: string | null;
  /** Ultimo cambio de estado: sirve como hora de completado en el historial. */
  updated_at: string;
  /**
   * Importes del pedido. Opcionales porque `numeric` puede no venir en una fila
   * antigua o en un adaptador que no los pida; ausentes se tratan como 0, nunca
   * como `NaN`.
   */
  total_amount?: number | string | null;
  subtotal_amount?: number | string | null;
  /**
   * Como se paga el pedido. NO viaja al ticket: solo decide si el pedido entra
   * al tablero, porque un pedido por QR espera comprobante y uno historico en
   * efectivo no tiene ninguno que esperar.
   */
  payment_method?: PaymentMethod | null;
  /**
   * Lo que dijo una PERSONA sobre el envío, tras mirar el comprobante (0033).
   *
   * `null`/ausente = nadie se pronunció y manda la deducción. `true` = el envío
   * está pagado. `false` = hay que cobrarlo. Los tres estados son distintos: no
   * es lo mismo "no consta" que "consta que hay que cobrar".
   */
  delivery_fee_paid?: boolean | null;
}

/** Fila cruda minima de `order_items`: producto y cantidad, nada de precios. */
export interface RawKitchenItemRow {
  order_id: string;
  product_name_snapshot: string;
  quantity: number;
  /**
   * Categoría del producto, resuelta contra el catálogo al leer.
   *
   * `null` cuando no se pudo averiguar —un producto borrado, o un snapshot de
   * un combo con un código que ya no existe—. Se distingue de las tres
   * categorías reales a propósito: colocarlo en "comidas" por defecto pondría
   * un refresco en la plancha.
   */
  category?: MenuCategory | null;
}

/**
 * Linea del ticket. `modifiers` queda preparado para pintar "– sin cebolla" o
 * "– extra tocino", pero HOY llega siempre vacio: `order_items` no guarda
 * modificadores y `orders.notes` es texto libre a nivel de pedido. No se
 * inventa ningun parseo heuristico para adivinar a que plato pertenece cada
 * indicacion; capturarlos de verdad pide una columna nueva y tocar el checkout.
 */
export interface KitchenTicketLine {
  name: string;
  quantity: number;
  modifiers: string[];
  /** Para agrupar el resumen del planchero. `null` = no se pudo resolver. */
  category: MenuCategory | null;
}

/**
 * Qué hay que cobrar en la puerta al entregar.
 *
 * Nace de un problema de coordinación real: quien cocina y empaca no podía
 * decirle al repartidor si ese cliente ya había pagado el envío o solo la
 * comida, y el repartidor lo averiguaba preguntando en la puerta.
 *
 * Se DERIVA del pedido, no del comprobante, y esa es la diferencia que importa:
 * la etiqueta del análisis solo existe si el modelo pudo leer la imagen y sacar
 * un monto, así que un fallo de lectura dejaba al repartidor sin instrucción
 * ninguna. Esto sale de tres datos que el pedido siempre tiene —tipo de entrega,
 * método de pago e importes— y por eso está siempre.
 *
 * `null` cuando no hay nada que cobrar o no se puede afirmar: en recojo no hay
 * puerta donde cobrar, y de un pedido histórico sin método de pago registrado no
 * se deduce nada. Callar es lo correcto ahí: mandar cobrar a quien ya pagó es
 * peor que no decir nada, porque el repartidor de todos modos puede preguntar.
 */
export type DeliveryCollectKind =
  /** Ya está todo pagado: no se cobra nada al entregar. */
  | { kind: 'pagado' }
  /** Falta el envío. El caso normal en delivery por QR. */
  | { kind: 'envio'; amount: number }
  /** Falta todo: pedido en efectivo. */
  | { kind: 'todo'; amount: number };

/**
 * De dónde sale la instrucción — y con ella, cuánta confianza merece.
 *
 * No es un adorno: separa "el comprobante dice que pagó solo la comida" de
 * "nadie pudo leer el comprobante, así que aplicamos la regla general". Las dos
 * frases acababan en el mismo chip azul, y la segunda mandaba cobrar un envío
 * que quizá ya estaba pagado.
 *
 *   `persona`      alguien miró el comprobante y lo marcó. Manda sobre todo.
 *   `comprobante`  lo dice la etiqueta del análisis. Es un dato leído.
 *   `pedido`       nadie leyó nada; sale de la regla general. Hay que
 *                  confirmarlo antes de cobrar.
 */
export type DeliveryCollectBasis = 'persona' | 'comprobante' | 'pedido';

export type DeliveryCollect = DeliveryCollectKind & {
  basis: DeliveryCollectBasis;
  /**
   * ¿Se le puede ofrecer a quien empaca el botón para marcarlo a mano?
   *
   * Solo cuando la instrucción NO está confirmada por una lectura: si el
   * comprobante dice con claridad qué pagó, un botón al lado solo invita a
   * contradecir un dato bueno.
   *
   * ── Y solo ANTES de aceptar el comprobante (03-09-2026) ────────────────────
   *
   * Aceptar el pago es el instante en que sale el aviso al grupo de reparto
   * (`decide-attempt`), y ese mensaje lleva dentro esta misma instrucción. A
   * partir de ahí la marca deja de ser una nota de pantalla: es lo que ya está
   * escrito en el teléfono de quien reparte, y cambiarla en el KDS no cambia el
   * mensaje —solo hace que las dos pantallas digan cosas distintas del mismo
   * pedido, con el repartidor en la puerta—.
   *
   * Los botones vivían además en "Pedidos listos", que es la pantalla que queda
   * abierta mientras se empaca: dos botones grandes uno al lado del otro, sobre
   * un pedido ya cerrado, a un toque de decir que no se cobre un envío que sí
   * hay que cobrar. Después de aceptar, esto es un TÍTULO y no un control.
   */
  canOverride: boolean;
};

export interface KitchenTicket {
  orderNumber: string;
  /** Instante de entrada A COCINA: `confirmed_at ?? created_at`. */
  enteredAt: string;
  stage: KdsStage;
  deliveryType: DeliveryType;
  lines: KitchenTicketLine[];
  notes: string | null;
  /** Hora en que se marco listo (solo etapa `done`); alimenta el historial. */
  completedAt: string | null;
  /**
   * Lo que el cliente debia transferir por QR: la cifra contra la que se
   * contrasta el comprobante. En delivery es la comida (el envio se paga al
   * recibir); en recojo, el total.
   */
  amountDueByQr: number;
  /**
   * ¿Este pedido sigue esperando que alguien confirme su pago?
   *
   * Es lo que decide si el pedido suma en el RESUMEN de la barra derecha: hasta
   * que el comprobante se acepta, sus productos no entran en el total que mira
   * el planchero. Un pedido en efectivo —o histórico, sin método registrado— no
   * espera nada, y un tablero que no pudo consultar los pagos tampoco afirma que
   * esté esperando: ante la duda, cuenta.
   *
   * NO oculta el ticket ni bloquea ningún botón: la comanda se ve entera y se
   * puede iniciar igual. Solo dice si sus unidades ya son trabajo en firme.
   */
  awaitingPaymentConfirmation: boolean;
  /**
   * Pago del pedido: intentos y comprobantes, ya en forma de vista.
   *
   * `null` cuando no hay nada que revisar. Es la MISMA estructura que usa el
   * panel del encargado —`toPaymentView`— y no una version reducida: dos vistas
   * distintas del mismo pago acabarian discrepando, y quien decide desde cocina
   * tiene que ver exactamente lo que veria desde el panel.
   */
  payment: PaymentView | null;
  /**
   * ¿Se puede empezar a cocinar este pedido, y si no, por qué? (0028)
   *
   * Viaja YA RESUELTO desde el servidor, no como datos sueltos que la pantalla
   * interprete: la misma regla que bloquea el botón en el navegador es la que
   * rechaza la acción en `applyAction`. Dos implementaciones de la misma puerta
   * acabarían enseñando un botón que el servidor no acepta, que es exactamente
   * la clase de error que no se ve hasta que alguien lo pulsa.
   */
  gate: PaymentGate;
  /**
   * Qué pagó el cliente: los productos solos o también el envío.
   *
   * `null` si no hay análisis o no se pudo comparar. Sale del comprobante más
   * reciente que tenga etiqueta: es el que describe el pago vigente.
   */
  amountLabel: ProofAmountLabelView | null;
  /**
   * Qué se cobra al entregar. Lo lee quien empaca para decírselo a quien lleva.
   *
   * NO expone el método de pago: dice qué hacer, no cómo se pagó. Que en
   * efectivo se cobre todo es una consecuencia, no el dato.
   */
  deliveryCollect: DeliveryCollect | null;
  /**
   * ¿Este pedido viene de una jornada anterior? (03-09-2026)
   *
   * Lo pone `getBoard`, que es quien conoce la ventana: aquí no hay noción de
   * jornada. Ausente —el caso normal— significa "es de hoy".
   *
   * Existe porque el número que se pinta en el grid va sin la fecha
   * (`ORD-036`), así que un pedido arrastrado de anoche y uno de esta noche se
   * ven idénticos. La marca es lo que impide que rescatar un pedido perdido
   * cree una confusión nueva delante de la plancha.
   */
  fromPreviousDay?: boolean;
}

/**
 * Antiguedad del pedido EN COCINA. Lo que le importa al cocinero es cuanto
 * lleva el pedido esperando plancha, no cuanto lleva el cliente en el chat.
 */
export function enteredAtOf(row: RawKitchenOrderRow): string {
  return row.confirmed_at ?? row.created_at;
}

/** ¿Llego algun comprobante para este pedido, aunque no se pudiera guardar? */
function hayComprobante(payment: PaymentView | null): boolean {
  if (payment === null) return false;
  // Cuenta cualquier fila registrada, incluida una `failed`: significa que el
  // cliente mando algo. Que no hayamos podido traer el archivo es justamente lo
  // que cocina tiene que ver, no un motivo para ocultar el pedido.
  if (payment.unlinkedProofs.length > 0) return true;
  return payment.attempts.some((a) => a.proofs.length > 0);
}

/**
 * ¿Sigue este pedido esperando que se confirme su pago?
 *
 * Confirmado = ALGÚN intento aceptado. No "el último": una vez que un pago se
 * acepta, el pedido está pagado, y un comprobante posterior —un duplicado, o un
 * archivo que el cliente reenvía por si acaso— no puede volver a dejarlo a
 * deber. El historial de intentos se conserva entero justamente para eso.
 *
 * Un pedido que no se paga por QR no espera nada: en efectivo se cobra en mano,
 * y los históricos sin método registrado no tienen comprobante que aceptar.
 * Tratarlos como pendientes los borraría para siempre del resumen.
 */
function esperandoConfirmacionDePago(
  row: RawKitchenOrderRow,
  payment: PaymentView | null,
): boolean {
  if (row.payment_method !== 'qr') return false;
  if (payment === null) return true;
  return !pagoAceptadoDe(payment);
}

/**
 * ¿Consta un comprobante ACEPTADO para este pedido?
 *
 * ALGÚN intento aceptado, no el último: aceptar es irreversible en lo que a
 * este archivo respecta —el aviso al grupo de reparto ya salió— y un
 * comprobante posterior no lo deshace.
 *
 * Se pregunta desde dos sitios y por motivos distintos: si el pedido sigue
 * esperando confirmación para el resumen, y si la instrucción de cobro ya está
 * congelada. Es la misma pregunta, así que es la misma función.
 */
function pagoAceptadoDe(payment: PaymentView | null): boolean {
  if (payment === null) return false;
  return payment.attempts.some((a) => a.status === 'accepted');
}

/**
 * ¿Este pedido todavia no debe verse en cocina?
 *
 * Un pedido entra al tablero cuando llega el comprobante, no cuando se le manda
 * el QR. Antes entraba al cotizar: la comanda aparecia vacia, sin nada que
 * revisar, y quien cocinaba tenia delante un pedido que nadie habia pagado.
 *
 * ── Solo frena la ENTRADA, nunca saca un pedido ya empezado ─────────────────
 *
 * La condicion incluye `stage === 'new'` a proposito. Una vez alguien pulso
 * INICIAR, el ticket se queda pase lo que pase con el pago: si se rechaza el
 * comprobante despues, la hamburguesa ya esta en la plancha y hacerla
 * desaparecer de la pantalla no la devuelve al refrigerador — solo deja a quien
 * cocina sin saber que estaba haciendo.
 *
 * ── Y solo aplica a los pedidos que esperan un comprobante ──────────────────
 *
 * Hoy todo se paga por QR, tambien los recojos. Pero los pedidos historicos en
 * efectivo —o con el metodo sin registrar— no tienen comprobante que esperar, y
 * exigirles uno los dejaria invisibles para siempre. Esos entran como antes.
 */
function esperandoComprobante(
  row: RawKitchenOrderRow,
  stage: KdsStage,
  payment: PaymentView | null,
): boolean {
  if (stage !== 'new') return false;
  if (row.payment_method !== 'qr') return false;
  return !hayComprobante(payment);
}

/**
 * Importe que el cliente debia transferir por QR.
 *
 * El calculo vive en `@/lib/orders/amount-due` desde que tiene un segundo
 * consumidor —el analisis automatico del comprobante, que contrasta esa misma
 * cifra sin mirar la pantalla—. Se re-exporta aqui para que quien ya lo
 * importaba del ticket siga encontrandolo donde estaba.
 */
export { amountDueByQrOf };

/** Agrupa las filas de items por `order_id` (una sola consulta las trae todas). */
export function groupItemsByOrder(
  items: RawKitchenItemRow[],
): Record<string, KitchenTicketLine[]> {
  const grouped: Record<string, KitchenTicketLine[]> = {};
  for (const it of items) {
    (grouped[it.order_id] ??= []).push({
      name: it.product_name_snapshot,
      quantity: it.quantity,
      modifiers: [],
      category: it.category ?? null,
    });
  }
  return grouped;
}

/**
 * Convierte filas crudas en tickets ordenados por antiguedad (lo que mas
 * espera, primero). Las filas cuyo estado no pertenece al tablero se descartan.
 */
/**
 * La etiqueta del pago vigente.
 *
 * El comprobante MÁS RECIENTE que tenga etiqueta, no el primero: si el cliente
 * reenvió, lo que vale es lo último que mandó. Se miran también los sueltos,
 * porque un comprobante sin intento sigue siendo dinero que alguien transfirió.
 *
 * ── Por qué se ordena por `receivedAt` y no se recorre la lista al revés ────
 *
 * Porque recorrerla al revés cogía el más ANTIGUO. `toPaymentView` devuelve los
 * intentos del más reciente al más viejo, pero los comprobantes DENTRO de cada
 * intento en orden de llegada: aplanar las dos listas da un orden mixto que no
 * es cronológico ni por un extremo ni por el otro, así que "el último del
 * array" era el último comprobante del intento más viejo.
 *
 * Con un solo intento —el caso normal— coincidía por casualidad, y por eso no
 * se notaba. Con dos, un cliente que reenvía porque su primer pago se rechazó
 * recibía en el ticket la etiqueta del pago rechazado.
 *
 * La fecha no depende de cómo venga ordenada ninguna lista, así que no vuelve a
 * romperse si mañana se cambia el orden de una de las dos.
 */
function etiquetaDelPago(payment: PaymentView | null): ProofAmountLabelView | null {
  if (payment === null) return null;

  const conEtiqueta = [
    ...payment.attempts.flatMap((a) => a.proofs),
    ...payment.unlinkedProofs,
  ].filter((p) => p.amountLabel !== null);
  if (conEtiqueta.length === 0) return null;

  // Una fecha ilegible va al fondo: nunca puede ganarle a una que sí se lee.
  const cuando = (iso: string): number => {
    const ms = Date.parse(iso);
    return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
  };
  return conEtiqueta.reduce((masReciente, p) =>
    cuando(p.receivedAt) >= cuando(masReciente.receivedAt) ? p : masReciente,
  ).amountLabel;
}

/**
 * Qué se cobra en la puerta.
 *
 * El orden de las preguntas es el de la autoridad, de más a menos: primero si
 * hay puerta —en recojo no la hay—, luego lo que dijo una PERSONA que miró el
 * comprobante, después lo que leyó el análisis, y solo al final la regla
 * general del pedido, que no es una lectura sino una deducción.
 *
 * El envío se calcula restando y no se pide como columna aparte: el total y el
 * subtotal ya viajan al tablero, y una tercera cifra que hubiera que mantener en
 * paz con las otras dos es una oportunidad más de que discrepen.
 *
 * ── Se EXPORTA porque tiene un segundo consumidor (03-09-2026) ─────────────
 *
 * El aviso al grupo de reparto responde exactamente la misma pregunta —¿se
 * cobra el envío en la puerta?— y llegó a este archivo por el mismo camino que
 * `amountDueByQrOf`: dos cálculos de lo mismo acaban discrepando, y discrepan
 * en silencio. Aquí sería peor que en una pantalla: el ticket diría una cosa a
 * quien empaca y el mensaje de Telegram otra a quien reparte, sobre el mismo
 * pedido y con el cliente delante.
 *
 * ── Por qué la última rama se marca como NO confirmada (03-09-2026) ─────────
 *
 * Porque afirmaba. Sin etiqueta que leer, el ticket decía "COBRAR ENVÍO Bs 27"
 * con la misma seguridad que cuando el comprobante lo confirmaba, y quien lo
 * leía no tenía forma de distinguir un dato de una suposición. Cinco pedidos de
 * veintidós salieron así en una sola noche.
 *
 * No se calla —el repartidor necesita una instrucción, y ese fue el motivo de
 * que esto exista— pero dice de dónde sale, y ofrece el botón para resolverlo
 * mirando la imagen, que es lo único que de verdad lo resuelve.
 */
export function deliveryCollectOf(
  row: RawKitchenOrderRow,
  etiqueta: ProofAmountLabelView | null,
  /**
   * ¿Hay ya un comprobante ACEPTADO para este pedido?
   *
   * Cierra la marca a mano: ver `canOverride`. Por defecto `false` —"no consta
   * que se haya aceptado"— para que quien llame sin saberlo, como el aviso al
   * grupo de reparto, se comporte exactamente como antes.
   */
  pagoAceptado = false,
): DeliveryCollect | null {
  if (row.delivery_type !== 'delivery') return null;

  /** Aceptado el pago, la instrucción es un título y ya no un control. */
  const sePuedeMarcar = !pagoAceptado;

  const total = Number(row.total_amount) || 0;
  const subtotal = Number(row.subtotal_amount) || 0;
  const envio = total - subtotal;

  /** Lo que falta cobrar según cómo se pagó, sin mirar ningún comprobante. */
  const segunElPedido = (): DeliveryCollectKind | null => {
    if (row.payment_method === 'cash') {
      return total > 0 ? { kind: 'todo', amount: total } : null;
    }
    if (row.payment_method === 'qr') {
      return envio > 0 ? { kind: 'envio', amount: envio } : { kind: 'pagado' };
    }
    // Sin método de pago registrado no se deduce nada.
    return null;
  };

  // 1. La palabra de quien miró el comprobante. Gana sobre todo lo demás, y se
  //    puede volver a cambiar: quien se equivoca tiene que poder corregirse.
  if (row.delivery_fee_paid === true) {
    return { kind: 'pagado', basis: 'persona', canOverride: sePuedeMarcar };
  }
  if (row.delivery_fee_paid === false) {
    const deducido = segunElPedido();
    // Marcar "hay que cobrarlo" sobre un pedido sin importes no inventa cifra:
    // se dice lo que se sabe, que es que falta el envío.
    return deducido !== null && deducido.kind !== 'pagado'
      ? { ...deducido, basis: 'persona', canOverride: sePuedeMarcar }
      : {
          kind: 'envio',
          amount: envio > 0 ? envio : 0,
          basis: 'persona',
          canOverride: sePuedeMarcar,
        };
  }

  // 2. Lo que leyó el análisis. Un pago por el total cubre el envío aunque la
  //    regla general dijera lo contrario.
  if (etiqueta?.code === 'pago_total') {
    return { kind: 'pagado', basis: 'comprobante', canOverride: false };
  }

  const deducido = segunElPedido();
  if (deducido === null) return null;

  // 3. `pago_productos` confirma la deducción: el comprobante cuadró con el
  //    subtotal, así que falta el envío y eso es un dato, no una suposición.
  if (etiqueta?.code === 'pago_productos') {
    return { ...deducido, basis: 'comprobante', canOverride: false };
  }

  // 4. Lo que queda —sin etiqueta, o `revisar_monto`— es una deducción. Se dice
  //    igual, pero marcada como tal y con el botón para zanjarla mientras el
  //    pago siga en revisión. Aceptado el comprobante, la deducción ya viajó al
  //    grupo de reparto: se congela con su aviso de "sin confirmar" a la vista,
  //    que es exactamente lo que el repartidor tiene escrito.
  return { ...deducido, basis: 'pedido', canOverride: sePuedeMarcar };
}

export function toKitchenTickets(
  rows: RawKitchenOrderRow[],
  items: RawKitchenItemRow[],
  /** Pago por `order_id`. Ausente = el tablero se pinta sin seccion de pago. */
  payments: Record<string, PaymentView> = {},
  /**
   * ¿Se pudo consultar el pago de verdad?
   *
   * `false` NO significa "no hay comprobantes": significa que no lo sabemos. Sin
   * esta distincion, un fallo de la consulta haria desaparecer del tablero todos
   * los pedidos por QR —parecerian impagados— y la cocina se quedaria sin
   * comandas. Ante la duda entran todos: es preferible ver un pedido de mas que
   * perder la pantalla entera.
   */
  pagosConsultados = false,
  /**
   * Reloj del servidor. La ventana de gracia se DERIVA aquí, en tiempo de
   * lectura: no hay cron que cancele pedidos, así que el estado que ve la
   * cocina se calcula cada vez que se pinta el tablero.
   */
  nowMs: number = Date.now(),
): KitchenTicket[] {
  const lines = groupItemsByOrder(items);
  const tickets: KitchenTicket[] = [];
  for (const row of rows) {
    const stage = stageFromOrderStatus(row.status);
    if (stage === null) continue;

    const payment = payments[row.id] ?? null;
    if (pagosConsultados && esperandoComprobante(row, stage, payment)) continue;

    // Una sola vez: la usan la etiqueta y el cálculo de lo que se cobra.
    const etiqueta = etiquetaDelPago(payment);

    tickets.push({
      orderNumber: row.order_number,
      enteredAt: enteredAtOf(row),
      stage,
      deliveryType: row.delivery_type,
      lines: lines[row.id] ?? [],
      notes: row.notes,
      completedAt: stage === 'done' ? row.updated_at : null,
      amountDueByQr: amountDueByQrOf(row),
      // Sin haber podido consultar los pagos no se afirma que falte confirmar:
      // eso vaciaría el resumen entero por un fallo de consulta, que es la misma
      // trampa que ya evita el filtro de entrada de arriba.
      awaitingPaymentConfirmation: pagosConsultados && esperandoConfirmacionDePago(row, payment),
      payment,
      // Sin haber podido consultar los pagos se pasa `null`, que la puerta lee
      // como `unknown`: abre y lo dice. Pasar la vista vacía diría "este
      // pedido no ha pagado nada", que es una afirmación que nadie comprobó.
      gate: paymentGateOf(row.payment_method ?? null, pagosConsultados ? payment : null, nowMs),
      amountLabel: etiqueta,
      // Sin haber podido consultar los pagos no se afirma que el comprobante
      // esté aceptado, así que la marca sigue disponible: congelar por un fallo
      // de consulta dejaría a quien empaca sin forma de corregir una deducción
      // equivocada, que es lo contrario de lo que este candado protege.
      deliveryCollect: deliveryCollectOf(
        row,
        etiqueta,
        pagosConsultados && pagoAceptadoDe(payment),
      ),
    });
  }
  return sortByAge(tickets);
}

/** Orden del grid: lo mas antiguo primero. Fechas ilegibles van al final. */
export function sortByAge(tickets: KitchenTicket[]): KitchenTicket[] {
  const key = (t: KitchenTicket): number => {
    const ms = Date.parse(t.enteredAt);
    return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms;
  };
  return [...tickets].sort((a, b) => key(a) - key(b));
}
