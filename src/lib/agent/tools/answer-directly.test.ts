import { describe, it, expect } from 'vitest';
import { ANSWER_DIRECTLY, createAnswerDirectlyAction } from './answer-directly';
import { executeToolCall, NO_ARGUMENTS } from './registry';

/**
 * La acción de NO actuar (Fase 6D.2F.5B.1).
 *
 * Lo que importa de ella es lo que NO tiene: no ejecuta, no recibe argumentos y
 * no produce ningún efecto. Su valor entero está en existir — en que "contestar
 * hablando" sea una decisión con nombre y no el hueco por el que se cae el turno.
 */

const CTX = {
  customerPhone: '59162139119',
  sourceMessageId: 'wamid.IN_1',
  phoneNumberId: 'pnid-1',
  inboundText: 'hasta qué hora atienden?',
};

describe('answer_directly — una decisión, no una herramienta', () => {
  it('no ejecuta nada: no tiene `execute`', () => {
    expect(createAnswerDirectlyAction().execute).toBeUndefined();
  });

  it('no declara efecto visible ni cierre de turno', () => {
    const action = createAnswerDirectlyAction();

    expect(action.producesUserVisibleEffect).toBeUndefined();
    expect(action.effectCompletesTurn).toBeUndefined();
  });

  it('no recibe argumentos: no hay nada que el modelo pueda escribirle', () => {
    expect(createAnswerDirectlyAction().definition.parameters).toEqual(NO_ARGUMENTS);
  });

  it('su descripción cierra la puerta de escape del menú', () => {
    // Es lo ÚNICO que el modelo lee para saber cuándo usarla, así que tiene que
    // decir para qué NO sirve: no es el atajo para no mandar el menú.
    const { description } = createAnswerDirectlyAction().definition;

    expect(description).toContain('send_menu');
    expect(description).toContain('get_menu_items');
  });

  it('el nombre es estable: la observabilidad y el registro cuelgan de él', () => {
    expect(ANSWER_DIRECTLY).toBe('answer_directly');
    expect(createAnswerDirectlyAction().definition.name).toBe(ANSWER_DIRECTLY);
  });

  it('si alguien la ejecutara igualmente, falla legible y sin efecto', () => {
    // El core no llega aquí —resuelve antes que no hay nada que ejecutar— pero
    // un `tool.execute is not a function` sería un 500 del webhook.
    return executeToolCall(
      { callId: 'c1', name: ANSWER_DIRECTLY, arguments: '{}' },
      [createAnswerDirectlyAction()],
      CTX,
    ).then((executed) => {
      expect(executed.ok).toBe(false);
      expect(JSON.parse(executed.output)).toEqual({ error: 'not_executable' });
      expect(executed.userVisibleEffectConfirmed).toBe(false);
    });
  });
});
