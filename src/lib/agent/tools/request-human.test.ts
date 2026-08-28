import { describe, it, expect } from 'vitest';
import { createRequestHumanAction, REQUEST_HUMAN, type HandoffPort } from './request-human';
import { executeToolCall } from './registry';

const contexto = {
  customerPhone: '59171234567',
  sourceMessageId: 'wamid.ABC',
  phoneNumberId: 'pnid-1',
  inboundText: 'pagué y no me llega nada',
};

function puerto(handed: boolean, capturado: unknown[] = []): HandoffPort {
  return {
    async escalate(input) {
      capturado.push(input);
      return { handed };
    },
  };
}

describe('request_human — el contrato con el núcleo', () => {
  it('declara que produce un efecto visible y que CIERRA el turno', () => {
    // Las dos banderas juntas son el diseño, no un detalle: la acción pausa la
    // conversación, así que si el turno siguiera hasta la ronda de redacción, la
    // barrera pre-send encontraría la pausa activa y el cliente se quedaría sin
    // recibir NADA — callado por el mismo mecanismo que pidió ayuda para él.
    const tool = createRequestHumanAction(puerto(true));
    expect(tool.producesUserVisibleEffect).toBe(true);
    expect(tool.effectCompletesTurn).toBe(true);
  });

  it('no admite argumentos: el modelo no elige el motivo ni el texto', async () => {
    const tool = createRequestHumanAction(puerto(true));
    expect(tool.definition.parameters).toEqual({
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    });

    const res = await executeToolCall(
      { callId: 'c1', name: REQUEST_HUMAN, arguments: '{"reason":"queja"}' },
      [tool],
      contexto,
    );
    expect(res.ok).toBe(false);
    expect(res.output).toContain('invalid_arguments');
  });

  it('la descripción distingue derivar de lo que el agente SÍ puede resolver', () => {
    // Sin esto, "cuánto cuesta el trancapecho" acabaría despertando a alguien.
    const d = createRequestHumanAction(puerto(true)).definition.description;
    expect(d).toContain('queja');
    expect(d).toContain('get_menu_items');
    expect(d).toContain('answer_directly');
  });
});

describe('request_human — qué pasa al ejecutarla', () => {
  it('pasa al puerto lo que escribió el cliente, para el aviso del equipo', async () => {
    const capturado: unknown[] = [];
    const tool = createRequestHumanAction(puerto(true, capturado));
    await tool.execute!(contexto);
    expect(capturado).toEqual([contexto]);
  });

  it('derivado con éxito → el turno cierra en silencio', async () => {
    const tool = createRequestHumanAction(puerto(true));
    const res = await tool.execute!(contexto);
    expect(res).toEqual({ result: { handed: true }, userVisibleEffectConfirmed: true });
  });

  it('si no se pudo avisar al cliente, el turno NO cierra en falso', async () => {
    // El equipo ya fue alertado por su lado. Cerrar como éxito dejaría al
    // cliente sin nada y sin rastro de que faltó algo.
    const tool = createRequestHumanAction(puerto(false));
    const res = await tool.execute!(contexto);
    expect(res).toEqual({ result: { handed: false }, userVisibleEffectConfirmed: false });
  });

  it('un puerto que revienta no tumba el turno', async () => {
    // Una alucinación del modelo o una caída de Supabase no pueden convertirse
    // en un 500 del webhook que atiende a todos los clientes.
    const explota: HandoffPort = {
      async escalate() {
        throw new Error('supabase caído');
      },
    };
    const res = await executeToolCall(
      { callId: 'c1', name: REQUEST_HUMAN, arguments: '{}' },
      [createRequestHumanAction(explota)],
      contexto,
    );
    expect(res.ok).toBe(false);
    expect(res.userVisibleEffectConfirmed).toBe(false);
    expect(res.output).toContain('tool_failed');
  });
});
