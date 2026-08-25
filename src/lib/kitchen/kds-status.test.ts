import { describe, it, expect } from 'vitest';
import { ORDER_STATUSES, type OrderStatus } from '@/types';
import {
  KDS_STAGES,
  KITCHEN_BOARD_STATUSES,
  buttonsForStage,
  isActiveStage,
  isKdsAction,
  isTerminalStage,
  nextStage,
  orderStatusForStage,
  stageFromOrderStatus,
  type KdsStage,
} from './kds-status';

describe('máquina de cocina — flujo feliz', () => {
  it('new → in_progress → done con INICIAR y COMPLETAR', () => {
    expect(nextStage('new', 'start')).toBe('in_progress');
    expect(nextStage('in_progress', 'complete')).toBe('done');
  });
});

describe('máquina de cocina — los dos retrocesos permitidos', () => {
  it('RETORNAR devuelve in_progress → new', () => {
    expect(nextStage('in_progress', 'return')).toBe('new');
  });

  it('DEVOLVER A COCINA devuelve done → in_progress', () => {
    expect(nextStage('done', 'recall')).toBe('in_progress');
  });
});

describe('máquina de cocina — nada de saltar etapas', () => {
  it('un pedido nuevo no se completa ni se devuelve sin pasar por preparación', () => {
    expect(nextStage('new', 'complete')).toBeNull();
    expect(nextStage('new', 'recall')).toBeNull();
    expect(nextStage('new', 'return')).toBeNull();
  });

  it('un pedido en preparación no se inicia otra vez ni se cancela desde la tarjeta', () => {
    expect(nextStage('in_progress', 'start')).toBeNull();
    expect(nextStage('in_progress', 'cancel')).toBeNull();
  });

  it('un pedido listo solo admite volver a cocina', () => {
    expect(nextStage('done', 'start')).toBeNull();
    expect(nextStage('done', 'complete')).toBeNull();
    expect(nextStage('done', 'return')).toBeNull();
    expect(nextStage('done', 'cancel')).toBeNull();
  });

  it('el doble toque sobre la misma acción no vuelve a avanzar', () => {
    const first = nextStage('new', 'start');
    expect(first).toBe('in_progress');
    // Repetir INICIAR sobre la etapa ya alcanzada no hace nada.
    expect(nextStage(first as KdsStage, 'start')).toBeNull();
  });
});

describe('máquina de cocina — cancelled es terminal', () => {
  it('solo se cancela desde new, y de cancelled no se sale por ninguna acción', () => {
    expect(nextStage('new', 'cancel')).toBe('cancelled');
    for (const action of ['start', 'complete', 'return', 'recall', 'cancel'] as const) {
      expect(nextStage('cancelled', action)).toBeNull();
    }
    expect(isTerminalStage('cancelled')).toBe(true);
    expect(buttonsForStage('cancelled')).toEqual([]);
  });
});

describe('mapeo con orders.status — ida y vuelta', () => {
  it('los estados del tablero mapean a su etapa y vuelven al mismo estado', () => {
    const pairs: Array<[OrderStatus, KdsStage]> = [
      ['confirmed', 'new'],
      ['preparing', 'in_progress'],
      ['ready', 'done'],
      ['cancelled', 'cancelled'],
    ];
    for (const [status, stage] of pairs) {
      expect(stageFromOrderStatus(status)).toBe(stage);
      expect(orderStatusForStage(stage)).toBe(status);
    }
  });

  it('lo que aún no es cocinable y lo que ya salió NO entra al tablero', () => {
    for (const status of ['draft', 'awaiting_location', 'on_the_way', 'delivered'] as const) {
      expect(stageFromOrderStatus(status)).toBeNull();
    }
  });

  it('completar deja el pedido en `ready`, nunca en on_the_way ni delivered', () => {
    expect(orderStatusForStage('done')).toBe('ready');
  });

  it('toda etapa tiene un estado real y todo estado real es conocido', () => {
    for (const stage of KDS_STAGES) {
      expect(ORDER_STATUSES).toContain(orderStatusForStage(stage));
    }
    expect([...KITCHEN_BOARD_STATUSES]).toEqual(['confirmed', 'preparing', 'ready']);
  });
});

describe('etapas activas y validación de acciones', () => {
  it('solo nuevos y en preparación ocupan cocina', () => {
    expect(isActiveStage('new')).toBe(true);
    expect(isActiveStage('in_progress')).toBe(true);
    expect(isActiveStage('done')).toBe(false);
    expect(isActiveStage('cancelled')).toBe(false);
  });

  it('una acción inventada se rechaza', () => {
    expect(isKdsAction('start')).toBe(true);
    expect(isKdsAction('deliver')).toBe(false);
    expect(isKdsAction(42)).toBe(false);
    expect(isKdsAction(null)).toBe(false);
  });
});
