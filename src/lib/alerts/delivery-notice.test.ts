import { describe, expect, it } from 'vitest';
import {
  buildDeliveryNotice,
  mapsLink,
  escapeTelegramHtml,
  shortOrderNumber,
  whatsappLink,
  type DeliveryNoticeInput,
} from './delivery-notice';

/**
 * Lo que se prueba aquí es el CONTRATO del texto que recibe el grupo de
 * reparto: que estén los datos sin los que no se puede repartir, que las
 * cifras se lean bien y que el enlace apunte al punto exacto.
 */

const BASE: DeliveryNoticeInput = {
  orderNumber: 'ORD-000010',
  customerName: 'GRAD',
  customerPhone: '59175681881',
  items: [
    { name: 'Trancaburguer', quantity: 2 },
    { name: 'Gaseosa 2 L', quantity: 1 },
  ],
  deliveryAmount: 16,
  subtotalAmount: 78,
  isCash: false,
  collect: { kind: 'envio' },
  latitude: -17.842950820923,
  longitude: -63.179233551025,
  distanceMeters: 5762,
};

describe('el número que se cita al responder', () => {
  it('se queda con el correlativo y suelta la jornada', () => {
    expect(shortOrderNumber('ORD-260902-009')).toBe('ORD-009');
    expect(shortOrderNumber('ORD-260902-001')).toBe('ORD-001');
  });

  it('no trunca un correlativo que pasó de tres cifras', () => {
    // `lpad` no recorta: la noche que se pasen los 999, el número sigue siendo
    // único y sigue teniendo que verse entero.
    expect(shortOrderNumber('ORD-260902-1004')).toBe('ORD-1004');
  });

  it('deja intacto lo que no tiene esa forma', () => {
    // La numeración vieja, sin jornada. Recortarla daría un número inexistente.
    expect(shortOrderNumber('ORD-000123')).toBe('ORD-000123');
    expect(shortOrderNumber('cualquier cosa')).toBe('cualquier cosa');
  });

  it('encabeza el aviso él solo, sin emoji ni etiqueta', () => {
    // Es la línea que Telegram enseña recortada al citar: lo que vaya delante
    // empuja fuera el número.
    const primera = buildDeliveryNotice({ ...BASE, orderNumber: 'ORD-260902-009' })
      .split('\n')[0];
    expect(primera).toBe('ORD-009');
  });
});

describe('aviso al grupo de reparto', () => {
  it('lleva lo imprescindible para repartir', () => {
    const text = buildDeliveryNotice(BASE);
    for (const dato of ['ORD-000010', 'GRAD', '59175681881', 'Bs 16']) {
      expect(text, dato).toContain(dato);
    }
    // Sin el enlace, el repartidor no tiene a dónde ir.
    expect(text).toContain(escapeTelegramHtml(mapsLink(BASE.latitude, BASE.longitude)));
  });

  it('NO lleva el total del pedido (03-09-2026)', () => {
    // A quien lo lee no le sirve y encima confundía: el repartidor no cobra la
    // comida, y dos cifras juntas no dicen cuál de las dos hay que pedir.
    const text = buildDeliveryNotice({ ...BASE, deliveryAmount: 16 });
    expect(text).not.toContain('Total');
    expect(text).not.toContain('Bs 94');
  });

  it('detalla cantidades y cuenta el total de productos', () => {
    const text = buildDeliveryNotice(BASE);
    expect(text).toContain('2x Trancaburguer');
    expect(text).toContain('1x Gaseosa 2 L');
    expect(text).toContain('3 productos');
  });

  it('singulariza "producto" cuando solo hay uno', () => {
    const text = buildDeliveryNotice({ ...BASE, items: [{ name: 'Lomito', quantity: 1 }] });
    expect(text).toContain('Pedido (1 producto)');
    expect(text).not.toContain('1 productos');
  });

  it('escribe los importes enteros sin decimales sobrantes', () => {
    const text = buildDeliveryNotice(BASE);
    expect(text).toContain('Bs 16');
    expect(text).not.toContain('Bs 16.00');
  });

  it('conserva los decimales cuando el importe los tiene', () => {
    const text = buildDeliveryNotice({ ...BASE, deliveryAmount: 16.5 });
    expect(text).toContain('Bs 16.50');
  });

  it('muestra la distancia en kilómetros', () => {
    expect(buildDeliveryNotice(BASE)).toContain('5.8 km');
  });

  it('sin distancia conocida, omite el dato en vez de inventar un cero', () => {
    const text = buildDeliveryNotice({ ...BASE, distanceMeters: null });
    expect(text).toContain('Envío: Bs 16');
    expect(text).not.toContain('0.0 km');
  });

  it('no lleva dirección en texto: el enlace es el único dato del dónde', () => {
    const text = buildDeliveryNotice(BASE);
    // El geocoding inverso devolvía "Calle 1, Santa Cruz de la Sierra…", que
    // ocupaba dos renglones sin distinguir un punto de otro.
    expect(text).not.toContain('Zona');
    expect(text).toContain(`Ubicación: ${escapeTelegramHtml(mapsLink(BASE.latitude, BASE.longitude))}`);
  });

  it('un pedido sin nombre no deja el campo en blanco', () => {
    for (const nombre of [null, '', '   ']) {
      const text = buildDeliveryNotice({ ...BASE, customerName: nombre });
      expect(text, String(nombre)).toContain('Cliente: sin nombre');
    }
  });

  it('no usa markdown: un nombre con asteriscos no puede romper el mensaje', () => {
    const text = buildDeliveryNotice({ ...BASE, customerName: '*Ana_B*' });
    expect(text).toContain('Cliente: *Ana_B*');
    // El cuerpo no introduce marcas propias que Telegram intentaría parsear.
    expect(text).not.toContain('**');
    expect(text).not.toContain('__');
  });

  it('el enlace lleva las coordenadas exactas, sin redondear', () => {
    const link = escapeTelegramHtml(mapsLink(-17.842950820923, -63.179233551025));
    expect(link).toContain('-17.842950820923,-63.179233551025');
    expect(link.startsWith('https://')).toBe(true);
  });
});

describe('el teléfono, a un toque', () => {
  it('sale como enlace al chat y no como número suelto', () => {
    const text = buildDeliveryNotice(BASE);
    expect(text).toContain('Teléfono: https://wa.me/59175681881');
    // Una sola vez: el número ya se lee dentro del enlace, y repetirlo aparte
    // sería el mismo dato dos veces en un mensaje que se mira de un vistazo.
    expect(text).not.toMatch(/Teléfono: 59175681881/);
  });

  it('limpia lo que traiga el número antes de enlazarlo', () => {
    // `wa.me` solo admite dígitos: un `+` o un guion romperían el enlace.
    const text = buildDeliveryNotice({ ...BASE, customerPhone: '+591 7568-1881' });
    expect(text).toContain('https://wa.me/59175681881');
  });

  it('sin dígitos que enlazar, escribe lo que haya', () => {
    // Un enlace roto es peor que un número que hay que teclear.
    expect(whatsappLink('')).toBe('');
    expect(whatsappLink('sin número')).toBe('sin número');
  });
});

describe('la instrucción de cobro', () => {
  it('dice qué hacer, en una línea y en mayúsculas', () => {
    expect(buildDeliveryNotice({ ...BASE, collect: { kind: 'envio' } }))
      .toContain('COBRAR ENVÍO');
    expect(buildDeliveryNotice({ ...BASE, collect: { kind: 'pagado' } }))
      .toContain('ENVÍO PAGADO');
  });

  it('las dos instrucciones se excluyen: nunca salen juntas', () => {
    // Un mensaje que dijera las dos cosas es peor que uno que no diga ninguna.
    const cobrar = buildDeliveryNotice({ ...BASE, collect: { kind: 'envio' } });
    const pagado = buildDeliveryNotice({ ...BASE, collect: { kind: 'pagado' } });
    expect(cobrar).not.toContain('ENVÍO PAGADO');
    expect(pagado).not.toContain('COBRAR ENVÍO');
  });

  it('cobrar el envío NO repite el monto: ya está en la línea de arriba', () => {
    // El mismo número dos veces, leído de reojo y en la moto, es una
    // oportunidad de leer el equivocado.
    const text = buildDeliveryNotice({ ...BASE, deliveryAmount: 16, collect: { kind: 'envio' } });
    expect(text).toContain('Envío: Bs 16');
    expect(text.match(/Bs 16/g) ?? []).toHaveLength(1);
  });

  it('cobrar TODO sí lleva la cifra: no aparece en ningún otro sitio', () => {
    const text = buildDeliveryNotice({ ...BASE, collect: { kind: 'todo', amount: 94 } });
    expect(text).toContain('COBRAR TODO: Bs 94');
  });

  it('sin poder determinarlo, no se escribe ninguna instrucción', () => {
    // El repartidor siempre puede preguntar; no puede deshacer un cobro.
    const text = buildDeliveryNotice({ ...BASE, collect: null });
    expect(text).not.toContain('COBRAR');
    expect(text).not.toContain('PAGADO');
    // Y el resto del aviso sigue entero.
    expect(text).toContain('Envío: Bs 16');
    expect(text).toContain(escapeTelegramHtml(mapsLink(BASE.latitude, BASE.longitude)));
  });

  it('va entre el envío y la ubicación, en su propio renglón', () => {
    const lineas = buildDeliveryNotice(BASE).split('\n');
    const iEnvio = lineas.findIndex((l) => l.startsWith('Envío:'));
    const iCobro = lineas.findIndex((l) => l === 'COBRAR ENVÍO');
    const iMapa = lineas.findIndex((l) => l.startsWith('Ubicación:'));
    expect(iEnvio).toBeGreaterThan(-1);
    expect(iCobro).toBeGreaterThan(iEnvio);
    expect(iMapa).toBeGreaterThan(iCobro);
  });
});

/**
 * EL AVISO DE EFECTIVO (04-09-2026).
 *
 * Quien lleva un pedido en efectivo no comprueba un cobro: lo hace. Necesita el
 * desglose entero para pedir la cifra y dar el vuelto, y necesita ver de un
 * golpe que este pedido no está pagado.
 */
describe('aviso de reparto en EFECTIVO', () => {
  const EFECTIVO = { ...BASE, isCash: true, subtotalAmount: 18, deliveryAmount: 10 };

  it('avisa en negrita que es efectivo', () => {
    // Negrita y no mayúsculas a secas: es lo primero que cambia su trabajo.
    expect(buildDeliveryNotice(EFECTIVO)).toContain('<b>QUIERE EFECTIVO</b>');
  });

  it('lleva el desglose y la suma que hay que cobrar', () => {
    const text = buildDeliveryNotice(EFECTIVO);
    expect(text).toContain('Productos: Bs 18');
    expect(text).toContain('Envío: Bs 10');
    expect(text).toContain('TOTAL A COBRAR: Bs 28');
  });

  it('el total se calcula, no se recibe: no puede discrepar del desglose', () => {
    const text = buildDeliveryNotice({ ...EFECTIVO, subtotalAmount: 46.5, deliveryAmount: 13 });
    expect(text).toContain('TOTAL A COBRAR: Bs 59.50');
  });

  it('no lleva la instrucción del QR: en efectivo se cobra todo, y ya lo dice', () => {
    const text = buildDeliveryNotice({ ...EFECTIVO, collect: { kind: 'envio' } });
    expect(text).not.toContain('COBRAR ENVÍO');
    expect(text).not.toContain('ENVÍO PAGADO');
  });

  it('conserva lo de siempre: pedido, cliente, productos y ubicación', () => {
    const text = buildDeliveryNotice(EFECTIVO);
    expect(text).toContain('Cliente: GRAD');
    expect(text).toContain(escapeTelegramHtml(mapsLink(BASE.latitude, BASE.longitude)));
  });
});

describe('escape de HTML — el aviso viaja con parse_mode', () => {
  it('un nombre con < > & no rompe el mensaje', () => {
    // Sin escapar, Telegram responde 400 y el aviso no llega a nadie.
    const text = buildDeliveryNotice({ ...BASE, customerName: 'Ana & <b>Pepe</b>' });
    expect(text).toContain('Cliente: Ana &amp; &lt;b&gt;Pepe&lt;/b&gt;');
    expect(text).not.toContain('<b>Pepe');
  });

  it('el nombre de un producto también se escapa', () => {
    const text = buildDeliveryNotice({ ...BASE, items: [{ name: 'Combo <3', quantity: 1 }] });
    expect(text).toContain('1x Combo &lt;3');
  });

  it('el & del enlace de Maps se escapa: sin eso se come media URL', () => {
    expect(buildDeliveryNotice(BASE)).toContain('&amp;query=');
  });
});
