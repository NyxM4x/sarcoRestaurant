import { describe, it, expect } from 'vitest';
import {
  allowedNextStatuses,
  isValidTransition,
  isTerminalStatus,
  actionsFor,
  actionRequiresConfirmation,
  primaryActionFor,
  operationalStatusMeta,
} from './status';

describe('status — flujo operativo simplificado 6C (DELIVERY)', () => {
  it('En preparación (confirmed) → En camino → Entregado', () => {
    // confirmed delivery salta directo a on_the_way (omite preparing/ready).
    expect(allowedNextStatuses('confirmed', 'delivery')).toEqual(['on_the_way', 'cancelled']);
    expect(isValidTransition('confirmed', 'on_the_way', 'delivery')).toBe(true);
    expect(isValidTransition('on_the_way', 'delivered', 'delivery')).toBe(true);
  });

  it('acción primaria de delivery: confirmed→En camino, on_the_way→Entregado', () => {
    expect(primaryActionFor('confirmed', 'delivery')).toEqual({ to: 'on_the_way', label: 'En camino' });
    expect(primaryActionFor('on_the_way', 'delivery')).toEqual({ to: 'delivered', label: 'Entregado' });
  });

  it('delivery no expone "Listo para recoger" ni salta a delivered directo', () => {
    expect(allowedNextStatuses('confirmed', 'delivery')).not.toContain('ready');
    expect(isValidTransition('confirmed', 'delivered', 'delivery')).toBe(false);
  });
});

describe('status — flujo operativo simplificado 6C (RECOJO)', () => {
  it('En preparación (confirmed) → Listo para recoger → Entregado', () => {
    expect(allowedNextStatuses('confirmed', 'pickup')).toEqual(['ready', 'cancelled']);
    expect(isValidTransition('confirmed', 'ready', 'pickup')).toBe(true);
    expect(isValidTransition('ready', 'delivered', 'pickup')).toBe(true);
  });

  it('acción primaria de recojo: confirmed→Listo para recoger, ready→Entregado', () => {
    expect(primaryActionFor('confirmed', 'pickup')).toEqual({ to: 'ready', label: 'Listo para recoger' });
    expect(primaryActionFor('ready', 'pickup')).toEqual({ to: 'delivered', label: 'Entregado' });
  });

  it('recojo no pasa a on_the_way', () => {
    expect(allowedNextStatuses('confirmed', 'pickup')).not.toContain('on_the_way');
    expect(allowedNextStatuses('ready', 'pickup')).not.toContain('on_the_way');
  });
});

describe('status — awaiting_location bloqueado hasta recibir ubicación', () => {
  it('solo permite cancelar (el avance llega cuando el webhook lo pasa a confirmed)', () => {
    expect(allowedNextStatuses('awaiting_location', 'delivery')).toEqual(['cancelled']);
    expect(primaryActionFor('awaiting_location', 'delivery')).toBeNull();
    expect(isValidTransition('awaiting_location', 'on_the_way', 'delivery')).toBe(false);
    expect(isValidTransition('awaiting_location', 'preparing', 'delivery')).toBe(false);
  });
});

describe('status — compatibilidad con estados legacy (preparing/ready)', () => {
  it('preparing legacy sigue avanzando según el tipo de entrega', () => {
    expect(allowedNextStatuses('preparing', 'delivery')).toEqual(['on_the_way', 'cancelled']);
    expect(allowedNextStatuses('preparing', 'pickup')).toEqual(['ready', 'cancelled']);
    expect(primaryActionFor('preparing', 'delivery')).toEqual({ to: 'on_the_way', label: 'En camino' });
    expect(primaryActionFor('preparing', 'pickup')).toEqual({ to: 'ready', label: 'Listo para recoger' });
  });

  it('ready legacy en delivery no queda bloqueado: puede salir En camino', () => {
    expect(allowedNextStatuses('ready', 'delivery')).toEqual(['on_the_way', 'cancelled']);
    expect(primaryActionFor('ready', 'delivery')).toEqual({ to: 'on_the_way', label: 'En camino' });
  });
});

describe('status — cancelación, terminales y ausencia de retrocesos', () => {
  it('cancelar disponible en no terminales y siempre pide confirmación', () => {
    for (const s of ['confirmed', 'preparing', 'ready', 'on_the_way', 'awaiting_location'] as const) {
      expect(allowedNextStatuses(s, 'delivery')).toContain('cancelled');
    }
    expect(actionRequiresConfirmation('cancelled')).toBe(true);
    expect(actionRequiresConfirmation('on_the_way')).toBe(false);
  });

  it('la acción de cancelar se marca como destructiva', () => {
    const actions = actionsFor('confirmed', 'pickup');
    expect(actions.find((a) => a.to === 'cancelled')?.destructive).toBe(true);
    expect(actions.find((a) => a.to === 'ready')?.destructive).toBe(false);
  });

  it('un pedido terminal no se degrada ni admite transición', () => {
    expect(isTerminalStatus('delivered')).toBe(true);
    expect(isTerminalStatus('cancelled')).toBe(true);
    expect(allowedNextStatuses('delivered', 'pickup')).toEqual([]);
    expect(allowedNextStatuses('cancelled', 'delivery')).toEqual([]);
    expect(primaryActionFor('delivered', 'pickup')).toBeNull();
    expect(primaryActionFor('cancelled', 'delivery')).toBeNull();
  });

  it('sin retrocesos (nunca se vuelve a un estado anterior)', () => {
    expect(isValidTransition('on_the_way', 'confirmed', 'delivery')).toBe(false);
    expect(isValidTransition('ready', 'preparing', 'pickup')).toBe(false);
    expect(isValidTransition('delivered', 'on_the_way', 'delivery')).toBe(false);
  });

  it('la acción primaria SIEMPRE es una transición válida y nunca cancelar', () => {
    for (const s of ['confirmed', 'preparing', 'ready', 'on_the_way'] as const) {
      for (const dt of ['delivery', 'pickup'] as const) {
        const p = primaryActionFor(s, dt);
        if (p) {
          expect(p.to).not.toBe('cancelled');
          expect(isValidTransition(s, p.to, dt)).toBe(true);
        }
      }
    }
  });
});

describe('status — etiquetas operativas (el encargado no ve estados técnicos)', () => {
  it('awaiting_location/confirmed/preparing se muestran como "En preparación"', () => {
    for (const s of ['awaiting_location', 'confirmed', 'preparing'] as const) {
      expect(operationalStatusMeta(s, 'delivery').label).toBe('En preparación');
      expect(operationalStatusMeta(s, 'pickup').label).toBe('En preparación');
    }
  });

  it('ready depende del tipo: recojo "Listo para recoger", delivery legacy "En preparación"', () => {
    expect(operationalStatusMeta('ready', 'pickup').label).toBe('Listo para recoger');
    expect(operationalStatusMeta('ready', 'delivery').label).toBe('En preparación');
  });

  it('on_the_way/delivered/cancelled usan lenguaje operativo', () => {
    expect(operationalStatusMeta('on_the_way', 'delivery').label).toBe('En camino');
    expect(operationalStatusMeta('delivered', 'pickup').label).toBe('Entregado');
    expect(operationalStatusMeta('cancelled', 'delivery').label).toBe('Cancelado');
  });

  it('el encargado nunca ve "Confirmado" como etiqueta', () => {
    for (const s of ['awaiting_location', 'confirmed', 'preparing', 'ready', 'on_the_way', 'delivered', 'cancelled'] as const) {
      for (const dt of ['delivery', 'pickup'] as const) {
        expect(operationalStatusMeta(s, dt).label).not.toBe('Confirmado');
      }
    }
  });
});
