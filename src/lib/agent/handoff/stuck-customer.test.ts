import { describe, it, expect } from 'vitest';
import {
  isStuckCustomer,
  STUCK_CUSTOMER_MESSAGES,
  STUCK_WINDOW_MINUTES,
} from './stuck-customer';

/**
 * El cliente que no consigue pedir.
 *
 * Dos versiones anteriores fallaron por el mismo motivo de fondo: medían
 * VOLUMEN y lo confundían con atasco. La segunda saltó en un pedido que
 * terminó pagado — saludo, dos intentos, ubicación, ubicación corregida y
 * comprobante suman seis mensajes sin nada anómalo. Cien pedidos así son cien
 * alertas falsas, y a la tercera nadie mira el grupo.
 */

/** Un cliente atascado de manual: recibió el menú y no llegó a nada. */
const ATASCADO = { messages: STUCK_CUSTOMER_MESSAGES, menusSent: 2, hasProgress: false };

describe('isStuckCustomer — el caso que hay que detectar', () => {
  it('con el menú en la mano, muchos mensajes y ningún avance: avisa', () => {
    expect(isStuckCustomer(ATASCADO)).toBe(true);
  });

  it('y por encima del umbral también', () => {
    expect(isStuckCustomer({ ...ATASCADO, messages: 30 })).toBe(true);
  });
});

describe('isStuckCustomer — las dos puertas que van ANTES de contar', () => {
  it('cualquier avance lo descarta, por muchos mensajes que haya', () => {
    // Es la puerta que estaba rota: se cruzaba por `orders.source_message_id`
    // y el checkout web lo inserta NULL, así que ningún pedido hecho desde el
    // menú contaba como progreso.
    expect(isStuckCustomer({ messages: 40, menusSent: 5, hasProgress: true })).toBe(false);
  });

  it('sin menú recibido no está atascado: está empezando', () => {
    // Sin la herramienta en la mano no se le puede reprochar no usarla, y
    // avisar aquí sería avisar por cada conversación que arranca.
    expect(isStuckCustomer({ ...ATASCADO, menusSent: 0 })).toBe(false);
  });

  it('el orden importa: el progreso manda sobre todo lo demás', () => {
    expect(isStuckCustomer({ messages: 99, menusSent: 9, hasProgress: true })).toBe(false);
  });
});

describe('isStuckCustomer — el flujo REAL que disparó una alerta falsa', () => {
  it('un pedido que llega a pagarse NO es un atasco', () => {
    // 29-08-2026, 03:24. "Hola don Zarco quiero pedir", "2 lomitos quería",
    // "Si envíeme 2 lomitos", ubicación, ubicación, comprobante. Seis
    // mensajes, menú enviado tres veces, pedido #1 creado y pagado.
    expect(isStuckCustomer({ messages: 6, menusSent: 3, hasProgress: true })).toBe(false);
  });

  it('y aunque el progreso no constara, seis mensajes ya no bastan', () => {
    // Defensa en profundidad: el umbral deja margen por encima de lo que gasta
    // un pedido normal, para que un fallo del cruce no vuelva a ser una alerta.
    expect(isStuckCustomer({ messages: 6, menusSent: 3, hasProgress: false })).toBe(false);
    expect(isStuckCustomer({ messages: 7, menusSent: 3, hasProgress: false })).toBe(false);
  });
});

describe('stuck-customer — los umbrales dicen algo, no son números sueltos', () => {
  it('el umbral deja margen sobre un pedido completo', () => {
    // Un pedido normal gasta seis o siete mensajes. Si alguien baja esto a esa
    // altura, vuelve la alerta por cada venta.
    expect(STUCK_CUSTOMER_MESSAGES).toBeGreaterThan(7);
  });

  it('la ventana cubre una conversación, no una jornada', () => {
    // Si fuera de horas, dos conversaciones distintas del mismo cliente se
    // sumarían y el "atasco" sería en realidad un buen día.
    expect(STUCK_WINDOW_MINUTES).toBeLessThanOrEqual(45);
    expect(STUCK_WINDOW_MINUTES).toBeGreaterThanOrEqual(15);
  });
});
