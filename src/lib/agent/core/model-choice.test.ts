import { describe, it, expect } from 'vitest';
import { pickTurnModel, turnHasImage } from './model-choice';

const TEXTO = 'gpt-4o-mini';
const VISION = 'gpt-5-mini';

describe('qué modelo atiende el turno', () => {
  it('sin foto va el barato de texto', () => {
    expect(pickTurnModel({ hasImage: false, textModel: TEXTO, visionModel: VISION })).toBe(TEXTO);
  });

  it('con foto va el barato de imagen', () => {
    // Es donde está el dinero: la misma foto cuesta ~48.000 tokens en
    // `gpt-4o-mini` y ~3.000 en `gpt-5-mini`.
    expect(pickTurnModel({ hasImage: true, textModel: TEXTO, visionModel: VISION })).toBe(VISION);
  });

  it('sin modelo de visión configurado, NADA cambia', () => {
    // El comportamiento por omisión tiene que ser el de antes de que existiera
    // esta regla: una optimización de coste no puede cambiar a qué modelo habla
    // el negocio sin que alguien lo escriba.
    for (const v of [undefined, null, '', '   ']) {
      expect(pickTurnModel({ hasImage: true, textModel: TEXTO, visionModel: v }), String(v)).toBe(
        TEXTO,
      );
    }
  });
});

describe('detectar la foto del turno', () => {
  it('reconoce el turno con imagen y el de solo texto', () => {
    expect(turnHasImage([{ image: null }, { image: { facts: {} } }])).toBe(true);
    expect(turnHasImage([{ image: null }, { image: null }])).toBe(false);
  });

  it('un turno vacío o ausente es de texto', () => {
    expect(turnHasImage([])).toBe(false);
    expect(turnHasImage(undefined)).toBe(false);
  });

  it('un comprobante RETENIDO por la puerta se cobra como texto', () => {
    // La puerta de comprobantes retira los bytes del adjunto no autorizado, así
    // que llega sin `image`. Ese turno no va a mirar ninguna foto, y pagar el
    // modelo de imagen por una foto que nadie mira sería pagar por nada.
    expect(turnHasImage([{ image: null }])).toBe(false);
    expect(turnHasImage([{}])).toBe(false);
  });
});
