/**
 * Maquina de estados de COCINA — modulo PURO (sin React, sin server-only).
 *
 * Deliberadamente separada de `src/lib/dashboard/status.ts`: la cocina necesita
 * retrocesos (RETORNAR, DEVOLVER A COCINA) que el flujo del encargado prohibe a
 * proposito. Aquel modulo NO se toca; este vive aparte y solo lo usa el KDS.
 *
 * Etapas visibles: `new` → `in_progress` → `done`, mas `cancelled` (terminal).
 * Cualquier combinacion no listada devuelve `null` y la interfaz la ignora: eso
 * es lo que protege del doble toque en una tablet.
 */
import type { OrderStatus } from '@/types';

export const KDS_STAGES = ['new', 'in_progress', 'done', 'cancelled'] as const;
export type KdsStage = (typeof KDS_STAGES)[number];

export const KDS_ACTIONS = ['start', 'complete', 'return', 'recall', 'cancel'] as const;
export type KdsAction = (typeof KDS_ACTIONS)[number];

/** Transiciones permitidas. Lo que no esta aqui, no existe. */
const TRANSITIONS: Record<KdsStage, Partial<Record<KdsAction, KdsStage>>> = {
  new: { start: 'in_progress', cancel: 'cancelled' },
  in_progress: { complete: 'done', return: 'new' },
  done: { recall: 'in_progress' },
  // Terminal: un pedido cancelado no vuelve por ninguna accion.
  cancelled: {},
};

/** Etapa resultante de aplicar `action` sobre `stage`, o `null` si no procede. */
export function nextStage(stage: KdsStage, action: KdsAction): KdsStage | null {
  return TRANSITIONS[stage]?.[action] ?? null;
}

/** `cancelled` es la unica etapa terminal del tablero. */
export function isTerminalStage(stage: KdsStage): boolean {
  return stage === 'cancelled';
}

/** ¿La etapa sigue ocupando cocina? (alimenta el resumen del panel derecho) */
export function isActiveStage(stage: KdsStage): boolean {
  return stage === 'new' || stage === 'in_progress';
}

/** ¿Es una cadena una accion valida del KDS? (validacion de entrada externa) */
export function isKdsAction(value: unknown): value is KdsAction {
  return typeof value === 'string' && (KDS_ACTIONS as readonly string[]).includes(value);
}

/**
 * Estados reales de `orders.status` que ENTRAN al tablero.
 * `draft`/`awaiting_location` aun no son cocinables; `on_the_way`/`delivered`
 * ya salieron de la cocina.
 */
export const KITCHEN_BOARD_STATUSES: readonly OrderStatus[] = ['confirmed', 'preparing', 'ready'];

/** Estados que significan "el encargado ya lo despacho": la cocina no los toca. */
export const DISPATCHED_STATUSES: readonly OrderStatus[] = ['on_the_way', 'delivered'];

const STATUS_TO_STAGE: Partial<Record<OrderStatus, KdsStage>> = {
  confirmed: 'new',
  preparing: 'in_progress',
  ready: 'done',
  cancelled: 'cancelled',
};

/** Estado real → etapa KDS. `null` = el pedido no pertenece al tablero. */
export function stageFromOrderStatus(status: OrderStatus): KdsStage | null {
  return STATUS_TO_STAGE[status] ?? null;
}

/**
 * Etapa KDS → estado real que se guarda.
 *
 * Decision explicita: `done` guarda **`ready`**, nunca `on_the_way` ni
 * `delivered`. La cocina avisa que la comida esta lista; despachar al cliente
 * sigue siendo del encargado. El modal habla de "despacharlo" porque asi lo
 * entiende el cocinero, pero el estado guardado es `ready`.
 */
const STAGE_TO_STATUS: Record<KdsStage, OrderStatus> = {
  new: 'confirmed',
  in_progress: 'preparing',
  done: 'ready',
  cancelled: 'cancelled',
};

export function orderStatusForStage(stage: KdsStage): OrderStatus {
  return STAGE_TO_STATUS[stage];
}

/** Etiqueta visible de cada etapa. El color NUNCA comunica solo: siempre va con texto. */
export const STAGE_LABELS: Record<KdsStage, string> = {
  new: 'Nuevo',
  in_progress: 'En preparación',
  done: 'Listo',
  cancelled: 'Cancelado',
};

export interface KdsButton {
  action: KdsAction;
  label: string;
  /** `primary` = boton gigante; `secondary` = mas bajo y discreto; `danger` = destructivo. */
  kind: 'primary' | 'secondary' | 'danger';
  /** ¿Pide confirmacion antes de ejecutarse? (un roce accidental no tira un pedido) */
  confirm: boolean;
}

const BUTTONS: Record<KdsStage, KdsButton[]> = {
  new: [
    { action: 'start', label: 'INICIAR', kind: 'primary', confirm: false },
    { action: 'cancel', label: 'CANCELAR', kind: 'danger', confirm: true },
  ],
  in_progress: [
    { action: 'complete', label: 'COMPLETAR', kind: 'primary', confirm: true },
    { action: 'return', label: 'RETORNAR', kind: 'secondary', confirm: false },
  ],
  done: [{ action: 'recall', label: 'DEVOLVER A COCINA', kind: 'secondary', confirm: false }],
  cancelled: [],
};

/** Botones que ofrece la tarjeta en cada etapa, en orden de aparicion. */
export function buttonsForStage(stage: KdsStage): KdsButton[] {
  return BUTTONS[stage] ?? [];
}
