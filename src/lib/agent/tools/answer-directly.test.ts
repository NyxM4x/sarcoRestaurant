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

describe('answer_directly — el catálogo no puede dejar preguntas sin puerta', () => {
  /**
   * Regresión del 29-08-2026. La descripción excluía "un precio" a secas, el
   * envío no es un producto que `get_menu_items` pueda buscar, y con
   * `toolChoice: 'required'` el modelo tiene que elegir SIEMPRE algo: la única
   * casilla libre ante "cuánto me saldría el delivery" era `request_human`.
   * Dos horas de silencio por preguntar cuánto cuesta que te lo lleven.
   */
  const descripcion = () => createAnswerDirectlyAction().definition.description;

  it('la exclusión de precios se limita a los PRODUCTOS del menú', () => {
    expect(descripcion()).toMatch(/PRODUCTO del menú/);
    // "un precio" a secas es lo que cerraba la puerta.
    expect(descripcion()).not.toMatch(/de memoria un precio/);
  });

  it('nombra el costo del envío como algo que SÍ se contesta hablando', () => {
    const d = descripcion();
    expect(d).toMatch(/env[íi]o|delivery/i);
    expect(d).toMatch(/ubicaci[óo]n/i);
  });
});
