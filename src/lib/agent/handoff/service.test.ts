import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * DERIVAR ES CALLARSE, NO ANUNCIARLO.
 *
 * Este archivo cubre la regresión de la primera prueba real: el agente le
 * escribía al cliente "Esto lo tiene que ver una persona del equipo" y acto
 * seguido enmudecía dos horas. El acuse es una promesa de atención que puede no
 * cumplirse esa noche, y a quien se le anuncia una respuesta que no llega se
 * siente ignorado — más que si el bot simplemente hubiera dejado de contestar.
 *
 * Lo que sale al derivar es la alerta a Telegram. Nada más.
 */

interface PausaFalsa {
  result: 'ok' | 'rejected';
  pause?: 'applied' | 'already_applied';
}

let PAUSA: PausaFalsa = { result: 'ok', pause: 'applied' };
const PAUSAS: unknown[] = [];
const AVISOS: unknown[] = [];
/** Orden real de los efectos, para probar que la pausa va PRIMERO. */
const ORDEN: string[] = [];

/**
 * Mensajes del cliente que devuelve el conteo de la puerta. `null` = la
 * consulta falla, que es un caso con su propia conducta esperada.
 */
let MENSAJES: number | null = 10;

/**
 * Supabase de mentira, encadenable.
 *
 * Cubre las dos consultas de la puerta: buscar la conversación por teléfono y
 * contar sus mensajes de cliente. Cada método devuelve el mismo objeto, y el
 * objeto es "thenable" para poder esperarlo al final de la cadena.
 */
function fakeSupabase() {
  const builder: Record<string, unknown> = {};
  const encadenar = () => builder;
  for (const m of ['select', 'eq', 'gte', 'order', 'limit', 'in', 'not']) {
    builder[m] = encadenar;
  }
  builder.maybeSingle = async () =>
    MENSAJES === null ? { data: null, error: new Error('supabase caído') } : { data: { id: 'conv-1' }, error: null };
  builder.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(
      MENSAJES === null ? { count: null, error: new Error('supabase caído') } : { count: MENSAJES, error: null },
    ).then(resolve);
  return { from: () => builder };
}

vi.mock('@/lib/supabase/server', () => ({ getSupabaseAdmin: () => fakeSupabase() }));
vi.mock('../memory/repository', () => ({ createAgentStore: () => ({}) }));

vi.mock('../control/handoff-pause', () => ({
  pauseAgentForHandoff: async (input: unknown) => {
    PAUSAS.push(input);
    ORDEN.push('pausa');
    return { ...PAUSA, conversationId: 'conv-1', pauseExpiresAt: '2026-08-15T14:00:00.000Z' };
  },
}));

vi.mock('@/lib/alerts/handoff-notice-service', () => ({
  notifyHandoff: async (input: unknown) => {
    AVISOS.push(input);
    ORDEN.push('aviso');
  },
}));

// Trampa: si alguien reintrodujera el acuse por aquí, el test lo vería reventar
// en vez de pasar en verde con un mensaje de más en el WhatsApp de alguien.
vi.mock('@/lib/kapso/client', () => ({
  getKapsoClient: () => {
    throw new Error('derivar no manda mensajes al cliente');
  },
}));

const { createHandoffPort, HANDOFF_PAUSE_MINUTES } = await import('./service');

const entrada = {
  customerPhone: '59171234567',
  sourceMessageId: 'wamid.ABC',
  inboundText: 'pagué hace una hora y no me llega nada',
};

beforeEach(() => {
  // Por defecto, conversación de sobra: los tests que no hablan de la puerta
  // no deberían tener que pensar en ella.
  MENSAJES = 10;
  PAUSA = { result: 'ok', pause: 'applied' };
  PAUSAS.length = 0;
  AVISOS.length = 0;
  ORDEN.length = 0;
});

describe('handoff — derivar pausa y avisa, y no le dice nada al cliente', () => {
  it('no manda ningún mensaje: el cliente se queda en silencio', async () => {
    const res = await createHandoffPort().escalate(entrada);

    // Si hubiera envío, el doble de Kapso habría lanzado y esto no llegaría.
    expect(res).toEqual({ handed: true });
    expect(ORDEN).toEqual(['pausa', 'aviso']);
  });

  it('el fuente no conserva ni el transporte ni el texto del acuse', async () => {
    // La trampa de arriba solo cubre este camino. Esto cubre el módulo entero:
    // ni import de Kapso, ni constante con la frase, ni sendText en ninguna rama.
    const fuente = readFileSync(new URL('./service.ts', import.meta.url), 'utf8');

    expect(fuente).not.toMatch(/getKapsoClient/);
    expect(fuente).not.toMatch(/sendText/);
    expect(fuente).not.toMatch(/HANDOFF_ACK_TEXT/);
  });

  it('pausa ANTES de avisar: si algo falla, el agente ya está callado', async () => {
    await createHandoffPort().escalate(entrada);

    expect(ORDEN.indexOf('pausa')).toBeLessThan(ORDEN.indexOf('aviso'));
    expect(PAUSAS[0]).toMatchObject({
      customerPhone: entrada.customerPhone,
      reason: 'handoff_requested',
      source: 'system',
      sourceMessageId: entrada.sourceMessageId,
      minutes: HANDOFF_PAUSE_MINUTES,
      trigger: 'agent_action',
    });
  });

  it('el aviso al equipo lleva lo que escribió el cliente', async () => {
    await createHandoffPort().escalate(entrada);

    expect(AVISOS).toEqual([
      {
        customerPhone: entrada.customerPhone,
        reason: 'handoff_requested',
        lastMessage: entrada.inboundText,
      },
    ]);
  });

  it('el mismo mensaje no despierta a nadie dos veces', async () => {
    // Una reentrega de Kapso encuentra la pausa ya aplicada por ese WAMID. Para
    // el cliente la derivación ocurrió, así que el turno cierra igual — pero el
    // grupo de Telegram no se entera otra vez.
    PAUSA = { result: 'ok', pause: 'already_applied' };

    const res = await createHandoffPort().escalate(entrada);

    expect(res).toEqual({ handed: true });
    expect(AVISOS).toEqual([]);
  });

  it('si ni la pausa se pudo escribir, la derivación NO ocurrió', async () => {
    // Y hay que decirlo: con `handed: false` el turno sigue hasta redactar y el
    // cliente recibe una respuesta. Es lo correcto — nadie le está atendiendo
    // por otro lado, así que el silencio aquí no tendría nada detrás.
    PAUSA = { result: 'rejected' };

    const res = await createHandoffPort().escalate(entrada);

    expect(res).toEqual({ handed: false });
    expect(AVISOS).toEqual([]);
  });

  it('calla dos horas, lo mismo que el detector de menús', async () => {
    expect(HANDOFF_PAUSE_MINUTES).toBe(120);
  });
});

describe('handoff — la puerta: derivar exige un MOTIVO', () => {
  it('sin motivo NO deriva, por larga que sea la conversación', async () => {
    // La forma de las 29 alarmas falsas del 04-09-2026: mensajes sin nada que
    // una persona pueda arreglar, de clientes que ya llevaban rato escribiendo.
    // El cliente no se queda sin respuesta —`handed: false` deja el turno vivo
    // y el modelo redacta—; lo que no ocurre es la derivación.
    MENSAJES = 10;

    for (const texto of ['😓', '?', 'Okay', 'Efectivo', 'Estoy viendo su live']) {
      const res = await createHandoffPort().escalate({ ...entrada, inboundText: texto });
      expect(res, texto).toEqual({ handed: false });
    }
    expect(PAUSAS).toEqual([]);
    expect(AVISOS).toEqual([]);
  });

  it('un problema real deriva en el PRIMER mensaje', async () => {
    // Lo que el umbral viejo hacía esperar hasta el cuarto.
    MENSAJES = 1;

    const res = await createHandoffPort().escalate({
      ...entrada,
      inboundText: 'me cobraron de mas',
    });

    expect(res).toEqual({ handed: true });
    expect(PAUSAS).toHaveLength(1);
    expect(AVISOS).toHaveLength(1);
  });

  it('quien pide una persona con todas las letras cruza igual', async () => {
    MENSAJES = 1;

    const res = await createHandoffPort().escalate({
      ...entrada,
      inboundText: 'quiero hablar con una persona',
    });

    expect(res).toEqual({ handed: true });
    expect(PAUSAS).toHaveLength(1);
  });

  it('ya no depende de la base: deriva aunque no se pueda consultar nada', async () => {
    // La puerta se decide con el mensaje delante. Un Supabase caído ya no puede
    // impedir que llegue a una persona quien dice que le cobraron de más.
    MENSAJES = null;

    const res = await createHandoffPort().escalate({
      ...entrada,
      inboundText: 'esto es una estafa, devuelvan mi plata',
    });

    expect(res).toEqual({ handed: true });
  });

  it('y tampoco puede hacer que derive quien no tenía motivo', async () => {
    MENSAJES = null;

    expect(
      await createHandoffPort().escalate({ ...entrada, inboundText: 'okay gracias' }),
    ).toEqual({ handed: false });
    expect(PAUSAS).toEqual([]);
  });
});
