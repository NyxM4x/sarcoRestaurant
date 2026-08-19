import { describe, it, expect } from 'vitest';
import { formatMoney, currencySymbol, formatCustomerName, formatPhone, formatDistanceKm } from './format';

describe('format — moneda Bs (solo presentación)', () => {
  it('9. muestra BOB como "Bs" y no como "BOB"', () => {
    const a = formatMoney(86, 'BOB');
    expect(a.startsWith('Bs ')).toBe(true);
    expect(a).not.toContain('BOB');
    expect(a).toMatch(/86[.,]00/);
    expect(formatMoney(179, 'BOB')).toMatch(/^Bs 179[.,]00$/);
  });

  it('currencySymbol mapea BOB→Bs y deja otras monedas intactas', () => {
    expect(currencySymbol('BOB')).toBe('Bs');
    expect(currencySymbol('USD')).toBe('USD');
  });

  it('valores no finitos caen a 0 sin romper', () => {
    expect(formatMoney(NaN, 'BOB')).toMatch(/^Bs 0[.,]00$/);
  });
});

describe('format — distancia de ruta metros→km (6D.2D)', () => {
  it('6. 1627 m → "1.63 km"', () => {
    expect(formatDistanceKm(1627)).toBe('1.63 km');
  });

  it('7. 6169 m → "6.17 km"', () => {
    expect(formatDistanceKm(6169)).toBe('6.17 km');
  });

  it('out_of_coverage 21864 m → "21.86 km"', () => {
    expect(formatDistanceKm(21864)).toBe('21.86 km');
  });

  it('8. valores inválidos → null sin lanzar', () => {
    expect(formatDistanceKm(null)).toBeNull();
    expect(formatDistanceKm(undefined)).toBeNull();
    expect(formatDistanceKm(NaN)).toBeNull();
    expect(formatDistanceKm(-1)).toBeNull();
    expect(formatDistanceKm(Infinity)).toBeNull();
  });

  it('0 m es válido → "0.00 km"', () => {
    expect(formatDistanceKm(0)).toBe('0.00 km');
  });
});

describe('format — normalización visual de nombres', () => {
  it('10. un nombre en MAYÚSCULAS se muestra capitalizado', () => {
    expect(formatCustomerName('JUAN PEREZ')).toBe('Juan Perez');
    expect(formatCustomerName('MARIA')).toBe('Maria');
  });

  it('no altera nombres que ya vienen en formato normal', () => {
    expect(formatCustomerName('Juan Pérez')).toBe('Juan Pérez');
    expect(formatCustomerName('juan')).toBe('juan');
    expect(formatCustomerName('McDonald')).toBe('McDonald');
  });

  it('maneja nulos, vacíos y espacios', () => {
    expect(formatCustomerName(null)).toBeNull();
    expect(formatCustomerName('   ')).toBeNull();
    expect(formatCustomerName('  Ana  ')).toBe('Ana');
  });
});

describe('format — teléfono visual (solo presentación)', () => {
  it('formatea el móvil boliviano inequívoco (591 + 8 dígitos que empiezan en 6/7)', () => {
    expect(formatPhone('59165006685')).toBe('+591 65006685');
    expect(formatPhone('59171234567')).toBe('+591 71234567');
  });

  it('deja intacto (sanitizado) cualquier formato no reconocible', () => {
    expect(formatPhone('12345')).toBe('12345'); // muy corto
    expect(formatPhone('59121234567')).toBe('59121234567'); // 8 dígitos que no empiezan en 6/7
    expect(formatPhone('12345678901')).toBe('12345678901'); // 11 dígitos sin prefijo 591
    expect(formatPhone('  +1 (555) 010-2020  ')).toBe('+1 (555) 010-2020'); // extranjero, solo trim
  });

  it('maneja nulos, vacíos y espacios', () => {
    expect(formatPhone(null)).toBeNull();
    expect(formatPhone(undefined)).toBeNull();
    expect(formatPhone('   ')).toBeNull();
  });
});
