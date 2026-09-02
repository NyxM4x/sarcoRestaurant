import { describe, expect, it } from 'vitest';
import {
  buildDeliveryNotice,
  mapsLink,
  shortOrderNumber,
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
  totalAmount: 94,
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
    for (const dato of ['ORD-000010', 'GRAD', '59175681881', 'Bs 16', 'Bs 94']) {
      expect(text, dato).toContain(dato);
    }
    // Sin el enlace, el repartidor no tiene a dónde ir.
    expect(text).toContain(mapsLink(BASE.latitude, BASE.longitude));
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
    expect(text).toContain(`Ubicación: ${mapsLink(BASE.latitude, BASE.longitude)}`);
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
    const link = mapsLink(-17.842950820923, -63.179233551025);
    expect(link).toContain('-17.842950820923,-63.179233551025');
    expect(link.startsWith('https://')).toBe(true);
  });
});
