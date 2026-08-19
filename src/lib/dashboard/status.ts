/**
 * Máquina de estados operativa del dashboard — módulo PURO (sin server-only,
 * seguro para importar desde componentes cliente).
 *
 * Usa EXCLUSIVAMENTE los estados reales de `orders.status` (migración 0001). No
 * inventa estados ni modifica los valores guardados: solo aporta etiquetas
 * visuales, tonos accesibles y las transiciones operativas permitidas.
 */
import type { OrderStatus, DeliveryType } from '@/types';

/** Tono semántico del badge. La comunicación NUNCA depende solo del color: */
/** siempre se acompaña de la etiqueta de texto (y un punto). */
export type StatusTone =
  | 'gray' | 'amber' | 'blue' | 'indigo' | 'teal' | 'purple' | 'green' | 'red';

export interface StatusMeta {
  label: string;
  tone: StatusTone;
}

/** Etiqueta visual + tono por estado. Los valores internos no cambian. */
export const STATUS_META: Record<OrderStatus, StatusMeta> = {
  draft: { label: 'Borrador', tone: 'gray' },
  awaiting_location: { label: 'Esperando ubicación', tone: 'amber' },
  confirmed: { label: 'Confirmado', tone: 'blue' },
  preparing: { label: 'En preparación', tone: 'indigo' },
  ready: { label: 'Listo', tone: 'teal' },
  on_the_way: { label: 'En camino', tone: 'purple' },
  delivered: { label: 'Entregado', tone: 'green' },
  cancelled: { label: 'Cancelado', tone: 'red' },
};

export function statusLabel(status: OrderStatus): string {
  return STATUS_META[status]?.label ?? status;
}

/**
 * Presentación OPERATIVA del estado (Fase 6C): desacopla el estado técnico
 * interno del lenguaje que ve el encargado. El estado guardado NO cambia; solo
 * cambia cómo se muestra. El encargado nunca ve "Confirmado" ni "Esperando
 * ubicación" como paso: esos aparecen como "En preparación" (la ubicación
 * pendiente se comunica aparte, como advertencia del pedido, no como estado).
 */
export function operationalStatusMeta(
  status: OrderStatus,
  deliveryType: DeliveryType,
): StatusMeta {
  switch (status) {
    case 'draft':
    case 'awaiting_location':
    case 'confirmed':
    case 'preparing':
      return { label: 'En preparación', tone: 'indigo' };
    case 'ready':
      // pickup: listo para recoger. delivery legacy: sigue "en preparación"
      // (su acción primaria será "En camino").
      return deliveryType === 'pickup'
        ? { label: 'Listo para recoger', tone: 'teal' }
        : { label: 'En preparación', tone: 'indigo' };
    case 'on_the_way':
      return { label: 'En camino', tone: 'purple' };
    case 'delivered':
      return { label: 'Entregado', tone: 'green' };
    case 'cancelled':
      return { label: 'Cancelado', tone: 'red' };
    default:
      return { label: 'En preparación', tone: 'indigo' };
  }
}

/** Estados terminales: nunca se degradan ni admiten transición. */
const TERMINAL: ReadonlySet<OrderStatus> = new Set<OrderStatus>(['delivered', 'cancelled']);

export function isTerminalStatus(status: OrderStatus): boolean {
  return TERMINAL.has(status);
}

/**
 * Transiciones operativas permitidas (Fase 6C — flujo simplificado).
 *
 * El encargado ve un flujo corto por tipo de entrega:
 *   DELIVERY: En preparación → En camino → Entregado
 *   RECOJO:   En preparación → Listo para recoger → Entregado
 *
 * Para lograrlo el avance salta el estado técnico intermedio `preparing`
 * (delivery pasa directo `confirmed → on_the_way`; pickup `confirmed → ready`).
 * `preparing`/`ready` NO se eliminan: un pedido histórico que ya esté ahí sigue
 * avanzando correctamente (compatibilidad legacy). `awaiting_location` solo
 * permite cancelar: el avance se habilita cuando la ubicación llega por WhatsApp
 * y el webhook lo pasa a `confirmed`. Nunca hay retrocesos ni degradación de un
 * pedido terminal.
 */
export function allowedNextStatuses(
  status: OrderStatus,
  deliveryType: DeliveryType,
): OrderStatus[] {
  switch (status) {
    case 'draft':
      return ['cancelled'];
    case 'awaiting_location':
      // La ubicación llega por WhatsApp; operativamente solo se puede cancelar.
      return ['cancelled'];
    case 'confirmed':
    case 'preparing':
      // "En preparación" para el encargado: avanza directo al despacho.
      // (preparing legacy comparte el mismo destino, sin quedar bloqueado.)
      return deliveryType === 'delivery'
        ? ['on_the_way', 'cancelled']
        : ['ready', 'cancelled'];
    case 'ready':
      // pickup: listo para recoger → entregado. delivery legacy: aún puede salir.
      return deliveryType === 'delivery'
        ? ['on_the_way', 'cancelled']
        : ['delivered', 'cancelled'];
    case 'on_the_way':
      return ['delivered', 'cancelled'];
    case 'delivered':
    case 'cancelled':
      return [];
    default:
      return [];
  }
}

export function isValidTransition(
  from: OrderStatus,
  to: OrderStatus,
  deliveryType: DeliveryType,
): boolean {
  return allowedNextStatuses(from, deliveryType).includes(to);
}

export interface OrderAction {
  /** Estado destino de la acción. */
  to: OrderStatus;
  label: string;
  /** `destructive` pide confirmación explícita antes de ejecutarse. */
  destructive: boolean;
}

/** Etiqueta de la acción que lleva a `to` (verbo operativo, lenguaje 6C). */
function actionLabel(to: OrderStatus): string {
  switch (to) {
    case 'preparing': return 'Marcar en preparación';
    case 'ready': return 'Listo para recoger';
    case 'on_the_way': return 'En camino';
    case 'delivered': return 'Entregado';
    case 'cancelled': return 'Cancelar pedido';
    default: return statusLabel(to);
  }
}

/** Acciones operativas disponibles para un pedido, en orden de flujo. */
export function actionsFor(
  status: OrderStatus,
  deliveryType: DeliveryType,
): OrderAction[] {
  return allowedNextStatuses(status, deliveryType).map((to) => ({
    to,
    label: actionLabel(to),
    destructive: to === 'cancelled',
  }));
}

/** ¿La acción hacia `to` requiere confirmación del operador? */
export function actionRequiresConfirmation(to: OrderStatus): boolean {
  return to === 'cancelled';
}

/** Etiqueta contextual (más corta) para la acción PRIMARIA en la tarjeta. */
function primaryActionLabel(to: OrderStatus): string {
  switch (to) {
    case 'preparing': return 'En preparación';
    case 'ready': return 'Listo para recoger';
    case 'on_the_way': return 'En camino';
    case 'delivered': return 'Entregado';
    default: return statusLabel(to);
  }
}

/**
 * Acción PRIMARIA contextual de avance para la tarjeta: la primera transición
 * permitida que NO sea cancelar. Reutiliza exactamente `allowedNextStatuses`
 * (misma lógica/validación); solo cambia la etiqueta visual. `null` si no hay
 * avance (terminal o solo-cancelar).
 */
export function primaryActionFor(
  status: OrderStatus,
  deliveryType: DeliveryType,
): { to: OrderStatus; label: string } | null {
  const next = allowedNextStatuses(status, deliveryType).find((s) => s !== 'cancelled');
  return next ? { to: next, label: primaryActionLabel(next) } : null;
}
