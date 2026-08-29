import { describe, it, expect } from 'vitest';
import { createRequestHumanAction, REQUEST_HUMAN, type HandoffPort } from './request-human';
import { executeToolCall } from './registry';

const contexto = {
  customerPhone: '59171234567',
  sourceMessageId: 'wamid.ABC',
  phoneNumberId: 'pnid-1',
  inboundText: 'pagué y no me llega nada',
};

/** Lo que el puerto recibe de verdad: el `phoneNumberId` ya no viaja. */
const loQueRecibeElPuerto = {
  customerPhone: contexto.customerPhone,
  sourceMessageId: contexto.sourceMessageId,
  inboundText: contexto.inboundText,
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
  it('declara que produce un efecto y que CIERRA el turno', () => {
    // Las dos banderas juntas son el diseño, no un detalle. Y siguen valiendo
    // ahora que el cliente no recibe ningún acuse:
    //
    //   · el efecto es SILENCIAR al agente, que es real y no se revisa: por eso
    //     el core comprueba la pausa antes de ejecutar (barrera 2A) y no
    //     re-deriva una conversación que ya atiende una persona;
    //   · y el turno cierra aquí porque, si siguiera a redactar, la barrera
    //     pre-send encontraría la pausa recién puesta y el run moriría en
    //     `skipped_paused` habiendo pagado una llamada más al modelo para nada.
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

  it('la descripción NO le pide al modelo que juzgue al cliente atascado', () => {
    // Es la regresión de esta entrega. La cláusula que había —"cuando lleva
    // varios mensajes trabado sin poder pedir"— derivó una conversación en su
    // primer "hola": el modelo decide sobre una ventana de 12 mensajes que no
    // dice cuánto tiempo pasó entre ellos, así que un saludo nuevo se lee como
    // la continuación de la conversación trabada de ayer.
    //
    // El atasco se CUENTA en `menu-loop.ts` (tres menús en 45 min sin pedido).
    // Aquí solo queda lo que hay que LEER.
    const d = createRequestHumanAction(puerto(true)).definition.description;
    expect(d).not.toContain('trabado');
    expect(d).not.toMatch(/dictar|dictándote/);
    expect(d).toMatch(/varios mensajes cortos/);
    expect(d).toContain('send_menu');
  });

  it('la descripción excluye la pregunta por el costo del envío', () => {
    // El fallo del 29-08-2026: "hola como esta zarco cuanto me saldria delivery
    // aqui" derivó la conversación en su PRIMER mensaje. No había queja ni
    // historial — el modelo se quedó sin puerta y cayó en la única que quedaba.
    // Con `toolChoice: 'required'` esta acción es el desagüe del catálogo si no
    // dice en voz alta lo que no le toca.
    const d = createRequestHumanAction(puerto(true)).definition.description;
    expect(d).toMatch(/env[íi]o o el delivery nunca es motivo para derivar/);
    expect(d).toMatch(/pregunta que no sabes contestar NO se deriva/);
  });
});

describe('request_human — qué pasa al ejecutarla', () => {
  it('pasa al puerto lo que escribió el cliente, para el aviso del equipo', async () => {
    const capturado: unknown[] = [];
    const tool = createRequestHumanAction(puerto(true, capturado));
    await tool.execute!(contexto);
    expect(capturado).toEqual([loQueRecibeElPuerto]);
  });

  it('no le pasa al puerto de dónde salía el mensaje: ya no manda ninguno', async () => {
    // El `phoneNumberId` solo servía para enviar el acuse al cliente. Sin acuse
    // no hace falta, y dejarlo en el contrato invitaría a volver a usarlo.
    const capturado: Record<string, unknown>[] = [];
    const tool = createRequestHumanAction(puerto(true, capturado));
    await tool.execute!(contexto);
    expect(capturado[0]).not.toHaveProperty('phoneNumberId');
  });

  it('derivado con éxito → el turno cierra en silencio', async () => {
    const tool = createRequestHumanAction(puerto(true));
    const res = await tool.execute!(contexto);
    expect(res).toEqual({ result: { handed: true }, userVisibleEffectConfirmed: true });
  });

  it('si la derivación no llegó a ocurrir, el turno NO cierra en falso', async () => {
    // `handed: false` es ahora "no se pudo ni pausar". Cerrar como éxito
    // dejaría al cliente sin respuesta Y sin nadie atendiéndole: el silencio
    // solo se justifica cuando de verdad hay una derivación detrás.
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
