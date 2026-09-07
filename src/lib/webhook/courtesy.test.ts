import { describe, it, expect } from 'vitest';
import { isCourtesyOnly } from './courtesy';

/**
 * La asimetría de este módulo es la CONTRARIA a la de `order-change-intent`, y
 * estos dos bloques son esa asimetría escrita: lo que reconoce tiene que ser
 * acuse de verdad, y en la duda NO lo es — porque no serlo significa recibir
 * respuesta, que es el lado barato del error.
 */
describe('isCourtesyOnly — lo que NO pide nada', () => {
  it('el acuse seco', () => {
    for (const frase of ['ok', 'Ok', 'okey', 'ya', 'listo', 'dale', 'vale', 'va']) {
      expect(isCourtesyOnly(frase), frase).toBe(true);
    }
  });

  it('las gracias, con y sin adorno', () => {
    for (const frase of [
      'gracias',
      'Gracias!',
      'muchas gracias',
      'Ok muchas gracias', // el mensaje literal del pedido #13
      'mil gracias',
      'grax',
      'ya listo gracias',
      'perfecto muchas gracias',
    ]) {
      expect(isCourtesyOnly(frase), frase).toBe(true);
    }
  });

  it('los emojis solos, sin lista que mantener', () => {
    // "🙏" es el tercer mensaje del pedido #13. Nada de esto tiene letras, así
    // que se reconoce por lo que NO trae y no por estar en ningún sitio.
    for (const frase of ['🙏', '👍', '👍👍', '🙌', '...', '❤️']) {
      expect(isCourtesyOnly(frase), frase).toBe(true);
    }
  });

  it('la conformidad y la despedida', () => {
    for (const frase of ['esta bien', 'asi esta bien', 'no hay problema', 'buenas noches', 'chau']) {
      expect(isCourtesyOnly(frase), frase).toBe(true);
    }
  });
});

describe('isCourtesyOnly — lo que SÍ pide algo', () => {
  it('las tres frases de producción que nadie contestó', () => {
    for (const frase of [
      'No le coloquen locoto al trancapecho',
      'Más salsita',
      'Me podría mandar salsa bbq',
      'Un favor',
    ]) {
      expect(isCourtesyOnly(frase), frase).toBe(false);
    }
  });

  it('basta UNA palabra de fuera: la cortesía no tapa la petición', () => {
    // Por esto pueden entrar `no`, `si`, `sin` o `mas` en la lista sin peligro:
    // solas son acuse, y en cuanto acompañan a algo real ese algo las delata.
    for (const frase of [
      'gracias sin locoto',
      'ok pero sin cebolla',
      'listo, mandame una gaseosa',
      'ya salio el pedido',
      'cuanto falta',
    ]) {
      expect(isCourtesyOnly(frase), frase).toBe(false);
    }
  });

  it('un texto que no es texto no es un acuse', () => {
    expect(isCourtesyOnly(null)).toBe(false);
    expect(isCourtesyOnly(undefined)).toBe(false);
  });
});
