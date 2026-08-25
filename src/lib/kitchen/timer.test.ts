import { describe, it, expect } from 'vitest';
import {
  KITCHEN_LATE_THRESHOLD_MS,
  elapsedMs,
  exceedsHour,
  formatClockTime,
  formatElapsed,
  formatElapsedSince,
  isLate,
} from './timer';

const BASE = Date.parse('2026-08-22T12:00:00Z');
const iso = (offsetMs: number) => new Date(BASE + offsetMs).toISOString();

describe('temporizador — formato mm:ss', () => {
  it('cuenta segundos y minutos con dos dígitos', () => {
    expect(formatElapsedSince(iso(0), BASE)).toBe('00:00');
    expect(formatElapsedSince(iso(0), BASE + 5_000)).toBe('00:05');
    expect(formatElapsedSince(iso(0), BASE + 65_000)).toBe('01:05');
    expect(formatElapsedSince(iso(0), BASE + 59 * 60_000 + 59_000)).toBe('59:59');
  });
});

describe('temporizador — salto a h:mm:ss', () => {
  it('al cumplir la hora cambia de formato', () => {
    expect(formatElapsedSince(iso(0), BASE + 3_600_000 - 1_000)).toBe('59:59');
    expect(formatElapsedSince(iso(0), BASE + 3_600_000)).toBe('1:00:00');
    expect(formatElapsedSince(iso(0), BASE + 3_600_000 + 61_000)).toBe('1:01:01');
    expect(formatElapsedSince(iso(0), BASE + 2 * 3_600_000)).toBe('2:00:00');
    expect(exceedsHour(iso(0), BASE + 3_600_000)).toBe(true);
    expect(exceedsHour(iso(0), BASE + 3_599_000)).toBe(false);
  });
});

describe('temporizador — nunca negativo, fecha inválida = cero', () => {
  it('un pedido "del futuro" muestra 00:00, no un tiempo negativo', () => {
    expect(elapsedMs(iso(60_000), BASE)).toBe(0);
    expect(formatElapsedSince(iso(60_000), BASE)).toBe('00:00');
  });

  it('una fecha ilegible o ausente cuenta como cero', () => {
    expect(elapsedMs('no-es-una-fecha', BASE)).toBe(0);
    expect(elapsedMs(null, BASE)).toBe(0);
    expect(elapsedMs(undefined, BASE)).toBe(0);
    expect(formatElapsedSince('', BASE)).toBe('00:00');
    expect(formatElapsed(Number.NaN)).toBe('00:00');
    expect(formatElapsed(-5_000)).toBe('00:00');
  });
});

describe('temporizador — la alerta salta exactamente al minuto 15', () => {
  it('a los 14:59 aún no; a los 15:00 sí', () => {
    expect(KITCHEN_LATE_THRESHOLD_MS).toBe(15 * 60 * 1000);
    expect(isLate(iso(0), BASE + 14 * 60_000 + 59_000)).toBe(false);
    expect(isLate(iso(0), BASE + KITCHEN_LATE_THRESHOLD_MS - 1)).toBe(false);
    expect(isLate(iso(0), BASE + KITCHEN_LATE_THRESHOLD_MS)).toBe(true);
    expect(isLate(iso(0), BASE + 20 * 60_000)).toBe(true);
  });

  it('una fecha inválida no dispara la alerta', () => {
    expect(isLate('roto', BASE + 60 * 60_000)).toBe(false);
  });
});

describe('hora de completado en formato 24 h', () => {
  it('rellena con ceros y tolera valores ausentes', () => {
    const local = new Date(2026, 7, 22, 19, 5, 0);
    expect(formatClockTime(local.toISOString())).toBe('19:05');
    expect(formatClockTime(null)).toBe('--:--');
    expect(formatClockTime('roto')).toBe('--:--');
  });
});
