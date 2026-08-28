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

describe('menú — cómo escribe la gente de verdad', () => {
  it('los signos de interrogación no impiden abrir el menú', () => {
    // "¿Menú?" es la forma MÁS natural de preguntar por la carta. Antes no
    // coincidía con nada: el cliente escribía justo lo que había que escribir y
    // no le llegaba nada.
    for (const t of ['¿menú?', 'menu?', 'Menú.', '¿Carta?', 'menu!', '¿Qué tienen?']) {
      expect(isMenuIntent(t), t).toBe(true);
    }
  });

  it('un saludo delante no rompe la intención', () => {
    // En WhatsApp casi todo el mundo saluda antes de pedir.
    for (const t of [
      'Hola, quiero pedir',
      'hola quiero pedir',
      'Buenas noches, quiero hacer un pedido',
      'Buenas, menú',
      'Hey, ver carta',
      'Disculpe, quiero ordenar',
    ]) {
      expect(isMenuIntent(t), t).toBe(true);
    }
  });

  it('las negaciones siguen SIN abrir el menú, con saludo o sin él', () => {
    // Quitar el saludo no puede convertir un rechazo en una petición: lo que
    // queda ("no quiero pedir") tampoco empieza por ninguna frase de intención.
    for (const t of [
      'no quiero pedir',
      'Hola, no quiero pedir',
      'Buenas noches, ya no quiero ordenar',
      'todavía no quiero hacer un pedido',
    ]) {
      expect(isMenuIntent(t), t).toBe(false);
    }
  });

  it('un saludo a secas NO abre el menú', () => {
    // Es la decisión de producto de hoy: saludar no es pedir. Lo que atiende a
    // quien solo dice "hola" es el agente, no esta ruta determinística.
    for (const t of ['hola', 'Hola', 'buenas noches', 'hey', '¿hola?']) {
      expect(isMenuIntent(t), t).toBe(false);
    }
  });

  it('solo se retira UN saludo: esto no es una búsqueda de subcadena', () => {
    // Quitar palabras hasta que algo encaje abriría el menú con cualquier
    // mensaje que mencione comer de pasada.
    expect(isMenuIntent('hola buenas tardes disculpe quiero pedir')).toBe(false);
    expect(isMenuIntent('mi hermano dijo que quiero pedir')).toBe(false);
  });
});
