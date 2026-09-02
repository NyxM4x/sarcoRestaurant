import { describe, it, expect } from 'vitest';
import {
  digitsOf,
  matchesAccount,
  matchesHolder,
  normalizeName,
  parseExpectedAccount,
} from './expected-account';

describe('cuenta — reconocer la nuestra escrita de cualquier manera', () => {
  it('el formato no importa: guiones, espacios y puntos no distinguen nada', () => {
    expect(digitsOf('1-234 567.890')).toBe('1234567890');
    expect(matchesAccount('1-234-567-890', ['1234567890'])).toBe('match');
  });

  it('reconoce la cuenta enmascarada por los últimos cuatro dígitos', () => {
    // Es lo único que enseña más de un banco, y es lo que hay que poder validar.
    expect(matchesAccount('****7890', ['1234567890'])).toBe('match');
    expect(matchesAccount('XXXX-XXXX-7890', ['1234567890'])).toBe('match');
  });

  it('una cuenta ajena NO pasa aunque se parezca', () => {
    expect(matchesAccount('1234567891', ['1234567890'])).toBe('mismatch');
    expect(matchesAccount('****7891', ['1234567890'])).toBe('mismatch');
  });

  it('sin dato leído o sin dato configurado, no acusa: responde `unknown`', () => {
    expect(matchesAccount(null, ['1234567890'])).toBe('unknown');
    expect(matchesAccount('1234567890', [])).toBe('unknown');
    expect(matchesAccount('', [''])).toBe('unknown');
  });

  it('un fragmento más corto que la cola no alcanza para acusar', () => {
    // Con dos dígitos visibles, 1 de cada 100 cuentas coincidiría por azar:
    // demasiado poco para llamar ladrón a alguien.
    expect(matchesAccount('**90', ['1234567890'])).toBe('unknown');
  });
});

describe('cuenta — cobrar por dos billeteras a la vez', () => {
  // El negocio recibe por dos monederos distintos, y los dos son suyos. Con una
  // sola cuenta configurada, cada pago al otro saldría acusado.
  const LAS_DOS = ['78486705', '1234567890'];

  it('vale cualquiera de las dos', () => {
    expect(matchesAccount('78486705', LAS_DOS)).toBe('match');
    expect(matchesAccount('1234567890', LAS_DOS)).toBe('match');
  });

  it('reconoce la segunda aunque llegue enmascarada', () => {
    expect(matchesAccount('****6705', LAS_DOS)).toBe('match');
  });

  it('acusa solo cuando NINGUNA coincide', () => {
    expect(matchesAccount('78486704', LAS_DOS)).toBe('mismatch');
  });

  it('lo ilegible sigue siendo `unknown`, no una acusación', () => {
    // Ninguna pudo compararse de verdad: dos dígitos no distinguen nada.
    expect(matchesAccount('**05', LAS_DOS)).toBe('unknown');
  });
});

describe('titular — el mismo nombre escrito por bancos distintos', () => {
  it('normaliza tildes, mayúsculas y puntuación', () => {
    expect(normalizeName('  Juan Pérez-García  ')).toBe('JUAN PEREZ GARCIA');
  });

  it('el nombre corto encaja dentro del largo', () => {
    expect(matchesHolder('DON ZARCO SRL', ['DON ZARCO'])).toBe('match');
    expect(matchesHolder('JUAN ZARCO', ['JUAN CARLOS ZARCO MENDOZA'])).toBe('match');
  });

  it('las iniciales no rompen la coincidencia', () => {
    // `JUAN P. ZARCO` y `JUAN PABLO ZARCO` son la misma persona; exigir la
    // inicial haría fallar todos los pagos de un banco entero.
    expect(matchesHolder('JUAN P. ZARCO', ['JUAN PABLO ZARCO'])).toBe('match');
  });

  it('basta con que UNO de los alias coincida', () => {
    expect(matchesHolder('ZARCO GASTRONOMIA', ['DON ZARCO', 'ZARCO GASTRONOMIA'])).toBe('match');
  });

  it('otro titular NO pasa', () => {
    expect(matchesHolder('MARIA LOPEZ', ['DON ZARCO', 'JUAN ZARCO'])).toBe('mismatch');
  });

  it('sin nombre leído o sin nombre configurado, `unknown`', () => {
    expect(matchesHolder(null, ['DON ZARCO'])).toBe('unknown');
    expect(matchesHolder('DON ZARCO', [])).toBe('unknown');
    // Solo palabras de dos letras: no identifican a nadie.
    expect(matchesHolder('DE LA', ['DON ZARCO'])).toBe('unknown');
  });
});

describe('configuración de la cuenta esperada', () => {
  it('parte los alias por `|` y descarta los vacíos', () => {
    const cuenta = parseExpectedAccount({
      bank: ' Banco Unión ',
      bankAliases: 'BUN | ',
      accountNumber: ' 1234567890 | 78486705 ',
      holder: 'DON ZARCO',
      holderAliases: 'DON ZARCO SRL | | ZARCO GASTRONOMIA',
    });
    expect(cuenta).toEqual({
      bankNames: ['Banco Unión', 'BUN'],
      accountNumbers: ['1234567890', '78486705'],
      holderNames: ['DON ZARCO', 'DON ZARCO SRL', 'ZARCO GASTRONOMIA'],
    });
  });

  it('sin cuenta NI titular devuelve null: no hay patrón contra el que comparar', () => {
    // Es el fail-closed del análisis: sin patrón no se emite ningún veredicto,
    // en vez de aprobar comprobantes contra la nada.
    expect(parseExpectedAccount({})).toBeNull();
    expect(parseExpectedAccount({ bank: 'Banco Unión' })).toBeNull();
  });

  it('con solo el titular ya hay algo que contrastar', () => {
    expect(parseExpectedAccount({ holder: 'DON ZARCO' })).toEqual({
      bankNames: [],
      accountNumbers: [],
      holderNames: ['DON ZARCO'],
    });
  });
});
