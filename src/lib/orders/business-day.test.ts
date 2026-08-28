import { describe, it, expect } from 'vitest';
import {
  businessDayBounds,
  businessDayOf,
  businessDayStart,
  businessDayTag,
} from './business-day';

/** Hora de Bolivia (UTC−4) escrita como el instante UTC que le corresponde. */
const enBolivia = (iso: string) => Date.parse(`${iso}:00.000Z`) + 4 * 60 * 60 * 1000;

describe('jornada de servicio — la noche que cruza la medianoche', () => {
  it('todo el servicio del 28 pertenece a la jornada del 28', () => {
    // Abre 18:00, cierra 04:00. Las 02:00 del día 29 siguen siendo la noche del
    // 28: es la noche que cocinó ese cocinero y con la que cuadra esa caja.
    for (const hora of ['2026-08-28T18:00', '2026-08-28T23:59', '2026-08-29T02:00', '2026-08-29T03:59']) {
      expect(businessDayOf(enBolivia(hora)), hora).toBe('2026-08-28');
    }
  });

  it('a partir del mediodía empieza la jornada siguiente', () => {
    expect(businessDayOf(enBolivia('2026-08-29T11:59'))).toBe('2026-08-28');
    expect(businessDayOf(enBolivia('2026-08-29T12:00'))).toBe('2026-08-29');
  });

  it('un pedido de prueba por la mañana cae en la jornada que ya cerró', () => {
    // Las 10:00 del 29 son "después de cerrar el 28", no "antes de abrir el 29".
    expect(businessDayOf(enBolivia('2026-08-29T10:00'))).toBe('2026-08-28');
  });

  it('la jornada empieza al mediodía local y dura 24 horas exactas', () => {
    const durante = enBolivia('2026-08-28T20:00');
    expect(new Date(businessDayStart(durante)).toISOString()).toBe('2026-08-28T16:00:00.000Z');
    expect(businessDayBounds(durante)).toEqual({
      since: '2026-08-28T16:00:00.000Z',
      until: '2026-08-29T16:00:00.000Z',
    });
  });

  it('`offsetDays` retrocede jornadas enteras', () => {
    expect(businessDayBounds(enBolivia('2026-08-28T20:00'), -1)).toEqual({
      since: '2026-08-27T16:00:00.000Z',
      until: '2026-08-28T16:00:00.000Z',
    });
  });

  it('no depende de la zona horaria de la máquina', () => {
    // El mismo instante da la misma jornada se ejecute donde se ejecute: la
    // numeración de una noche no puede cambiar por la región del despliegue.
    const instante = Date.parse('2026-08-29T05:30:00.000Z'); // 01:30 en Bolivia
    expect(businessDayOf(instante)).toBe('2026-08-28');
  });

  it('la etiqueta del número de pedido es corta y se ordena sola', () => {
    expect(businessDayTag(enBolivia('2026-08-28T20:00'))).toBe('260828');
    expect(businessDayTag(enBolivia('2026-08-29T02:00'))).toBe('260828');
    expect(businessDayTag(enBolivia('2026-12-01T19:00'))).toBe('261201');
  });

  it('cambia de jornada exactamente una vez al día, y no durante el servicio', () => {
    // Recorre la noche minuto a minuto: si el corte cayera dentro del servicio,
    // aquí saldrían dos claves distintas y la numeración se reiniciaría a mitad.
    const inicio = enBolivia('2026-08-28T17:00');
    const claves = new Set<string>();
    for (let i = 0; i <= 12 * 60; i += 1) claves.add(businessDayOf(inicio + i * 60_000));
    expect([...claves]).toEqual(['2026-08-28']);
  });
});
