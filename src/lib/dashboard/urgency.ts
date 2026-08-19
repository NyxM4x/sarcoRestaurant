/**
 * Tiempo de espera y urgencia operativa de un pedido — módulo PURO (sin
 * server-only, seguro para importar desde componentes cliente).
 *
 * No consulta la base ni depende del reloj global: recibe `nowMs` inyectado, de
 * modo que un único reloj del dashboard alimenta todas las tarjetas (sin timers
 * por card). Solo deriva presentación; nunca modifica datos almacenados.
 *
 * Los umbrales viven aquí, en frontend, para poder ajustarlos sin tocar la base
 * (Fase 6C). Si más adelante se hacen configurables por restaurante, este es el
 * único punto a cambiar.
 */
import type { OrderStatus } from '@/types';
import { isTerminalStatus } from './status';

/** Nivel de urgencia por antigüedad de un pedido ACTIVO. */
export type UrgencyLevel = 'none' | 'normal' | 'attention' | 'overdue';

/**
 * Umbrales en minutos. `attention` a partir de 15 min, `overdue` a partir de 30.
 * Un pedido por debajo de `attention` es `normal`.
 */
export const URGENCY_THRESHOLDS = { attention: 15, overdue: 30 } as const;

/**
 * Minutos transcurridos desde `createdAtIso` hasta `nowMs`. Nunca negativo (un
 * reloj ligeramente adelantado no produce "hace -1 min") y 0 si la fecha es
 * inválida.
 */
export function elapsedMinutes(createdAtIso: string, nowMs: number): number {
  const created = Date.parse(createdAtIso);
  if (!Number.isFinite(created)) return 0;
  return Math.max(0, Math.floor((nowMs - created) / 60_000));
}

/** Etiqueta de espera legible: "Recién", "Hace 3 min", "Hace 1 h 5 min". */
export function waitingLabel(minutes: number): string {
  if (minutes < 1) return 'Recién';
  if (minutes < 60) return `Hace ${minutes} min`;
  const h = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return rem === 0 ? `Hace ${h} h` : `Hace ${h} h ${rem} min`;
}

/**
 * Nivel de urgencia. Solo aplica a pedidos ACTIVOS: los terminales
 * (entregado/cancelado) devuelven `none` y no se resaltan por antigüedad.
 */
export function urgencyLevel(minutes: number, status: OrderStatus): UrgencyLevel {
  if (isTerminalStatus(status)) return 'none';
  if (minutes >= URGENCY_THRESHOLDS.overdue) return 'overdue';
  if (minutes >= URGENCY_THRESHOLDS.attention) return 'attention';
  return 'normal';
}

export interface UrgencyMeta {
  label: string;
  /** Icono de apoyo: la señal NUNCA depende solo del color. */
  icon: string;
  tone: 'amber' | 'red';
}

/**
 * Presentación del badge de urgencia. `normal` y `none` no llevan badge (evita
 * ruido visual: solo se marca lo que necesita atención).
 */
export function urgencyMeta(level: UrgencyLevel): UrgencyMeta | null {
  switch (level) {
    case 'attention':
      return { label: 'Demora', icon: '⏳', tone: 'amber' };
    case 'overdue':
      return { label: 'Atrasado', icon: '🔴', tone: 'red' };
    default:
      return null;
  }
}

/** Conveniencia: nivel de urgencia directamente desde la fecha de creación. */
export function urgencyFor(
  createdAtIso: string,
  status: OrderStatus,
  nowMs: number,
): UrgencyLevel {
  return urgencyLevel(elapsedMinutes(createdAtIso, nowMs), status);
}
