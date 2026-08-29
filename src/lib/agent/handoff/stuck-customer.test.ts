import { describe, it, expect } from 'vitest';
import {
  isStuckCustomer,
  STUCK_CUSTOMER_MESSAGES,
  STUCK_WINDOW_MINUTES,
} from './stuck-customer';

/**
 * El cliente que no consigue pedir.
 *
 * Antes se contaban MENÚS enviados (tres en 45 min). El 29-08-2026 se probaron
 * tres conversaciones en las que el cliente se trababa de verdad —preguntando
 * el precio del envío, mandando un link de Google Maps en vez del pin— y en
 * ninguna llegó a pedir el menú tres veces: el detector no habría saltado ni
 * una. El menú era un proxy del esfuerzo del cliente, y uno pobre.
 */

describe('isStuckCustomer — cuándo hay que avisar a una persona', () => {
  it('por debajo del umbral no molesta a nadie', () => {
    expect(isStuckCustomer({ messages: STUCK_CUSTOMER_MESSAGES - 1, hasOrder: false })).toBe(
      false,
    );
  });

  it('en el umbral, avisa', () => {
    expect(isStuckCustomer({ messages: STUCK_CUSTOMER_MESSAGES, hasOrder: false })).toBe(true);
  });

  it('y por encima también', () => {
    expect(isStuckCustomer({ messages: STUCK_CUSTOMER_MESSAGES + 12, hasOrder: false })).toBe(
      true,
    );
  });

  it('un solo pedido lo descarta entero, por muchos mensajes que haya', () => {
    // Quien ya pidió una vez sabe usar el sistema. Si sigue escribiendo es por
    // otra cosa, y confundirlo con un atasco despierta a alguien por un buen
    // cliente — que es la forma más rápida de que dejen de mirar las alertas.
    expect(isStuckCustomer({ messages: 40, hasOrder: true })).toBe(false);
  });

  it('una conversación vacía tampoco es un atasco', () => {
    expect(isStuckCustomer({ messages: 0, hasOrder: false })).toBe(false);
  });
});

describe('stuck-customer — los umbrales dicen algo, no son números sueltos', () => {
  it('el umbral SUBSUME el caso viejo de los tres menús', () => {
    // Tres menús implican al menos tres mensajes del cliente pidiéndolos, así
    // que el detector nuevo no puede exigir menos que aquel o perdería
    // cobertura sin que nadie lo notase.
    expect(STUCK_CUSTOMER_MESSAGES).toBeGreaterThanOrEqual(3);
  });

  it('la ventana cubre una conversación, no una jornada', () => {
    // Media hora: si fuera de horas, dos conversaciones distintas del mismo
    // cliente se sumarían y el "atasco" sería en realidad un buen día.
    expect(STUCK_WINDOW_MINUTES).toBeLessThanOrEqual(45);
    expect(STUCK_WINDOW_MINUTES).toBeGreaterThanOrEqual(15);
  });
});
