import { describe, it, expect } from 'vitest';
import { isExplicitHumanRequest } from './explicit-request';

describe('isExplicitHumanRequest — quien pide una persona no espera turno', () => {
  it('las formas en que la gente lo pide de verdad', () => {
    for (const texto of [
      'quiero hablar con una persona',
      'Quiero hablar con alguien',
      'pasame con un humano',
      'páseme con el encargado',
      'necesito hablar con el dueño',
      'me pueden comunicar con alguien',
      'quiero hablar con atencion al cliente',
      'atención humana por favor',
      'quiero un agente humano',
      'me atiende alguien?',
      'QUIERO HABLAR CON UNA PERSONA',
    ]) {
      expect(isExplicitHumanRequest(texto), texto).toBe(true);
    }
  });
});

describe('isExplicitHumanRequest — hacen falta las DOS familias', () => {
  it('nombrar a una persona no es pedirla', () => {
    // El falso positivo que más daño haría: derivar a alguien que solo estaba
    // contando algo. Sin verbo de contacto, no hay petición.
    for (const texto of [
      'una persona me dijo que tenian promo',
      'somos dos personas',
      'para cuantas personas alcanza?',
      'el encargado del edificio me abre la puerta',
      'mi hermana quiere pedir tambien',
    ]) {
      expect(isExplicitHumanRequest(texto), texto).toBe(false);
    }
  });

  it('querer hablar no es querer hablar con ALGUIEN', () => {
    for (const texto of [
      'quiero hablar de mi pedido',
      'hablamos mañana',
      'pasame el menu',
      'me pasas la ubicacion?',
    ]) {
      expect(isExplicitHumanRequest(texto), texto).toBe(false);
    }
  });

  it('el repartidor NO cuenta', () => {
    // "Quiero hablar con el repartidor" es una petición sobre un pedido en
    // curso, no sobre esta conversación: derivarla al WhatsApp del negocio no
    // le sirve a nadie, y encima calla al agente dos horas.
    expect(isExplicitHumanRequest('quiero hablar con el repartidor')).toBe(false);
    expect(isExplicitHumanRequest('me pasas con el motoquero?')).toBe(false);
  });

  it('una conversación normal no la activa', () => {
    for (const texto of [
      'hola',
      'quiero pedir 2 trancapechos',
      'cuanto sale el envio',
      'gracias!',
      '',
      '   ',
    ]) {
      expect(isExplicitHumanRequest(texto), texto).toBe(false);
    }
  });

  it('no revienta con basura', () => {
    expect(isExplicitHumanRequest(null)).toBe(false);
    expect(isExplicitHumanRequest(undefined)).toBe(false);
    expect(isExplicitHumanRequest(42 as unknown as string)).toBe(false);
  });
});
