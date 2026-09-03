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
export type DeliveryCollect =
  /** Ya está todo pagado: no se cobra nada al entregar. */
  | { kind: 'pagado' }
  /** Falta el envío. El caso normal en delivery por QR. */
  | { kind: 'envio'; amount: number }
  /** Falta todo: pedido en efectivo. */
  | { kind: 'todo'; amount: number };

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
  return !payment.attempts.some((a) => a.status === 'accepted');
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
 */
function etiquetaDelPago(payment: PaymentView | null): ProofAmountLabelView | null {
  if (payment === null) return null;
  const todos = [
    ...payment.attempts.flatMap((a) => a.proofs),
    ...payment.unlinkedProofs,
  ];
  for (let i = todos.length - 1; i >= 0; i -= 1) {
    if (todos[i].amountLabel !== null) return todos[i].amountLabel;
  }
  return null;
}

/**
 * Qué se cobra en la puerta.
 *
 * El orden de las preguntas es el de la realidad: primero si hay puerta —en
 * recojo no la hay—, luego si el comprobante ya probó que está todo pagado, y
 * solo entonces cuánto falta según cómo se pagó.
 *
 * El envío se calcula restando y no se pide como columna aparte: el total y el
 * subtotal ya viajan al tablero, y una tercera cifra que hubiera que mantener en
 * paz con las otras dos es una oportunidad más de que discrepen.
 */
function cobroEnLaPuerta(
  row: RawKitchenOrderRow,
  etiqueta: ProofAmountLabelView | null,
): DeliveryCollect | null {
  if (row.delivery_type !== 'delivery') return null;

  // El comprobante manda sobre la regla: si se leyó un pago por el total, el
  // envío ya está cubierto aunque la regla general dijera lo contrario.
  if (etiqueta?.code === 'pago_total') return { kind: 'pagado' };

  const total = Number(row.total_amount) || 0;
  const subtotal = Number(row.subtotal_amount) || 0;

  if (row.payment_method === 'cash') {
    return total > 0 ? { kind: 'todo', amount: total } : null;
  }
  if (row.payment_method === 'qr') {
    const envio = total - subtotal;
    return envio > 0 ? { kind: 'envio', amount: envio } : { kind: 'pagado' };
  }

  // Sin método de pago registrado no se afirma nada.
  return null;
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
      deliveryCollect: cobroEnLaPuerta(row, etiqueta),
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
