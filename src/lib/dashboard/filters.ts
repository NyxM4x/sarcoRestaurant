/**
 * Normalizacion de filtros de la lista de pedidos — modulo PURO.
 *
 * Nunca se descarga la tabla completa: el limite se acota SIEMPRE. Los enums se
 * validan; los valores desconocidos se ignoran (no rompen la consulta).
 */
import { ORDER_STATUSES, DELIVERY_TYPES, type OrderStatus, type DeliveryType } from '@/types';

export type DateRange = 'today' | 'yesterday' | 'last7' | 'all';
export const DATE_RANGES: readonly DateRange[] = ['today', 'yesterday', 'last7', 'all'];

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 50;

/**
 * Filtros OPERATIVOS (Fase 6C): el encargado no elige estados técnicos internos,
 * sino etapas de trabajo. Cada grupo mapea a uno o varios estados reales, que la
 * fuente aplica con `.in('status', […])` (sin migración ni SQL nuevo). El estado
 * interno de los pedidos NO cambia; solo se filtra por conjuntos.
 */
export type StatusGroup = 'en_preparacion' | 'en_camino_listos' | 'entregados' | 'cancelados';
// `draft` no aparece en ningún grupo: es un borrador del Flow, invisible para el
// encargado (la exclusión dura vive además en la capa de lectura de la fuente).
export const STATUS_GROUPS: Record<StatusGroup, readonly OrderStatus[]> = {
  en_preparacion: ['awaiting_location', 'confirmed', 'preparing'],
  en_camino_listos: ['ready', 'on_the_way'],
  entregados: ['delivered'],
  cancelados: ['cancelled'],
};
export const STATUS_GROUP_LABELS: Record<StatusGroup, string> = {
  en_preparacion: 'En preparación',
  en_camino_listos: 'En camino / Listos',
  entregados: 'Entregados',
  cancelados: 'Cancelados',
};
/** Orden de aparición en el selector. */
export const STATUS_GROUP_ORDER: readonly StatusGroup[] = [
  'en_preparacion',
  'en_camino_listos',
  'entregados',
  'cancelados',
];
const STATUS_GROUP_KEYS = STATUS_GROUP_ORDER;

export interface OrderFiltersInput {
  /** Grupo operativo (preferido). */
  statusGroup?: string | null;
  /** Compatibilidad: un estado técnico único (se mapea a un conjunto de uno). */
  status?: string | null;
  deliveryType?: string | null;
  dateRange?: string | null;
  search?: string | null;
  limit?: number | string | null;
  offset?: number | string | null;
}

export interface OrderFilters {
  /** Conjunto de estados internos a incluir (`null` = todos). */
  statuses: OrderStatus[] | null;
  deliveryType: DeliveryType | null;
  dateRange: DateRange;
  /** Busqueda por numero de pedido o nombre de cliente (saneada). */
  search: string | null;
  limit: number;
  offset: number;
}

function asInt(v: unknown, fallback: number): number {
  const num = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isInteger(num) ? num : fallback;
}

export function normalizeFilters(input: OrderFiltersInput = {}): OrderFilters {
  // Grupo operativo (preferido) → conjunto de estados internos.
  let statuses: OrderStatus[] | null = STATUS_GROUP_KEYS.includes(input.statusGroup as StatusGroup)
    ? [...STATUS_GROUPS[input.statusGroup as StatusGroup]]
    : null;
  // Compatibilidad: un estado técnico único válido se acepta como conjunto de uno.
  if (statuses === null && ORDER_STATUSES.includes(input.status as OrderStatus)) {
    statuses = [input.status as OrderStatus];
  }
  const deliveryType = DELIVERY_TYPES.includes(input.deliveryType as DeliveryType)
    ? (input.deliveryType as DeliveryType)
    : null;
  const dateRange = DATE_RANGES.includes(input.dateRange as DateRange)
    ? (input.dateRange as DateRange)
    : 'today';

  const rawSearch = typeof input.search === 'string' ? input.search : '';
  // Whitelist: solo letras, digitos, espacio y guion. Elimina comodines/control
  // (evita inyeccion en ILIKE) y acota la longitud.
  const cleaned = rawSearch.replace(/[^\p{L}\p{N}\s-]/gu, '').trim().slice(0, 60);
  const search = cleaned === '' ? null : cleaned;

  const limit = Math.min(Math.max(asInt(input.limit, DEFAULT_PAGE_SIZE), 1), MAX_PAGE_SIZE);
  const offset = Math.max(asInt(input.offset, 0), 0);

  return { statuses, deliveryType, dateRange, search, limit, offset };
}

/** Limites de fecha [desde, hasta) en ISO, segun el rango y un `now` inyectado. */
export function dateBounds(range: DateRange, now: number): { since: string | null; until: string | null } {
  if (range === 'all') return { since: null, until: null };
  const d = new Date(now);
  const startOfToday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const DAY = 86_400_000;
  switch (range) {
    case 'today':
      return { since: new Date(startOfToday).toISOString(), until: null };
    case 'yesterday':
      return { since: new Date(startOfToday - DAY).toISOString(), until: new Date(startOfToday).toISOString() };
    case 'last7':
      return { since: new Date(startOfToday - 6 * DAY).toISOString(), until: null };
    default:
      return { since: null, until: null };
  }
}
