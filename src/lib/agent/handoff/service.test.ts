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

vi.mock('@/lib/supabase/server', () => ({ getSupabaseAdmin: () => ({}) }));
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
