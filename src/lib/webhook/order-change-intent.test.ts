import { describe, expect, it } from 'vitest';
import {
  catalogTermsFromNames,
  isKitchenNoteRequest,
  isOrderChangeAnnouncement,
  isOrderChangeRequest,
  isQuantityFixRequest,
  kitchenNoteFrom,
  KITCHEN_NOTE_MAX_LENGTH,
  ORDER_CHANGE_ANNOUNCEMENT_MAX_LENGTH,
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

describe('isOrderChangeAnnouncement — pide cambiar antes de decir qué', () => {
  it('la frase que abrió el caso del 04-09-2026', () => {
    // 81 segundos antes de "Una hamburguesa con papas", que sí se reconocía.
    // En ese hueco el turno se lo quedó el modelo y derivó la conversación.
    expect(isOrderChangeAnnouncement('Puedo aumentar')).toBe(true);
  });

  it('las formas en que se pregunta lo mismo', () => {
    expect(isOrderChangeAnnouncement('quiero agregar')).toBe(true);
    expect(isOrderChangeAnnouncement('se puede aumentar?')).toBe(true);
    expect(isOrderChangeAnnouncement('puedo añadir algo mas')).toBe(true);
    expect(isOrderChangeAnnouncement('quiero cambiar mi pedido')).toBe(true);
    expect(isOrderChangeAnnouncement('puedo modificar el pedido porfa')).toBe(true);
    expect(isOrderChangeAnnouncement('quiero quitar una cosa')).toBe(true);
    expect(isOrderChangeAnnouncement('puedo aumentarle')).toBe(true);
  });

  it('las frases de la prueba del 04-09-2026, que no reconocía nadie', () => {
    // El dueño probó el flujo escribiendo esto y recibió el botón del menú de
    // siempre, que abre un pedido NUEVO en vez de corregir el suyo.
    expect(isOrderChangeAnnouncement('Quiero armar de nuevo')).toBe(true);
    expect(isOrderChangeAnnouncement('Me olvide')).toBe(true);
    expect(isOrderChangeAnnouncement('quiero empezar de nuevo')).toBe(true);
    expect(isOrderChangeAnnouncement('rehacer pedido')).toBe(true);
  });

  it('armar un pedido NUEVO no es rearmar el que ya tiene', () => {
    expect(isOrderChangeAnnouncement('quiero armar un pedido')).toBe(false);
    expect(isOrderChangeAnnouncement('hola quiero pedir')).toBe(false);
  });

  it('reconocer el olvido ya es pedir el cambio', () => {
    expect(isOrderChangeAnnouncement('me equivoqué')).toBe(true);
    expect(isOrderChangeAnnouncement('me olvidé de algo')).toBe(true);
    expect(isOrderChangeAnnouncement('no puse todo')).toBe(true);
  });

  it('el verbo tiene que CERRAR la frase: con complemento ya no es un anuncio', () => {
    // "Puedo aumentar el ají" es una preferencia de cocina disfrazada, y
    // mandarle a rearmar su pedido por un condimento es el error barato que
    // este límite evita. Sigue el camino de hoy.
    expect(isOrderChangeAnnouncement('puedo aumentar el aji')).toBe(false);
    expect(isOrderChangeAnnouncement('aumentame la mayonesa')).toBe(false);
  });

  it('lo que también se cambia y no es el pedido', () => {
    expect(isOrderChangeAnnouncement('puedo cambiar la direccion')).toBe(false);
    expect(isOrderChangeAnnouncement('me falta pagar')).toBe(false);
    expect(isOrderChangeAnnouncement('puedo cambiar la forma de pago')).toBe(false);
    expect(isOrderChangeAnnouncement('cuanto falta')).toBe(false);
  });

  it('preguntar por el pedido no es querer cambiarlo', () => {
    expect(isOrderChangeAnnouncement('hola')).toBe(false);
    expect(isOrderChangeAnnouncement('puedo pedir')).toBe(false);
    expect(isOrderChangeAnnouncement('ya salio mi pedido?')).toBe(false);
    expect(isOrderChangeAnnouncement('cuanto seria')).toBe(false);
  });

  it('una parrafada no es un anuncio: ahí el detalle ya va dentro', () => {
    const largo =
      'hola buenas noches disculpe la molestia una consulta por favor si es que se puede cambiar';
    expect(largo.length).toBeGreaterThan(ORDER_CHANGE_ANNOUNCEMENT_MAX_LENGTH);
    expect(isOrderChangeAnnouncement(largo)).toBe(false);
  });

  it('no necesita catálogo: lo que lo define es que NO nombra producto', () => {
    // La vía del catálogo se cae con `menu_items` ilegible; esta no.
    expect(isOrderChangeAnnouncement('puedo aumentar')).toBe(true);
    expect(isOrderChangeAnnouncement(null)).toBe(false);
    expect(isOrderChangeAnnouncement('   ')).toBe(false);
  });
});

/**
 * EL PEDIDO #20 (05-09-2026).
 *
 * El cliente armó 2 trancapechos en el menú, pagó el importe de 3 y lo avisó
 * por chat. Ninguno de los tres detectores se activó, la cocina recibió una
 * comanda de 2 con un pago de 3, y tuvo que entrar una persona a resolverlo.
 *
 * Estos tests son esa conversación, frase por frase.
 */
describe('el pedido #20: lo que se escribió y nadie leyó', () => {
  it('reconoce el producto PARTIDO en dos palabras', () => {
    // La carta dice "Trancapecho"; el cliente escribió "tranca pecho". Entre
    // atenderlo y no atenderlo había exactamente un espacio.
    expect(isOrderChangeRequest('Que sean 3 tranca pecho', CARTA)).toBe(true);
    expect(isOrderChangeRequest('quiero 2 tranca burguer mas', CARTA)).toBe(true);
    // Y lo de siempre sigue igual de bien.
    expect(isOrderChangeRequest('que sean 3 trancapechos', CARTA)).toBe(true);
  });

  it('juntar dos palabras no inventa productos que nadie nombró', () => {
    // El par se pega SOLO para compararlo con la carta: si de ahí no sale nada
    // que se venda, la frase sigue sin nombrar producto.
    expect(isOrderChangeRequest('quiero saber cuanto falta', CARTA)).toBe(false);
    expect(isOrderChangeRequest('mandame la ubicacion', CARTA)).toBe(false);
  });

  it('el diminutivo es un producto, no una preferencia', () => {
    // "aumentame papitas" se ANOTABA en la comanda: una porción más de papas
    // que nadie cobraba. `papitas` no era `papas` para una comparación exacta.
    expect(isKitchenNoteRequest('aumentame papitas', CARTA)).toBe(false);
    expect(isOrderChangeRequest('aumentame papitas', CARTA)).toBe(true);
    expect(isOrderChangeRequest('agregame una gaseosita', CARTA)).toBe(true);
  });

  it('un olvido NUNCA se anota en la comanda, aunque traiga un verbo de poner', () => {
    // "Me olvide, agregame esto" activaba las dos puertas y ganaba la de la
    // nota, que va antes: la frase acababa impresa en la comanda y el cliente
    // recibía un "listo, ya lo anotamos" con el total sin cambiar.
    expect(isKitchenNoteRequest('me olvide agregame esto', CARTA)).toBe(false);
    expect(isOrderChangeAnnouncement('me olvide agregame esto')).toBe(true);

    // Y la preferencia de verdad se sigue anotando igual que ayer.
    expect(isKitchenNoteRequest('agregame harta mayonesa', CARTA)).toBe(true);
    expect(isKitchenNoteRequest('ponle bien poquito aji', CARTA)).toBe(true);
  });

  it('las formas de reconocer un olvido que faltaban', () => {
    expect(isOrderChangeAnnouncement('se me paso')).toBe(true);
    expect(isOrderChangeAnnouncement('m olvide de algo')).toBe(true);
    expect(isOrderChangeAnnouncement('esta mal la orden')).toBe(true);
    expect(isOrderChangeAnnouncement('pedi mal')).toBe(true);
  });
});

/**
 * CORREGIR LA CANTIDAD SIN NOMBRAR EL PRODUCTO (05-09-2026).
 *
 * Es la forma más natural de rectificar delante del total —el producto acaba de
 * decirse, así que nadie lo repite— y era la familia entera que se caía por el
 * hueco entre las tres puertas.
 */
describe('la cantidad corregida a secas', () => {
  it('reconoce la corrección aunque no nombre nada', () => {
    for (const frase of [
      'que sean 3',
      'son 3 no 2',
      'mejor 2',
      'en realidad quiero 3',
      'agregame 1 mas',
      'aumentame uno',
      'puse 1 pero quiero 2',
      'perdon son 3',
      'mejor q sean 4',
      'en vez de 2 que sean 3',
    ]) {
      expect(isQuantityFixRequest(frase), frase).toBe(true);
    }
  });

  it('una cifra que no cuenta comida no es una corrección', () => {
    // Son las respuestas normales en este mismo punto de la conversación.
    for (const frase of [
      'llego en 20 minutos',
      'estoy a 3 cuadras',
      'son 50 bs',
      'somos 4 personas',
      'en 2 horas',
    ]) {
      expect(isQuantityFixRequest(frase), frase).toBe(false);
    }
  });

  it('los litros SÍ cuentan: aquí se vende una gaseosa de 2 L', () => {
    expect(isQuantityFixRequest('mejor una de 2 litros')).toBe(true);
  });

  it('hablar del pago no es corregir el pedido', () => {
    expect(isQuantityFixRequest('me falta pagar 20 bs')).toBe(false);
    expect(isQuantityFixRequest('ya pague los 49')).toBe(false);
  });

  it('sin cifra no hay corrección que leer', () => {
    expect(isQuantityFixRequest('que sean grandes')).toBe(false);
    expect(isQuantityFixRequest('gracias')).toBe(false);
    expect(isQuantityFixRequest(null)).toBe(false);
    expect(isQuantityFixRequest('')).toBe(false);
  });

  it('una parrafada no es una corrección: ahí el detalle ya va dentro', () => {
    const largo =
      'hola buenas noches disculpe una consulta por favor seria posible que sean 3 en vez de 2';
    expect(largo.length).toBeGreaterThan(ORDER_CHANGE_ANNOUNCEMENT_MAX_LENGTH);
    expect(isQuantityFixRequest(largo)).toBe(false);
  });

  it('la ráfaga con el número pegado al texto se separa antes de leerla', () => {
    // "2com todo" es como se teclea con el pulgar. Sin separarlo no hay ni
    // cantidad ni producto que reconocer.
    expect(isOrderChangeRequest('quiero 2trancapechos', CARTA)).toBe(true);
    expect(isKitchenNoteRequest('1sin locoto', CARTA)).toBe(false);
  });
});
