import { describe, expect, it } from 'vitest';
import {
  catalogTermsFromNames,
  isKitchenNoteRequest,
  isOrderChangeRequest,
  kitchenNoteFrom,
  KITCHEN_NOTE_MAX_LENGTH,
} from './order-change-intent';

/**
 * "SIN CEBOLLA" NO ES REARMAR EL PEDIDO (04-09-2026).
 *
 * La carta real de Don Zarco, para que los tests midan contra lo que se vende
 * de verdad y no contra una lista inventada.
 */
const CARTA = catalogTermsFromNames([
  'Trancaburguer',
  'Trancapecho',
  'Salchiburguer',
  'Hamburguesa',
  'Lomito',
  'Salchipapa',
  'Gaseosa 2 L',
  'Gaseosa personal',
  'Soda Peque',
  'Soda Mini',
  'Vaso grande de maracuyá',
  'Vaso grande de limonada',
  'Porción de papa',
]);

const esNota = (texto: string) => isKitchenNoteRequest(texto, CARTA);

describe('preferencias que SÍ se anotan', () => {
  it('las tres formas que dijo el dueño', () => {
    expect(esNota('sin cebolla')).toBe(true);
    expect(esNota('auméntame ketchup')).toBe(true);
    expect(esNota('con ketchup solo')).toBe(true);
  });

  it('escritas como escribe la gente, con faltas y sin tildes', () => {
    expect(esNota('porfa sin cebolla')).toBe(true);
    expect(esNota('SIN PICANTE')).toBe(true);
    expect(esNota('aumenteme la mayonesa')).toBe(true);
    expect(esNota('con harta mayonesa porfa')).toBe(true);
    expect(esNota('que no lleve tomate')).toBe(true);
    expect(esNota('ponle bien poquito aji')).toBe(true);
  });
});

describe('lo que NO se anota — el lado caro del error', () => {
  it('pedir más de algo que se vende es un cambio de pedido, no una nota', () => {
    // Si esto se anotara, el total seguiría siendo el viejo: o cobramos de
    // menos o el cliente no recibe lo que pidió.
    expect(esNota('mándame 2 sodas más')).toBe(false);
    expect(esNota('agregame una gaseosa')).toBe(false);
    expect(esNota('con dos hamburguesas mas')).toBe(false);
    expect(esNota('sin la salchipapa mejor')).toBe(false);
    expect(esNota('aumenteme un lomito')).toBe(false);
  });

  it('cualquier número lo descarta: puede ser cantidad o dinero', () => {
    expect(esNota('sin cebolla 2 porfa')).toBe(false);
    expect(esNota('con 3 salsas')).toBe(false);
  });

  it('una cantidad en letra también, aunque no nombre producto', () => {
    expect(esNota('agregame una salsa')).toBe(false);
    expect(esNota('mandame otra mas')).toBe(false);
  });

  it('un mensaje sin marca de preferencia no es una nota', () => {
    expect(esNota('ya mande el comprobante')).toBe(false);
    expect(esNota('hola')).toBe(false);
    expect(esNota('cuanto era')).toBe(false);
    expect(esNota('ya salio mi pedido?')).toBe(false);
  });

  it('una parrafada no es una instrucción para la plancha', () => {
    const largo = 'sin cebolla ' + 'y por favor que salga rapido '.repeat(6);
    expect(largo.length).toBeGreaterThan(KITCHEN_NOTE_MAX_LENGTH);
    expect(esNota(largo)).toBe(false);
  });

  it('sin catálogo no se anota NADA', () => {
    // No poder descartar que nombró un producto es razón suficiente para no
    // tocar el pedido: es la misma dirección segura de todo el módulo.
    expect(isKitchenNoteRequest('sin cebolla', [])).toBe(false);
  });

  it('nada de texto, nada de nota', () => {
    expect(isKitchenNoteRequest(null, CARTA)).toBe(false);
    expect(isKitchenNoteRequest('   ', CARTA)).toBe(false);
  });
});

describe('el catálogo manda sobre la lista de palabras', () => {
  it('lo que se vende bloquea, aunque suene a ingrediente', () => {
    // El día que "Cebolla frita" entre a la carta, "sin cebolla" deja de ser una
    // nota sin que nadie tenga que tocar este módulo.
    const conCebolla = catalogTermsFromNames([...['Cebolla frita'], 'Hamburguesa']);
    expect(isKitchenNoteRequest('sin cebolla', conCebolla)).toBe(false);
  });

  it('el plural del cliente encuentra el singular de la carta', () => {
    expect(esNota('sin papas')).toBe(false);
  });

  it('una palabra que solo CONTIENE un producto no bloquea', () => {
    // `lomito` está dentro de `solomillo`, y aun así no habla de un lomito.
    expect(esNota('sin solomillo')).toBe(true);
  });

  it('las palabras cortas de la carta no se usan: "de", "2" y "L" están en todas partes', () => {
    expect(CARTA).not.toContain('de');
    expect(CARTA).not.toContain('2');
    expect(CARTA).toContain('gaseosa');
    expect(CARTA).toContain('maracuya');
  });
});

describe('kitchenNoteFrom — lo que ve la cocina', () => {
  it('es el texto del cliente, no una paráfrasis', () => {
    expect(kitchenNoteFrom('  sin cebolla   porfa ')).toBe('sin cebolla porfa');
  });

  it('conserva sus tildes y su forma de escribir', () => {
    expect(kitchenNoteFrom('con harta mayonesa, porfa 🙏')).toBe('con harta mayonesa, porfa 🙏');
  });

  it('una sola línea: la comanda no admite saltos', () => {
    expect(kitchenNoteFrom('sin cebolla\ny sin tomate')).toBe('sin cebolla y sin tomate');
  });
});

describe('isOrderChangeRequest — cuándo SÍ hay que rearmar', () => {
  const esCambio = (texto: string) => isOrderChangeRequest(texto, CARTA);

  it('pedir más de algo que se vende', () => {
    expect(esCambio('mándame 2 sodas más')).toBe(true);
    expect(esCambio('agregame una gaseosa')).toBe(true);
    expect(esCambio('me faltó el lomito')).toBe(true);
    expect(esCambio('no puse la salchipapa')).toBe(true);
    expect(esCambio('quitame la hamburguesa')).toBe(true);
  });

  it('una pregunta que nombra un producto NO es un cambio', () => {
    // Nombra la gaseosa y no pide nada: contestarle con "cambiá tu pedido"
    // sería responder a otra cosa.
    expect(esCambio('cuanto era la gaseosa?')).toBe(false);
    expect(esCambio('la hamburguesa es grande?')).toBe(false);
  });

  it('pedir algo que no se vende no rearma nada: eso es una nota', () => {
    // "sin cebolla" tiene marca de cambio y ningún producto detrás. Las dos
    // funciones tienen que estar de acuerdo, o el mismo mensaje dispararía dos
    // respuestas distintas según cuál se preguntara primero.
    expect(esCambio('sin cebolla')).toBe(false);
    expect(isKitchenNoteRequest('sin cebolla', CARTA)).toBe(true);
  });

  it('sin catálogo no se afirma nada', () => {
    expect(isOrderChangeRequest('agregame una gaseosa', [])).toBe(false);
  });

  it('nada de texto, nada que cambiar', () => {
    expect(isOrderChangeRequest(null, CARTA)).toBe(false);
    expect(isOrderChangeRequest('   ', CARTA)).toBe(false);
  });
});
