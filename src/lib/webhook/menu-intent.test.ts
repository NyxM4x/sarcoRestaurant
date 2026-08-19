import { describe, it, expect } from 'vitest';
import { isMenuIntent, normalizeIntentText } from './menu-intent';

describe('normalizeIntentText', () => {
  it('minimiza, quita tildes y colapsa espacios', () => {
    expect(normalizeIntentText('  Menú   ')).toBe('menu');
    expect(normalizeIntentText('QUÉ   TIENEN')).toBe('que tienen');
    expect(normalizeIntentText('Ver\tProductos')).toBe('ver productos');
  });
});

describe('isMenuIntent — activa', () => {
  const positives = [
    'menu',
    'menú',
    'MENU',
    'Menú',
    'carta',
    'pedir',
    'ordenar',
    'ver menu',
    'ver menú',
    'ver carta',
    'ver productos',
    'quiero pedir',
    'quiero pedir una doble o nada',
    'quiero hacer un pedido',
    'quiero ordenar',
    'quiero comprar',
    'quiero un pedido',
    'hacer pedido',
    'hacer un pedido',
    'que tienen',
    'qué tienen',
  ];
  for (const t of positives) {
    it(`"${t}" → true`, () => expect(isMenuIntent(t)).toBe(true));
  }
});

describe('isMenuIntent — NO activa (irrelevantes)', () => {
  const negatives = [
    'hola',
    'buenas',
    'gracias',
    'precio',
    'comentario', // contiene "menu"? no; pero prueba substring ingenuo
    'mensaje',
    'quiero saber el horario',
    '',
    '   ',
  ];
  for (const t of negatives) {
    it(`"${t}" → false`, () => expect(isMenuIntent(t)).toBe(false));
  }

  it('substring de "menu"/"pedir" no activa (comentario, pedirle prestado)', () => {
    expect(isMenuIntent('comentario')).toBe(false);
    expect(isMenuIntent('pedirle prestado')).toBe(false);
    expect(isMenuIntent('mensaje nuevo')).toBe(false);
  });

  it('entradas no-string → false', () => {
    expect(isMenuIntent(null)).toBe(false);
    expect(isMenuIntent(undefined)).toBe(false);
  });
});

describe('isMenuIntent — negaciones (evaluadas antes que la intención)', () => {
  const negations = [
    'no quiero pedir',
    'ya no quiero pedir',
    'no quiero ordenar',
    'ya no quiero ordenar',
    'no quiero comprar',
    'todavía no quiero pedir',
    'aun no quiero pedir',
    'aún no quiero pedir',
  ];
  for (const t of negations) {
    it(`"${t}" → false`, () => expect(isMenuIntent(t)).toBe(false));
  }

  it('la palabra "no" dentro de otra intención no bloquea (numero)', () => {
    expect(normalizeIntentText('numero')).toBe('numero');
    expect(isMenuIntent('quiero pedir el numero 2')).toBe(true);
  });
});

describe('isMenuIntent — necesidad de menú con negación de ACCESO → true (6D.2E.final)', () => {
  const needs = [
    'no encuentro el menú',
    'no encuentro la carta',
    'no veo el menú',
    'no veo la carta',
    'no me aparece el menú',
    'no me sale el menú',
    'no puedo ver el menú',
    'no puedo abrir la carta',
  ];
  for (const t of needs) {
    it(`"${t}" → true (el cliente necesita el menú)`, () => expect(isMenuIntent(t)).toBe(true));
  }

  it('declinar un pedido sigue en false (no se confunde con necesidad de acceso)', () => {
    for (const t of [
      'no quiero pedir',
      'no quiero ordenar',
      'ya no quiero comprar',
      'todavía no quiero hacer un pedido',
    ]) {
      expect(isMenuIntent(t), t).toBe(false);
    }
  });

  it('"no" con acceso frustrado pero SIN sustantivo de menú → false', () => {
    expect(isMenuIntent('no encuentro nada')).toBe(false);
    expect(isMenuIntent('no veo bien')).toBe(false);
  });
});
