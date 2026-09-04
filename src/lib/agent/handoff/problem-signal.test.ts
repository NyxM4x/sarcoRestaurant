import { describe, expect, it } from 'vitest';
import { hasProblemSignal } from './problem-signal';

/**
 * LAS 29 ALARMAS FALSAS DE VERDAD (04-09-2026).
 *
 * Son los mensajes que dispararon las últimas 29 derivaciones reales antes de
 * invertir la puerta. Ninguno puede volver a hacerlo: cada uno costó dos horas
 * de bot callado y una alarma al equipo.
 */
const LAS_29_REALES = [
  '😓',
  '🫠🫠🫠',
  '😫',
  '?',
  '???',
  '.',
  'Okay',
  'Si señor',
  'Si porfa',
  'disculpe',
  'Por favor',
  'Va disculpar',
  'Efectivo',
  'Se puede?',
  'Cuánto dera',
  'Me cotiza Aver',
  '30 ? Mioj',
  'Estoy viendo su live',
  'Adjunto comprobante electrónico',
  'Ta en caminon',
  'Le pago páseme su qr',
  'Me confirmas por favor',
  'Puedo aumentar',
  'Dn zarco en q tiempo podría pasar mi moto por el pedido',
  'Ta en camino',
  'Allá canceló',
  'Me confirmas',
  'disculpe por si acaso cuanto tiempo tardará pa tar atento',
  'Adjunto comprobante',
];

describe('ninguna de las 29 vuelve a sonar', () => {
  for (const mensaje of LAS_29_REALES) {
    it(`"${mensaje}" no deriva`, () => {
      expect(hasProblemSignal(mensaje)).toBe(false);
    });
  }
});

describe('lo que SÍ necesita una persona', () => {
  it('dinero: el bloque que no se puede fallar', () => {
    expect(hasProblemSignal('me cobraron de mas')).toBe(true);
    expect(hasProblemSignal('pague dos veces')).toBe(true);
    expect(hasProblemSignal('esto es una estafa')).toBe(true);
    expect(hasProblemSignal('quiero mi reembolso')).toBe(true);
    expect(hasProblemSignal('devuelvan mi plata')).toBe(true);
    expect(hasProblemSignal('me robaron')).toBe(true);
  });

  it('el pedido llegó mal, o no llegó', () => {
    expect(hasProblemSignal('me llego frio')).toBe(true);
    expect(hasProblemSignal('la hamburguesa esta cruda')).toBe(true);
    expect(hasProblemSignal('no me llego el pedido')).toBe(true);
    expect(hasProblemSignal('nunca llego')).toBe(true);
    expect(hasProblemSignal('no es lo que pedi')).toBe(true);
    expect(hasProblemSignal('vino incompleto')).toBe(true);
  });

  it('queja o enfado con todas las letras', () => {
    expect(hasProblemSignal('quiero poner un reclamo')).toBe(true);
    expect(hasProblemSignal('pesimo servicio')).toBe(true);
    expect(hasProblemSignal('voy a denunciar')).toBe(true);
    expect(hasProblemSignal('nadie me responde')).toBe(true);
    expect(hasProblemSignal('esto es una verguenza')).toBe(true);
  });
});

describe('la impaciencia no es un problema', () => {
  it('preguntar por el tiempo lo contesta el bot', () => {
    // Meter esto devolvería la mitad de las alarmas falsas por la puerta de
    // atrás: es lo más frecuente que escribe alguien esperando su pedido.
    expect(hasProblemSignal('cuanto tarda')).toBe(false);
    expect(hasProblemSignal('demora mucho?')).toBe(false);
    expect(hasProblemSignal('en cuanto tiempo llega')).toBe(false);
    expect(hasProblemSignal('ya va a llegar?')).toBe(false);
  });

  it('"me equivoqué" tiene su propio camino: rearmar el pedido', () => {
    expect(hasProblemSignal('me equivoque')).toBe(false);
    expect(hasProblemSignal('me equivoque en mi pedido')).toBe(false);
  });

  it('sin texto no hay evidencia', () => {
    expect(hasProblemSignal(null)).toBe(false);
    expect(hasProblemSignal('')).toBe(false);
    expect(hasProblemSignal('   ')).toBe(false);
  });
});
