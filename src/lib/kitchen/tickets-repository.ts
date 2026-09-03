/**
 * Repositorio de cocina — modulo PURO con la fuente de datos INYECTADA.
 *
 * Misma forma que el repositorio del dashboard: la logica y la sanitizacion
 * viven aqui (testeables sin base), y el adaptador Supabase (server-only) solo
 * traduce consultas. La cocina LEE pedidos y escribe `orders.status`; nunca
 * toca `order_notifications`, Telegram, Kapso ni WhatsApp.
 */
import type { OrderStatus, PaymentAttempt, PaymentMethod } from '@/types';
import { businessDayBounds, businessDayOf } from '@/lib/orders/business-day';
import { toPaymentView, type PaymentView } from '@/lib/dashboard/attempt-review';
import type { ProofUiRow } from '@/lib/dashboard/proofs-data-source';
import {
  DISPATCHED_STATUSES,
  isKdsAction,
  nextStage,
  orderStatusForStage,
  stageFromOrderStatus,
  type KdsStage,
} from './kds-status';
import {
  toKitchenTickets,
  type KitchenTicket,
  type RawKitchenItemRow,
  type RawKitchenOrderRow,
} from './ticket-view';
import type { KitchenFailure } from './errors';
import { paymentGateOf, type PaymentGateState } from '@/lib/payment-proof/payment-gate';

export type KitchenUpdateResult = 'updated' | 'conflict' | 'not_found';

export interface KitchenBoardRows {
  rows: RawKitchenOrderRow[];
  /** Items de TODOS los pedidos de la pagina, traidos en una sola consulta. */
  items: RawKitchenItemRow[];
}

/** Intentos y comprobantes de TODOS los pedidos del tablero, en dos consultas. */
export interface KitchenPaymentRows {
  attempts: PaymentAttempt[];
  proofs: ProofUiRow[];
}

/** Adaptador de datos. La implementacion real (Supabase) es server-only. */
export interface KitchenDataSource {
  listBoard(since: string | null, until: string | null): Promise<KitchenBoardRows>;
  /**
   * Pagos de los pedidos del tablero. Opcional a proposito: sin este metodo el
   * KDS se comporta EXACTAMENTE como antes y no pinta seccion de pago, asi que
   * un adaptador antiguo —o un test que no lo necesite— sigue funcionando.
   */
  listPayments?(orderIds: string[]): Promise<KitchenPaymentRows>;
  getStatus(orderNumber: string): Promise<OrderStatus | null>;
  /**
   * Cómo se cobra este pedido y en qué va su pago.
   *
   * Lo necesita la puerta de INICIAR, y por eso se pregunta por NÚMERO de
   * pedido y en el momento de actuar: leerlo del tablero que el navegador tenía
   * cargado dejaría decidir con un pago de hace treinta segundos, que es
   * justo el tiempo que tarda otro en aceptarlo o rechazarlo.
   *
   * Opcional: sin este método la puerta no puede preguntar y se comporta como
   * `unknown` —abre y avisa—, que es el mismo criterio que cuando la consulta
   * falla. Un adaptador antiguo sigue funcionando exactamente como antes.
   */
  paymentFor?(orderNumber: string): Promise<{
    paymentMethod: PaymentMethod | null;
    rows: KitchenPaymentRows;
    orderId: string;
  } | null>;
  updateStatus(orderNumber: string, from: OrderStatus, to: OrderStatus): Promise<KitchenUpdateResult>;
  /**
   * Marca si el envío ya está pagado, tras mirar el comprobante (0033).
   *
   * Opcional: sin este método el tablero se comporta exactamente como antes —la
   * instrucción sale de la deducción y no hay botón que ofrecer—, así que un
   * adaptador antiguo o un test que no lo necesite siguen funcionando.
   */
  setDeliveryFeePaid?(orderNumber: string, paid: boolean): Promise<KitchenUpdateResult>;
}

/**
 * Respuesta del tablero. Solo viajan los tickets y el reloj del servidor: los
 * contadores y el resumen se DERIVAN de los tickets con funciones puras, para
 * que no exista una segunda fuente de verdad que sincronizar a mano.
 */
export interface KitchenBoard {
  tickets: KitchenTicket[];
  serverNow: number;
  /**
   * ¿Se pudo consultar el estado de los pagos? (0028)
   *
   * `false` NO significa "no hay pagos": significa que no lo sabemos. El
   * tablero sigue mostrando todas las comandas y la puerta de INICIAR se abre
   * —parar la cocina por un fallo de la base sería peor— pero la pantalla tiene
   * que DECIRLO. Hasta ahora esa degradación era silenciosa: se cocinaba sin
   * verificar el pago y nada en pantalla lo insinuaba.
   */
  paymentsAvailable: boolean;
}

export type KitchenActionOutcome =
  | { ok: true; stage: KdsStage }
  | { ok: false; reason: KitchenFailure };

export type KitchenCollectOutcome = { ok: true } | { ok: false; reason: KitchenFailure };

export interface KitchenRepository {
  getBoard(nowMs: number): Promise<KitchenBoard>;
  /** `nowMs` inyectable: la ventana de gracia se DERIVA al leer, no con un cron. */
  applyAction(orderNumber: string, action: string, nowMs?: number): Promise<KitchenActionOutcome>;
  /**
   * Deja escrito lo que vio quien miró el comprobante: si el envío está pagado
   * o si hay que cobrarlo al entregar (0033).
   *
   * NO toca el estado del pedido ni la revisión del pago. Son tres dimensiones
   * distintas —qué se cocina, si el pago vale, y qué se cobra en la puerta— y
   * mezclarlas haría que corregir una etiqueta moviera una comanda.
   */
  setDeliveryFeePaid(orderNumber: string, paid: boolean): Promise<KitchenCollectOutcome>;
}

/** Formato del numero de pedido aceptado (misma whitelist que el dashboard). */
const ORDER_NUMBER_RE = /^[A-Za-z0-9-]{1,40}$/;

/**
 * Cuántas jornadas hacia atrás mira el tablero en busca de pedidos VIVOS.
 *
 * Una basta para el caso que trajo esto: un pedido hecho por la mañana cae en
 * la jornada anterior y hay que cocinarlo esa misma noche, así que la distancia
 * máxima es exactamente una. Subirlo arrastraría al grid pedidos olvidados de
 * hace días —confirmados y nunca cocinados— que no son trabajo, son basura de
 * la base, y ocuparían el sitio de una comanda real.
 */
const JORNADAS_DE_ARRASTRE = 1;

/**
 * Reparte las filas del lote por pedido y arma la vista de cada uno.
 *
 * El mapeo lo hace `toPaymentView`, el MISMO que usa el panel del encargado. No
 * se reimplementa: una segunda version del mismo calculo acabaria mostrando el
 * pago de una forma en el KDS y de otra en el panel, y quien decide tiene que
 * ver lo mismo este donde este.
 */
function agruparPagos(rows: KitchenPaymentRows): Record<string, PaymentView> {
  const attemptsPorPedido = new Map<string, PaymentAttempt[]>();
  const proofsPorPedido = new Map<string, ProofUiRow[]>();

  for (const a of rows.attempts) {
    (attemptsPorPedido.get(a.order_id) ?? attemptsPorPedido.set(a.order_id, []).get(a.order_id)!).push(a);
  }
  for (const p of rows.proofs) {
    if (p.order_id === null) continue;
    (proofsPorPedido.get(p.order_id) ?? proofsPorPedido.set(p.order_id, []).get(p.order_id)!).push(p);
  }

  const out: Record<string, PaymentView> = {};
  for (const orderId of new Set([...attemptsPorPedido.keys(), ...proofsPorPedido.keys()])) {
    out[orderId] = toPaymentView(
      attemptsPorPedido.get(orderId) ?? [],
      proofsPorPedido.get(orderId) ?? [],
    );
  }
  return out;
}

/**
 * Consulta la puerta del pago para UN pedido, en el instante de actuar.
 *
 * Nunca lanza. Un fallo de consulta devuelve `unknown`, que ABRE la puerta: es
 * la misma decisión que toma el tablero cuando no puede leer los pagos, y por
 * el mismo motivo — cerrar ante la duda detendría el servicio entero por un
 * hipo de la base, sin ninguna forma de saltarse la puerta desde una tablet.
 */
async function consultarPuerta(
  source: KitchenDataSource,
  orderNumber: string,
  nowMs: number,
) {
  if (!source.paymentFor) return paymentGateOf(null, null, nowMs);
  try {
    const datos = await source.paymentFor(orderNumber);
    // El pedido existe —`getStatus` acaba de encontrarlo— así que un `null`
    // aquí es un fallo de esta consulta, no un pedido ausente.
    if (datos === null) return paymentGateOf('qr', null, nowMs);
    const vista = agruparPagos(datos.rows)[datos.orderId] ?? EMPTY_PAYMENT_VIEW;
    return paymentGateOf(datos.paymentMethod, vista, nowMs);
  } catch {
    return paymentGateOf('qr', null, nowMs);
  }
}

/**
 * Vista de pago vacía: el pedido se consultó y no tiene NADA.
 *
 * Distinta de `null`, que significa "no se pudo consultar". La diferencia
 * decide si la puerta se abre o se cierra, así que no puede quedar implícita.
 */
const EMPTY_PAYMENT_VIEW: PaymentView = {
  attempts: [],
  unlinkedProofs: [],
  hasPendingReview: false,
};

/** Cada estado cerrado dice algo distinto a quien está delante de la plancha. */
function motivoDeBloqueo(state: PaymentGateState): KitchenFailure {
  switch (state) {
    case 'awaiting_review':
    case 'no_proof':
      return 'payment_pending';
    case 'rejected_grace':
      return 'payment_rejected';
    case 'expired':
      return 'payment_expired';
    default:
      // Los estados que abren no llegan aquí. Si alguno lo hiciera, el mensaje
      // genérico es preferible a afirmar un motivo que no se comprobó.
      return 'payment_pending';
  }
}

export function createKitchenRepository(source: KitchenDataSource): KitchenRepository {
  return {
    async getBoard(nowMs) {
      // ── La jornada acota, pero no puede TRAGARSE un pedido vivo ───────────
      //
      // El tablero pedía solo los pedidos de la jornada en curso, y la jornada
      // cambia a las 12:00. Un cliente que escribe a las 09:00 —fuera de
      // horario, con el local cerrado— entra en la jornada ANTERIOR: su pedido
      // se ve un rato, y al dar el mediodía desaparece de la pantalla para
      // siempre. Cuando el local abre a las 18:00, en cocina no existe.
      //
      // Pasó de verdad el 03-09-2026 con `ORD-260902-036`: pedido y comprobante
      // a las 09:10, se le prometió que sería el primero en salir a las 18:00,
      // y a esa hora el KDS no lo tenía. El número lo delataba —`260902` es la
      // jornada anterior— pero en pantalla no había nada que mirar.
      //
      // Así que la ventana se abre una jornada más atrás y el corte se aplica
      // DESPUÉS, distinguiendo lo vivo de lo cerrado: de la jornada anterior
      // solo entra lo que todavía no ha salido de cocina. El historial de
      // "Pedidos listos" sigue siendo el de esta jornada, que es lo que se
      // espera de una lista que se llama "listos hoy".
      const { since } = businessDayBounds(nowMs, -JORNADAS_DE_ARRASTRE);
      // `until` sigue abierto: ningún pedido recién entrado puede quedarse
      // fuera de la pantalla por un desfase de reloj.
      const { rows: todas, items } = await source.listBoard(since, null);

      const jornadaActual = businessDayOf(nowMs);
      const esDeOtraJornada = (row: RawKitchenOrderRow): boolean => {
        const ms = Date.parse(row.created_at);
        // Fecha ilegible: se trata como de hoy. Ante la duda el pedido ENTRA —
        // perder una comanda es peor que ver una de más.
        if (Number.isNaN(ms)) return false;
        return businessDayOf(ms) !== jornadaActual;
      };
      const rows = todas.filter(
        (r) => !esDeOtraJornada(r) || stageFromOrderStatus(r.status) !== 'done',
      );

      // ── El pago NO puede tumbar el tablero ────────────────────────────────
      //
      // Desde que el comprobante decide la ENTRADA al tablero, "no hay pagos" y
      // "no pude consultar los pagos" dejaron de significar lo mismo, y
      // confundirlos vacía la cocina: sin datos, todo pedido por QR parece no
      // haber pagado y se filtra entero.
      //
      // Por eso el fallo se marca en vez de devolver un mapa vacio. Cuando no se
      // pudo consultar, el filtro se desactiva y entran todos los tickets — la
      // cocina puede quedarse sin ver el estado del pago, pero nunca sin
      // comandas. Perder la seccion de pago es molesto; perder la pantalla en
      // plena noche no es recuperable.
      let payments: Record<string, PaymentView> = {};
      let pagosConsultados = false;
      if (source.listPayments) {
        try {
          payments = agruparPagos(await source.listPayments(rows.map((r) => r.id)));
          pagosConsultados = true;
        } catch {
          payments = {};
        }
      }

      // Los arrastrados se MARCAN, no se disfrazan. En el grid el número sale
      // sin la fecha (`ORD-036`), así que un pedido de anoche y uno de hoy
      // pueden verse idénticos: sin esta marca, la solución al pedido perdido
      // crearía una confusión nueva delante de la plancha.
      const arrastrados = new Set(
        todas.filter(esDeOtraJornada).map((r) => r.order_number),
      );
      const tickets = toKitchenTickets(rows, items, payments, pagosConsultados, nowMs).map((t) =>
        arrastrados.has(t.orderNumber) ? { ...t, fromPreviousDay: true } : t,
      );

      return {
        tickets,
        serverNow: nowMs,
        // Sin el método cableado tampoco se consultaron: un adaptador antiguo
        // no puede afirmar que el pago esté verificado.
        paymentsAvailable: pagosConsultados,
      };
    },

    async applyAction(orderNumber, action, nowMs = Date.now()) {
      if (!ORDER_NUMBER_RE.test(orderNumber)) return { ok: false, reason: 'not_found' };
      if (!isKdsAction(action)) return { ok: false, reason: 'invalid_action' };

      const status = await source.getStatus(orderNumber);
      if (status === null) return { ok: false, reason: 'not_found' };
      // El encargado ya lo despacho: la cocina no lo recupera, y el cocinero
      // merece leerlo asi y no un error tecnico.
      if (DISPATCHED_STATUSES.includes(status)) return { ok: false, reason: 'dispatched' };

      const stage = stageFromOrderStatus(status);
      // `draft` / `awaiting_location`: aun no es cocinable, no esta en el tablero.
      if (stage === null) return { ok: false, reason: 'not_found' };
      if (stage === 'cancelled') return { ok: false, reason: 'cancelled' };

      const target = nextStage(stage, action);
      if (target === null) return { ok: false, reason: 'invalid_transition' };

      // ── LA PUERTA DEL PAGO ──────────────────────────────────────────────
      //
      // Solo sobre `start`, y a propósito. Las demás acciones operan sobre un
      // pedido que YA se empezó: frenar un `complete` porque el pago se
      // discute después dejaría la hamburguesa hecha y el ticket sin poder
      // cerrarse, y hacerla desaparecer no la devuelve al refrigerador.
      //
      // La puerta va DESPUÉS de validar la transición para que un `start`
      // imposible siga diciendo "esa acción no está disponible" en vez de
      // hablar del pago de un pedido que ni siquiera podía arrancar.
      if (action === 'start') {
        const puerta = await consultarPuerta(source, orderNumber, nowMs);
        if (!puerta.canStart) {
          return { ok: false, reason: motivoDeBloqueo(puerta.state) };
        }
      }

      // Guarda optimista: solo escribe si el estado sigue siendo el que leimos,
      // para que dos cocineros tocando a la vez no se pisen.
      const res = await source.updateStatus(orderNumber, status, orderStatusForStage(target));
      if (res === 'updated') return { ok: true, stage: target };
      if (res === 'not_found') return { ok: false, reason: 'not_found' };
      return { ok: false, reason: 'conflict' };
    },

    async setDeliveryFeePaid(orderNumber, paid) {
      if (!ORDER_NUMBER_RE.test(orderNumber)) return { ok: false, reason: 'not_found' };
      if (typeof paid !== 'boolean') return { ok: false, reason: 'invalid_action' };
      // Sin adaptador que sepa escribirla, se dice que no se pudo. Nunca se
      // responde `ok` a algo que no se guardó: el chip volvería a su valor de
      // antes en el siguiente refresco y nadie sabría por qué.
      if (!source.setDeliveryFeePaid) return { ok: false, reason: 'error' };

      const res = await source.setDeliveryFeePaid(orderNumber, paid);
      // `not_found` cubre el pedido que no existe y el que no es delivery: en
      // recojo no hay puerta donde cobrar, así que la marca no se guarda.
      return res === 'updated' ? { ok: true } : { ok: false, reason: 'not_found' };
    },
  };
}
