import { describe, expect, it } from 'vitest';
import { readOrderReviewReply } from './order-review-reply';

/**
 * LA RESPUESTA A "¿QUERÉS AGREGAR ALGO MÁS?" (05-09-2026).
 *
 * Lo que se prueba aquí es que una respuesta corta signifique una sola cosa. El
 * cliente del pedido #26 contestaba "No", "??", "Xfa": si esas tres se leyeran
 * igual, la pregunta sería peor que no preguntar.
 */
describe('readOrderReviewReply', () => {
  it('el número contesta sin ambigüedad, que es para lo que está', () => {
    expect(readOrderReviewReply('1')).toBe('add');
    expect(readOrderReviewReply('2')).toBe('keep');
  });

  it('"no" significa "así está bien", por cómo se preguntó', () => {
    // La pregunta es "¿querés agregar algo más?". Con "¿está bien tu pedido?"
    // este mismo "no" significaría lo contrario — y por eso la pregunta no se
    // puede reescribir sin volver al detector.
    expect(readOrderReviewReply('no')).toBe('keep');
    expect(readOrderReviewReply('No')).toBe('keep');
    expect(readOrderReviewReply('nada más')).toBe('keep');
    expect(readOrderReviewReply('así está bien')).toBe('keep');
    expect(readOrderReviewReply('listo')).toBe('keep');
  });

  it('"sí" y sus formas piden el botón', () => {
    for (const frase of ['si', 'sí', 'siii', 'claro', 'dale', 'quiero agregar', 'me falta']) {
      expect(readOrderReviewReply(frase), frase).toBe('add');
    }
  });

  it('la cortesía del final no cambia el sentido', () => {
    expect(readOrderReviewReply('si porfa')).toBe('add');
    expect(readOrderReviewReply('no gracias')).toBe('keep');
    expect(readOrderReviewReply('2 xfa')).toBe('keep');
    expect(readOrderReviewReply('listo, gracias')).toBe('keep');
  });

  it('lo que NO contesta a esto se deja pasar', () => {
    // `null` no es un error: es "esto era otra cosa". Ese mensaje sigue su
    // camino y, sobre todo, NO se le repregunta.
    for (const frase of ['??', 'xfa', 'cuanto tarda', 'ya pague', 'hola', 'gracias']) {
      expect(readOrderReviewReply(frase), frase).toBeNull();
    }
  });

  it('una frase que EMPIEZA por no, pero dice otra cosa, no es una respuesta', () => {
    // Se compara la frase entera. Buscando dentro, "no me llegó el QR" sería un
    // "así está bien" y le cerraríamos el pedido a quien pedía ayuda.
    expect(readOrderReviewReply('no me llegó el QR')).toBeNull();
    expect(readOrderReviewReply('no puedo pagar')).toBeNull();
    expect(readOrderReviewReply('si me llega a tiempo?')).toBeNull();
  });

  it('un pedido dentro de la respuesta no lo decide esto', () => {
    // "Sí, una gaseosa" lo atiende el detector de cambios, que sabe leer el
    // producto. Aquí solo se contesta a la pregunta.
    expect(readOrderReviewReply('si, una gaseosa')).toBeNull();
  });

  it('sin texto no hay respuesta', () => {
    expect(readOrderReviewReply(null)).toBeNull();
    expect(readOrderReviewReply(undefined)).toBeNull();
    expect(readOrderReviewReply('')).toBeNull();
    expect(readOrderReviewReply('   ')).toBeNull();
  });
});
