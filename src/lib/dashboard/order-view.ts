/**
 * Sanitización y presentación de pedidos para el dashboard — módulo PURO.
 *
 * Convierte filas crudas de la base en vistas SEGURAS: nunca expone order_id
 * (UUID), claim_token, wamid, external_message_id, payloads, secretos, detalles
 * internos de recuperación ni errores técnicos. Solo datos operativos.
 */
import type {
  OrderStatus,
  DeliveryType,
  PaymentMethod,
  DeliveryPricing,
  DeliveryQuoteStatus,
} from '@/types';
import { deliveryQuoteView, type DeliveryStateView } from './delivery-state';

/** Fila cruda mínima de `orders` (más `id` solo para joins server-side). */
export interface RawOrderRow {
  id: string;
  order_number: string;
  customer_name: string | null;
  customer_phone: string | null;
  delivery_type: DeliveryType;
  status: OrderStatus;
  subtotal_amount: number;
  delivery_amount: number;
  total_amount: number;
  currency: string;
  notes: string | null;
  /** Método de pago (6D.1). `null` en históricos y pedidos del WhatsApp Flow. */
  payment_method: PaymentMethod | null;
  delivery_address: string | null;
  delivery_location_name: string | null;
  delivery_latitude: number | null;
  delivery_longitude: number | null;
  /** Modo de tarificación (6D.2B). `'dynamic'` → envío cotizado con Mapbox; `null` → legacy/pickup. */
  delivery_pricing: DeliveryPricing | null;
  /** Estado de la cotización dinámica (6D.2B). `null` → no aplica (legacy/pickup). */
  delivery_quote_status: DeliveryQuoteStatus | null;
  /** Distancia de ruta real en metros (6D.2A). `null` hasta que se cotiza. */
  delivery_distance_meters: number | null;
  created_at: string;
  updated_at: string;
  confirmed_at: string | null;
}

/** Señales sanitizadas derivadas de `order_notifications` (sin detalles). */
export interface OrderNotificationFlags {
  manualReview: boolean;
  /** Cualquier incidencia de notificación (terminal/failed): solo un booleano. */
  notificationIssue: boolean;
}

export interface RawOrderItemRow {
  product_name_snapshot: string;
  unit_price_snapshot: number;
  quantity: number;
  subtotal: number;
}

/** Vista de lista: sin identificadores técnicos, sin teléfono. */
export interface OrderListItem {
  orderNumber: string;
  createdAt: string;
  status: OrderStatus;
  deliveryType: DeliveryType;
  /** Método de pago (6D.1). `null` → sin chip (histórico / Flow). */
  paymentMethod: PaymentMethod | null;
  total: number;
  currency: string;
  itemCount: number;
  customerName: string | null;
  locationPending: boolean;
  manualReview: boolean;
  notificationIssue: boolean;
  /** Estado de envío dinámico para el chip (6D.2D). `null` en pickup/legacy. */
  deliveryState: DeliveryStateView | null;
  /**
   * Hay un comprobante esperando decisión (0021). Es una dimensión SEPARADA del
   * estado operativo: un pedido puede estar "En preparación" y a la vez tener el
   * pago sin revisar.
   */
  paymentPendingReview: boolean;
}

export interface OrderDetailItem {
  name: string;
  quantity: number;
  unitPrice: number;
  subtotal: number;
}

/** Vista de detalle: incluye contacto operativo, nunca campos técnicos. */
export interface OrderDetail {
  orderNumber: string;
  createdAt: string;
  updatedAt: string;
  confirmedAt: string | null;
  status: OrderStatus;
  deliveryType: DeliveryType;
  items: OrderDetailItem[];
  subtotal: number;
  deliveryAmount: number;
  total: number;
  currency: string;
  notes: string | null;
  /** Teléfono de contacto: dato operativo permitido en el detalle. */
  contactPhone: string | null;
  customerName: string | null;
  /** Método de pago (6D.1). `null` → sin chip (histórico / Flow). */
  paymentMethod: PaymentMethod | null;
  deliveryAddress: string | null;
  deliveryLocationName: string | null;
  /** Coordenadas de entrega (dato operativo para el repartidor, solo delivery). */
  deliveryLatitude: number | null;
  deliveryLongitude: number | null;
  locationPending: boolean;
  manualReview: boolean;
  notificationIssue: boolean;
  /** Estado de envío dinámico (6D.2D). `null` en pickup/legacy. */
  deliveryState: DeliveryStateView | null;
  /** Distancia de ruta en metros (6D.2D), solo delivery. `null` si no aplica/aún. */
  deliveryDistanceMeters: number | null;
}

/** ¿Falta la ubicación de un pedido de delivery? (dato operativo, no técnico) */
export function isLocationPending(row: RawOrderRow): boolean {
  if (row.delivery_type !== 'delivery') return false;
  const noCoords = row.delivery_latitude === null || row.delivery_longitude === null;
  // 6D.2D: en delivery DINÁMICO, "ubicación pendiente" solo si aún NO hay GPS. Con
  // coordenadas guardadas el estado real lo comunica el chip de cotización
  // (quoting/failed/out_of_coverage/quoted), no este flag genérico.
  if (row.delivery_pricing === 'dynamic') return noCoords;
  // Legacy (`delivery_pricing` NULL): comportamiento previo INTACTO.
  if (row.status === 'awaiting_location') return true;
  return noCoords;
}

/** Deriva el estado de envío dinámico para las vistas (6D.2D). `null` si no aplica. */
function deliveryStateOf(row: RawOrderRow): DeliveryStateView | null {
  return deliveryQuoteView({
    deliveryType: row.delivery_type,
    deliveryPricing: row.delivery_pricing,
    deliveryQuoteStatus: row.delivery_quote_status,
    hasCoordinates: row.delivery_latitude !== null && row.delivery_longitude !== null,
  });
}

const NO_FLAGS: OrderNotificationFlags = { manualReview: false, notificationIssue: false };

export function toOrderListItem(
  row: RawOrderRow,
  itemCount: number,
  flags: OrderNotificationFlags = NO_FLAGS,
  paymentPendingReview = false,
): OrderListItem {
  return {
    orderNumber: row.order_number,
    createdAt: row.created_at,
    status: row.status,
    deliveryType: row.delivery_type,
    paymentMethod: row.payment_method,
    total: row.total_amount,
    currency: row.currency,
    itemCount,
    customerName: row.customer_name,
    locationPending: isLocationPending(row),
    manualReview: flags.manualReview,
    notificationIssue: flags.notificationIssue,
    deliveryState: deliveryStateOf(row),
    paymentPendingReview,
  };
}

export function toOrderDetail(
  row: RawOrderRow,
  items: RawOrderItemRow[],
  flags: OrderNotificationFlags = NO_FLAGS,
): OrderDetail {
  return {
    orderNumber: row.order_number,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    confirmedAt: row.confirmed_at,
    status: row.status,
    deliveryType: row.delivery_type,
    items: items.map((it) => ({
      name: it.product_name_snapshot,
      quantity: it.quantity,
      unitPrice: it.unit_price_snapshot,
      subtotal: it.subtotal,
    })),
    subtotal: row.subtotal_amount,
    deliveryAmount: row.delivery_amount,
    total: row.total_amount,
    currency: row.currency,
    notes: row.notes,
    contactPhone: row.customer_phone,
    customerName: row.customer_name,
    paymentMethod: row.payment_method,
    deliveryAddress: row.delivery_type === 'delivery' ? row.delivery_address : null,
    deliveryLocationName: row.delivery_type === 'delivery' ? row.delivery_location_name : null,
    deliveryLatitude: row.delivery_type === 'delivery' ? row.delivery_latitude : null,
    deliveryLongitude: row.delivery_type === 'delivery' ? row.delivery_longitude : null,
    locationPending: isLocationPending(row),
    manualReview: flags.manualReview,
    notificationIssue: flags.notificationIssue,
    deliveryState: deliveryStateOf(row),
    deliveryDistanceMeters:
      row.delivery_type === 'delivery' ? row.delivery_distance_meters : null,
  };
}

/**
 * Tarjetas de resumen — lenguaje OPERATIVO simplificado (Fase 6C). Los
 * contadores se derivan de los estados internos reales, pero se agrupan en las
 * etapas que el encargado gestiona. No hay tarjeta "Confirmados".
 *
 * - `preparing`  = "En preparación"      (awaiting_location + confirmed + preparing)
 * - `ready`      = "En camino / Listos"  (ready + on_the_way)
 * - `completed`  = "Entregados"          (delivered)
 * Los `draft` (borradores del Flow) NUNCA cuentan: la fuente ya los excluye del
 * conteo, y aquí tampoco se suman. Los cancelados no se muestran como tarjeta.
 */
export interface OrderSummary {
  today: number;
  preparing: number;
  ready: number;
  completed: number;
}

export type StatusCounts = Partial<Record<OrderStatus, number>>;

const n = (counts: StatusCounts, s: OrderStatus): number => counts[s] ?? 0;

export function summarize(counts: StatusCounts, todayCount: number): OrderSummary {
  return {
    today: todayCount,
    // "En preparación": todo lo que el encargado aún está atendiendo antes del
    // despacho (awaiting_location/confirmed y el legacy preparing). `draft` NO
    // se cuenta: es un borrador del Flow que el cliente aún no confirmó.
    preparing:
      n(counts, 'awaiting_location') +
      n(counts, 'confirmed') +
      n(counts, 'preparing'),
    // "En camino / Listos": en reparto (on_the_way) o listos para recoger (ready).
    ready: n(counts, 'ready') + n(counts, 'on_the_way'),
    completed: n(counts, 'delivered'),
  };
}
