import { describe, it, expect } from 'vitest';
import { isDeliveryQuoteIntent } from './delivery-quote-intent';

/**
 * Estos casos VIVÍAN en el eval contra el modelo real, y el modelo los fallaba:
 * `request_human` 3 de 3 veces, medido dos veces con dos redacciones distintas
 * del prompt. Al dejar de ser una decisión suya y pasar a ser un reconocimiento
 * determinista, se vuelven comprobables aquí — gratis, siempre, y sin que el
 * resultado dependa de cómo amaneció el modelo.
 */

describe('isDeliveryQuoteIntent — reconoce la pregunta por el precio del envío', () => {
  it('el mensaje REAL que derivó una conversación entera', () => {
    // 29-08-2026, 01:04. Primer mensaje de la conversación. El agente lo mandó
    // a una persona y dejó al cliente dos horas sin respuesta.
    expect(isDeliveryQuoteIntent('hola como esta zarco cuanto me saldria delivery aqui')).toBe(
      true,
    );
  });

  it('las formas en que la gente lo pregunta de verdad', () => {
    for (const texto of [
      'cuanto sale el envio?',
      '¿Cuánto cuesta el delivery?',
      'cuanto me cobran por el delivery hasta el 5to anillo?',
      'y cuanto sale que me lo traigan',
      'en cuanto me sale que me lo manden a mi casa',
      'cuanto vale el envio a santos dumont',
      'precio del delivery?',
      'que costo tiene el envio',
      'cuanto cobran por llevarlo',
      'cual es la tarifa de envio',
      'CUANTO SALE EL ENVIO',
      'cuanto sale el envío',
    ]) {
      expect(isDeliveryQuoteIntent(texto), texto).toBe(true);
    }
  });
});

describe('isDeliveryQuoteIntent — hacen falta las DOS familias de palabras', () => {
  it('un precio sin envío no es esto: eso es el menú', () => {
    // La defensa principal contra el falso positivo. Si `cuanto` bastara, toda
    // pregunta de precio acabaría pidiendo la ubicación en vez de contestarse.
    for (const texto of [
      'cuanto cuesta el trancapecho?',
      'cuanto salen la salchipapa y el lomito',
      'cuanto vale la coca de dos litros',
      'que precio tiene la hamburguesa doble',
    ]) {
      expect(isDeliveryQuoteIntent(texto), texto).toBe(false);
    }
  });

  it('un envío sin precio tampoco: eso lo contesta el agente', () => {
    for (const texto of [
      'hacen delivery?',
      'me lo pueden mandar a mi casa?',
      'tienen envio a domicilio',
      'me lo traen hasta la puerta?',
      'mandenme el menu por favor',
    ]) {
      expect(isDeliveryQuoteIntent(texto), texto).toBe(false);
    }
  });

  it('"moto" queda fuera a propósito', () => {
    // "¿Tienen motos para enviar?" es una pregunta sobre el servicio, no sobre
    // su precio. Con `cuanto` cerca por otra razón se colaría sin querer.
    expect(isDeliveryQuoteIntent('me puede enviar en moto tiene motos pa enviar?')).toBe(false);
  });

  it('no confunde una conversación normal', () => {
    for (const texto of [
      'hola',
      'gracias!',
      'quiero pedir',
      'que tienen para comer',
      'estan abiertos?',
      '',
      '   ',
    ]) {
      expect(isDeliveryQuoteIntent(texto), texto).toBe(false);
    }
  });

  it('no revienta con basura', () => {
    expect(isDeliveryQuoteIntent(null)).toBe(false);
    expect(isDeliveryQuoteIntent(undefined)).toBe(false);
    expect(isDeliveryQuoteIntent(12345 as unknown as string)).toBe(false);
  });
});

describe('isDeliveryQuoteIntent — señalar un lugar junto a un precio', () => {
  it('"Aquí cuánto cobra" — el mensaje que derivó una conversación', () => {
    // 29-08-2026, 02:39. Venía justo después de un link de Google Maps: el
    // cliente creía que ya había dicho dónde estaba. Hay palabra de coste pero
    // ninguna de envío, así que caía al modelo, y el modelo llamó al equipo.
    expect(isDeliveryQuoteIntent('Aquí cuánto cobra')).toBe(true);
  });

  it('las otras formas de señalar el sitio sin nombrar el envío', () => {
    for (const texto of [
      'cuanto cobran hasta aqui',
      'cuanto me sale a mi casa',
      'que precio a esta direccion',
      'cuanto cuesta a mi ubicacion',
      'aca cuanto seria',
    ]) {
      expect(isDeliveryQuoteIntent(texto), texto).toBe(true);
    }
  });

  it('un producto preguntado normalmente sigue sin activarlo', () => {
    // La deixis es lo que separa las dos preguntas: nadie pregunta el precio de
    // una hamburguesa diciendo "aquí".
    for (const texto of [
      'cuanto cuesta el trancapecho?',
      'que precio tiene la coca de dos litros',
      'cuanto vale la salchipapa',
    ]) {
      expect(isDeliveryQuoteIntent(texto), texto).toBe(false);
    }
  });

  it('un lugar sin precio tampoco: eso es una dirección, no una pregunta', () => {
    for (const texto of [
      'estoy aqui en el 5to anillo',
      'mandenlo a mi casa',
      'aqui te paso la ubicacion',
    ]) {
      expect(isDeliveryQuoteIntent(texto), texto).toBe(false);
    }
  });
});
