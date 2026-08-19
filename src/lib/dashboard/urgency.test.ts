import { describe, it, expect } from 'vitest';
import {
  elapsedMinutes,
  waitingLabel,
  urgencyLevel,
  urgencyMeta,
  urgencyFor,
  URGENCY_THRESHOLDS,
} from './urgency';

const BASE = Date.parse('2026-08-09T12:00:00.000Z');
const minutesAgo = (m: number) => new Date(BASE - m * 60_000).toISOString();

describe('urgency — elapsedMinutes', () => {
  it('cuenta minutos completos transcurridos', () => {
    expect(elapsedMinutes(minutesAgo(0), BASE)).toBe(0);
    expect(elapsedMinutes(minutesAgo(3), BASE)).toBe(3);
    expect(elapsedMinutes(minutesAgo(59), BASE)).toBe(59);
    // 90s → 1 min completo (redondea hacia abajo).
    expect(elapsedMinutes(new Date(BASE - 90_000).toISOString(), BASE)).toBe(1);
  });

  it('nunca es negativo aunque el reloj esté adelantado', () => {
    expect(elapsedMinutes(minutesAgo(-5), BASE)).toBe(0);
  });

  it('devuelve 0 ante una fecha inválida', () => {
    expect(elapsedMinutes('no-es-fecha', BASE)).toBe(0);
  });
});

describe('urgency — waitingLabel', () => {
  it('bajo 1 min es "Recién"', () => {
    expect(waitingLabel(0)).toBe('Recién');
  });

  it('minutos sueltos', () => {
    expect(waitingLabel(3)).toBe('Hace 3 min');
    expect(waitingLabel(28)).toBe('Hace 28 min');
    expect(waitingLabel(59)).toBe('Hace 59 min');
  });

  it('horas con y sin resto', () => {
    expect(waitingLabel(60)).toBe('Hace 1 h');
    expect(waitingLabel(65)).toBe('Hace 1 h 5 min');
    expect(waitingLabel(140)).toBe('Hace 2 h 20 min');
  });
});

describe('urgency — urgencyLevel y umbrales', () => {
  it('clasifica por antigüedad para pedidos activos', () => {
    expect(urgencyLevel(0, 'confirmed')).toBe('normal');
    expect(urgencyLevel(14, 'preparing')).toBe('normal');
    expect(urgencyLevel(URGENCY_THRESHOLDS.attention, 'preparing')).toBe('attention');
    expect(urgencyLevel(29, 'ready')).toBe('attention');
    expect(urgencyLevel(URGENCY_THRESHOLDS.overdue, 'ready')).toBe('overdue');
    expect(urgencyLevel(120, 'on_the_way')).toBe('overdue');
  });

  it('los pedidos terminales nunca tienen urgencia', () => {
    expect(urgencyLevel(999, 'delivered')).toBe('none');
    expect(urgencyLevel(999, 'cancelled')).toBe('none');
  });
});

describe('urgency — urgencyMeta (badge)', () => {
  it('normal y none no llevan badge', () => {
    expect(urgencyMeta('normal')).toBeNull();
    expect(urgencyMeta('none')).toBeNull();
  });

  it('attention/overdue traen texto + icono (no solo color)', () => {
    const a = urgencyMeta('attention');
    const o = urgencyMeta('overdue');
    expect(a).not.toBeNull();
    expect(o).not.toBeNull();
    expect(a!.label).toBeTruthy();
    expect(a!.icon).toBeTruthy();
    expect(o!.tone).toBe('red');
  });
});

describe('urgency — urgencyFor (atajo desde ISO)', () => {
  it('combina elapsed + nivel', () => {
    expect(urgencyFor(minutesAgo(31), 'preparing', BASE)).toBe('overdue');
    expect(urgencyFor(minutesAgo(31), 'delivered', BASE)).toBe('none');
    expect(urgencyFor(minutesAgo(2), 'confirmed', BASE)).toBe('normal');
  });
});
