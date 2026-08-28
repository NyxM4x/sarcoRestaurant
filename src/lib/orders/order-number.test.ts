import { describe, it, expect } from 'vitest';
import { orderDayLabel, parseOrderNumber, shortOrderNumber } from './order-number';

describe('número de pedido — lo que se guarda y lo que se dice', () => {
  it('el corto es el que se grita en cocina', () => {
    expect(shortOrderNumber('ORD-260828-007')).toBe('#7');
    expect(shortOrderNumber('ORD-260828-001')).toBe('#1');
    expect(shortOrderNumber('ORD-260828-042')).toBe('#42');
  });

  it('pasadas las 999 comandas sigue funcionando', () => {
    // `lpad` no trunca: el número crece y sigue siendo único.
    expect(shortOrderNumber('ORD-260828-1000')).toBe('#1000');
  });

  it('la jornada acompaña al número donde puede haber más de una noche', () => {
    expect(orderDayLabel('ORD-260828-007')).toBe('28/08');
    expect(orderDayLabel('ORD-261201-003')).toBe('01/12');
  });

  it('descompone las dos partes de una vez', () => {
    expect(parseOrderNumber('ORD-260828-007')).toEqual({ daily: 7, dayLabel: '28/08' });
  });

  it('los números viejos se devuelven TAL CUAL', () => {
    // Un pedido anterior a la numeración diaria tiene que poder mirarse,
    // buscarse y nombrarse igual que siempre. Inventarle un correlativo que
    // nunca tuvo sería peor que enseñar el número largo.
    for (const viejo of ['ORD-000019', 'ORD-000001', 'ORD-123456']) {
      expect(shortOrderNumber(viejo), viejo).toBe(viejo);
      expect(orderDayLabel(viejo), viejo).toBeNull();
    }
  });

  it('lo que no tiene el formato no se interpreta', () => {
    for (const raro of ['', '   ', 'PEDIDO-7', 'ORD-2608-7', 'ORD-260828-7']) {
      expect(parseOrderNumber(raro), raro).toEqual({ daily: null, dayLabel: null });
    }
    expect(parseOrderNumber(null)).toEqual({ daily: null, dayLabel: null });
  });

  it('dos noches distintas dan el MISMO número corto: por eso va la fecha', () => {
    // Es el precio de reiniciar el contador, y está asumido a propósito. La
    // pantalla que muestra varias jornadas tiene que pintar las dos cosas.
    expect(shortOrderNumber('ORD-260828-007')).toBe(shortOrderNumber('ORD-260829-007'));
    expect(orderDayLabel('ORD-260828-007')).not.toBe(orderDayLabel('ORD-260829-007'));
  });
});
