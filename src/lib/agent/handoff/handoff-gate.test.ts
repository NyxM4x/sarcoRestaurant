import { describe, expect, it } from 'vitest';
import { canHandOff } from './handoff-gate';

/**
 * LA PUERTA INVERTIDA (04-09-2026).
 *
 * Ya no cuenta conversación: exige un motivo en el mensaje. Las 29 derivaciones
 * reales que lo motivaron viven en `problem-signal.test.ts`.
 */
describe('canHandOff — hace falta un motivo', () => {
  it('sin motivo no se deriva, por larga que sea la conversación', () => {
    expect(canHandOff({ explicitRequest: false, problemSignal: false })).toBe(false);
  });

  it('pedir una persona con todas las letras abre la puerta sola', () => {
    expect(canHandOff({ explicitRequest: true, problemSignal: false })).toBe(true);
  });

  it('un problema que solo una persona arregla, también', () => {
    // Y desde el primer mensaje: el umbral viejo hacía esperar a "me llegó
    // frío" hasta el cuarto, y eso estaba anotado como su coste.
    expect(canHandOff({ explicitRequest: false, problemSignal: true })).toBe(true);
  });

  it('las dos cosas a la vez no son un caso especial', () => {
    expect(canHandOff({ explicitRequest: true, problemSignal: true })).toBe(true);
  });
});
