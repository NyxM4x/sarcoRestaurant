import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  acceptKapsoWebhook,
  handleKapsoWebhook,
  processWebhookEvent,
  KAPSO_PAYLOAD_VERSION,
  KAPSO_SUPPORTED_EVENT,
  type AttachOrderLocation,
  type ConfirmOrder,
  type EnsureLocationRequest,
  type HandleKapsoWebhookParams,
  type SendMenuCta,
} from './kapso';
import { FakeWebhookEventStore } from './fake-store';
import {
  dispositionAfterFailure,
  hasAttemptsLeft,
  retryDelayMs,
  WEBHOOK_LEASE_SECONDS,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_RETRY_DELAYS_MS,
} from './inbox';
import {
  handleInboxTick,
  runInboxTick,
  INBOX_TICK_BUDGET,
  INBOX_TICK_WALL_CLOCK_MS,
  type InboxWorkerDeps,
} from './inbox-worker';
import type { AgentChannelPort, AgentTurnResult } from '@/lib/agent/core/types';

/**
 * ACK DURABLE (Fase 6D.2F.5C.1).
 *
 * Lo que se prueba aquí no es "que funcione": es que el ACK NO dependa de lo
 * que tarde el modelo, y que ninguna fila aceptada pueda perderse por el
 * camino. Son las dos promesas que sostienen la fase.
 */

const SECRET = 'test-webhook-secret';

function sign(rawBody: string): string {
  return createHmac('sha256', SECRET).update(rawBody, 'utf8').digest('hex');
}

function textMessage(id = 'wamid.TEXT_1') {
  return {
    id,
    type: 'text',
    from: '59170000000',
    // NO un saludo: desde 03-09-2026 un saludo pelado lo atiende el CTA
    // determinista, y estos casos son sobre el transporte durable, no sobre el
    // menú. Un texto neutro los deja probando lo que vinieron a probar.
    text: { body: 'gracias' },
    kapso: { direction: 'inbound', origin: 'cloud_api', status: 'received' },
  };
}

function humanOutboundMessage(id = 'wamid.HUMAN_1') {
  return {
    id,
    type: 'text',
    from: '59100000000',
    to: '59170000000',
    text: { body: 'te atiendo yo' },
    kapso: { direction: 'outbound', origin: 'business_app', status: 'sent' },
  };
}

function body(message: Record<string, unknown>, phone = '59170000000'): string {
  return JSON.stringify({
    message,
    conversation: { id: 'conv-1', phone_number: phone },
    phone_number_id: 'pn-1',
  });
}

function headers(rawBody: string, over: Partial<Record<string, string | null>> = {}) {
  return {
    signature: sign(rawBody),
    version: KAPSO_PAYLOAD_VERSION,
    event: KAPSO_SUPPORTED_EVENT,
    idempotencyKey: 'idem-1',
    ...over,
  };
}

const NOOP_CONFIRM: ConfirmOrder = async () => ({ result: 'not_found' });
const NOOP_ENSURE: EnsureLocationRequest = async () => ({ result: 'not_applicable' });
const NOOP_ATTACH: AttachOrderLocation = async () => ({ result: 'not_found' });
const NEVER_SEND_CTA: SendMenuCta = async () => {
  throw new Error('sendMenuCta no debía llamarse');
};

/** Canal del agente configurable, con contadores para ver qué se ejecutó. */
function fakeChannel(over: Partial<AgentChannelPort> = {}) {
  const calls = { persist: 0, takeover: 0, turn: 0 };
  const channel: AgentChannelPort = {
    async persistCustomerInbound() {
      calls.persist += 1;
      return { result: 'persisted', conversationId: 'conv-uuid' };
    },
    async handleHumanTakeover() {
      calls.takeover += 1;
      return {
        result: 'ok',
        conversationId: 'conv-uuid',
        message: 'inserted',
        pause: 'paused',
        controlEvent: 'inserted',
      };
    },
    async runAgentTurn(): Promise<AgentTurnResult> {
      calls.turn += 1;
      return { result: 'replied', runId: 'run-1' };
    },
    ...over,
  };
  return { channel, calls };
}

function params(
  store: FakeWebhookEventStore,
  rawBody: string,
  over: Partial<HandleKapsoWebhookParams> = {},
): HandleKapsoWebhookParams {
  return {
    rawBody,
    headers: headers(rawBody),
    secret: SECRET,
    store,
    confirmOrder: NOOP_CONFIRM,
    ensureLocationRequest: NOOP_ENSURE,
    attachOrderLocation: NOOP_ATTACH,
    sendMenuCta: NEVER_SEND_CTA,
    ...over,
  };
}

describe('ACK durable — A/B/C · aceptar no es procesar', () => {
  it('A · firma inválida: NO hay aceptación durable', async () => {
    const raw = body(textMessage());
    const store = new FakeWebhookEventStore();
    const res = await acceptKapsoWebhook(
      params(store, raw, { headers: headers(raw, { signature: 'deadbeef' }) }),
    );

    expect(res.status).toBe(401);
    expect(res.pending).toBeNull();
    // Lo importante: no se escribió NADA. Una firma que no cuadra no merece
    // ni una fila.
    expect(store.rows.size).toBe(0);
  });

  it('B · un entrante válido queda aceptado de forma durable, en `received`', async () => {
    const raw = body(textMessage());
    const store = new FakeWebhookEventStore();
    const { channel } = fakeChannel();
    const res = await acceptKapsoWebhook(params(store, raw, { agentChannel: channel }));

    expect(res.status).toBe(200);
    expect(res.outcome).toBe('accepted');
    expect(res.pending).not.toBeNull();

    const row = store.rows.get(res.pending!.rowId)!;
    // `received`, no `processing`: aceptar y reclamar son actos distintos.
    expect(row.status).toBe('received');
    // Y AGENDADA: sin esto sería invisible para el recovery.
    expect(row.nextAttemptAt).not.toBeNull();
    // El payload entero viaja a la fila. Es la copia durable del trabajo.
    expect(row.payload).toEqual(JSON.parse(raw));
  });

  it('C · el 200 NO espera al Agent Core, ni al modelo, ni a las tools', async () => {
    const raw = body(textMessage());
    const store = new FakeWebhookEventStore();
    const { channel, calls } = fakeChannel({
      async runAgentTurn(): Promise<AgentTurnResult> {
        throw new Error('el turno del agente no puede correr antes del ACK');
      },
    });

    const res = await acceptKapsoWebhook(params(store, raw, { agentChannel: channel }));

    expect(res.status).toBe(200);
    // Ni el turno ni siquiera la persistencia del historial: la aceptación
    // solo verifica, parsea y escribe una fila.
    expect(calls.turn).toBe(0);
    expect(calls.persist).toBe(0);
    // El cuerpo es un acuse saneado: sin rowId, sin wamid, sin teléfono.
    expect(res.body).toEqual({ ok: true, accepted: true });
    expect(JSON.stringify(res.body)).not.toContain(res.pending!.rowId);
  });

  it('el acuse no filtra identificadores internos ni datos del cliente', async () => {
    const raw = body(textMessage());
    const store = new FakeWebhookEventStore();
    const res = await acceptKapsoWebhook(params(store, raw, { agentChannel: fakeChannel().channel }));
    const dump = JSON.stringify(res.body);

    for (const secreto of ['59170000000', 'wamid.TEXT_1', 'conv-1', 'pn-1', 'idem-1']) {
      expect(dump, secreto).not.toContain(secreto);
    }
  });
});

describe('ACK durable — D/E/F/G · procesamiento y recuperación', () => {
  it('D · procesar una fila aceptada la deja `processed`', async () => {
    const raw = body(textMessage());
    const store = new FakeWebhookEventStore();
    const { channel, calls } = fakeChannel();
    const p = params(store, raw, { agentChannel: channel });

    const accepted = await acceptKapsoWebhook(p);
    const processed = await processWebhookEvent(accepted.pending!.rowId, p);

    expect(processed.outcome).toBe('processed');
    expect(store.rows.get(accepted.pending!.rowId)!.status).toBe('processed');
    expect(calls.persist).toBe(1);
    expect(calls.turn).toBe(1);
  });

  it('un terminal NO queda agendado: el worker no lo puede volver a coger', async () => {
    const raw = body(textMessage());
    const store = new FakeWebhookEventStore();
    const p = params(store, raw, { agentChannel: fakeChannel().channel });

    const accepted = await acceptKapsoWebhook(p);
    await processWebhookEvent(accepted.pending!.rowId, p);

    expect(store.rows.get(accepted.pending!.rowId)!.nextAttemptAt).toBeNull();
    expect(await store.claimDue(10, WEBHOOK_LEASE_SECONDS)).toEqual([]);
  });

  it('E · si `after()` nunca corre, el recovery procesa la fila', async () => {
    const raw = body(textMessage());
    const store = new FakeWebhookEventStore();
    const { channel, calls } = fakeChannel();
    const p = params(store, raw, { agentChannel: channel });

    // Se acepta y NADIE la procesa: es exactamente lo que pasa si la
    // invocación muere justo después de responder 200.
    const accepted = await acceptKapsoWebhook(p);
    expect(calls.turn).toBe(0);

    const tick = await runInboxTick({ selector: store, processing: p });

    expect(tick).toEqual({ ok: true, claimed: 1, processed: 1, failed: 0, budget_exhausted: false });
    expect(store.rows.get(accepted.pending!.rowId)!.status).toBe('processed');
    expect(calls.turn).toBe(1);
  });

  it('F · una fila `processing` con lease VIGENTE no la toca el recovery', async () => {
    const raw = body(textMessage());
    const store = new FakeWebhookEventStore();
    const p = params(store, raw, { agentChannel: fakeChannel().channel });

    const accepted = await acceptKapsoWebhook(p);
    await store.claimEvent(accepted.pending!.rowId, WEBHOOK_LEASE_SECONDS);

    expect(await store.claimDue(10, WEBHOOK_LEASE_SECONDS)).toEqual([]);
  });

  it('F · si el lease VENCE, el recovery la reclama: eso es trabajo abandonado', async () => {
    const raw = body(textMessage());
    const store = new FakeWebhookEventStore();
    const { channel, calls } = fakeChannel();
    const p = params(store, raw, { agentChannel: channel });

    const accepted = await acceptKapsoWebhook(p);
    // Se reclama y se muere a mitad: la fila queda `processing`.
    await store.claimEvent(accepted.pending!.rowId, WEBHOOK_LEASE_SECONDS);
    expect(store.rows.get(accepted.pending!.rowId)!.status).toBe('processing');

    // El lease vence. No hace falta ninguna heurística de antigüedad: un
    // `processing` vencido ES trabajo abandonado, por definición.
    const base = Date.now();
    store.now = () => base + (WEBHOOK_LEASE_SECONDS + 1) * 1000;

    const tick = await runInboxTick({ selector: store, processing: p });
    expect(tick.claimed).toBe(1);
    expect(tick.processed).toBe(1);
    expect(calls.turn).toBe(1);
  });

  it('G · dos ejecuciones concurrentes: solo UNA reclama la fila', async () => {
    const raw = body(textMessage());
    const store = new FakeWebhookEventStore();
    const p = params(store, raw, { agentChannel: fakeChannel().channel });
    const accepted = await acceptKapsoWebhook(p);

    const [a, b] = await Promise.all([
      store.claimEvent(accepted.pending!.rowId, WEBHOOK_LEASE_SECONDS),
      store.claimEvent(accepted.pending!.rowId, WEBHOOK_LEASE_SECONDS),
    ]);

    // El reclamo es compare-and-set contra `received`: quien llega segundo
    // recibe null y se retira sin hacer nada.
    expect([a, b].filter((r) => r !== null)).toHaveLength(1);
  });

  it('G · quien pierde el reclamo NO ejecuta el negocio', async () => {
    const raw = body(textMessage());
    const store = new FakeWebhookEventStore();
    const { channel, calls } = fakeChannel();
    const p = params(store, raw, { agentChannel: channel });
    const accepted = await acceptKapsoWebhook(p);

    await store.claimEvent(accepted.pending!.rowId, WEBHOOK_LEASE_SECONDS);
    const res = await processWebhookEvent(accepted.pending!.rowId, p);

    expect(res.outcome).toBe('in_progress');
    expect(calls.turn).toBe(0);
  });
});

describe('ACK durable — H/I · reintentos acotados', () => {
  const boom: Partial<AgentChannelPort> = {
    async persistCustomerInbound() {
      throw new Error('supabase caída');
    },
  };

  it('H · fallo transitorio con intentos disponibles: vuelve a `received`, NO a `failed`', async () => {
    const raw = body(textMessage());
    const store = new FakeWebhookEventStore();
    const p = params(store, raw, { agentChannel: fakeChannel(boom).channel });

    const accepted = await acceptKapsoWebhook(p);
    const res = await processWebhookEvent(accepted.pending!.rowId, p);

    expect(res.status).toBe(500);
    const row = store.rows.get(accepted.pending!.rowId)!;
    // `failed` significaría "no se intenta más", y un hipo de red dejaría el
    // mensaje de un cliente muerto para siempre.
    expect(row.status).toBe('received');
    expect(row.attempts).toBe(1);
    expect(row.nextAttemptAt).not.toBeNull();
  });

  it('H · el motivo guardado no filtra teléfono ni contenido', async () => {
    const raw = body(textMessage());
    const store = new FakeWebhookEventStore();
    const p = params(store, raw, {
      agentChannel: fakeChannel({
        async persistCustomerInbound() {
          throw new Error('fallo de red');
        },
      }).channel,
    });

    const accepted = await acceptKapsoWebhook(p);
    await processWebhookEvent(accepted.pending!.rowId, p);

    const row = store.rows.get(accepted.pending!.rowId)!;
    expect(row.error).not.toContain('59170000000');
    expect(row.error).not.toContain('hola');
  });

  it('I · agotados los intentos: terminal `failed` y sin agendar', async () => {
    const raw = body(textMessage());
    const store = new FakeWebhookEventStore();
    const p = params(store, raw, { agentChannel: fakeChannel(boom).channel });

    const accepted = await acceptKapsoWebhook(p);
    const rowId = accepted.pending!.rowId;

    for (let i = 0; i < WEBHOOK_MAX_ATTEMPTS; i += 1) {
      await processWebhookEvent(rowId, p);
    }

    const row = store.rows.get(rowId)!;
    expect(row.status).toBe('failed');
    expect(row.attempts).toBe(WEBHOOK_MAX_ATTEMPTS);
    // Un terminal agendado lo seleccionaría el worker para siempre.
    expect(row.nextAttemptAt).toBeNull();
    expect(await store.claimDue(10, WEBHOOK_LEASE_SECONDS)).toEqual([]);
  });

  it('I · el backoff empieza corto: esto es un chat, no un batch nocturno', () => {
    expect(retryDelayMs(1)).toBe(WEBHOOK_RETRY_DELAYS_MS[0]);
    expect(retryDelayMs(1)).toBeLessThanOrEqual(5_000);
    // Creciente, y sin sorpresas al pasarse del último escalón.
    expect(retryDelayMs(2)).toBeGreaterThan(retryDelayMs(1));
    expect(retryDelayMs(99)).toBe(WEBHOOK_RETRY_DELAYS_MS[WEBHOOK_RETRY_DELAYS_MS.length - 1]);
  });

  it('I · no hay reintento infinito: quien corta es el tope, no el cálculo', () => {
    expect(hasAttemptsLeft(WEBHOOK_MAX_ATTEMPTS, WEBHOOK_MAX_ATTEMPTS)).toBe(false);
    expect(dispositionAfterFailure(WEBHOOK_MAX_ATTEMPTS, WEBHOOK_MAX_ATTEMPTS, 0)).toEqual({
      kind: 'exhausted',
    });
    expect(dispositionAfterFailure(1, WEBHOOK_MAX_ATTEMPTS, 0).kind).toBe('retry');
  });

  it('el presupuesto del tick está acotado: nada de bucles infinitos', async () => {
    const store = new FakeWebhookEventStore();
    const raw = body(textMessage());
    for (let i = 0; i < INBOX_TICK_BUDGET + 3; i += 1) {
      await store.insertReceived({
        event_id: `idem-${i}`,
        event_name: KAPSO_SUPPORTED_EVENT,
        message_id: `wamid.${i}`,
        payload: JSON.parse(raw),
      });
    }

    const tick = await runInboxTick({
      selector: store,
      processing: params(store, raw, { agentChannel: fakeChannel().channel }),
    });

    expect(tick.claimed).toBe(INBOX_TICK_BUDGET);
  });
});

describe('ACK durable — J/K · el takeover humano es SÍNCRONO', () => {
  const takeoverHeaders = (raw: string) =>
    headers(raw, { event: 'whatsapp.message.sent', idempotencyKey: 'idem-human' });

  it('J · la pausa se aplica ANTES del 200, no después', async () => {
    const raw = body(humanOutboundMessage());
    const store = new FakeWebhookEventStore();
    const { channel, calls } = fakeChannel();

    const res = await acceptKapsoWebhook(
      params(store, raw, { headers: takeoverHeaders(raw), agentChannel: channel }),
    );

    // Se resolvió en la aceptación: no queda nada pendiente que pudiera
    // ejecutarse tarde. Si la pausa llegara después, un turno ya aceptado la
    // consultaría y la vería `active`.
    expect(res.pending).toBeNull();
    expect(res.outcome).toBe('processed');
    expect(calls.takeover).toBe(1);
    expect(store.statuses()).toEqual(['processed']);
  });

  it('J · el fast path NO llama a OpenAI ni al Agent Core', async () => {
    const raw = body(humanOutboundMessage());
    const store = new FakeWebhookEventStore();
    const { channel, calls } = fakeChannel();

    await acceptKapsoWebhook(
      params(store, raw, { headers: takeoverHeaders(raw), agentChannel: channel }),
    );

    expect(calls.turn).toBe(0);
    expect(calls.persist).toBe(0);
  });

  it('K · si el takeover falla: 500, reclamable YA, y nunca colgado en processing', async () => {
    const raw = body(humanOutboundMessage());
    const store = new FakeWebhookEventStore();
    const { channel } = fakeChannel({
      async handleHumanTakeover() {
        throw new Error('supabase caída');
      },
    });

    const res = await acceptKapsoWebhook(
      params(store, raw, { headers: takeoverHeaders(raw), agentChannel: channel }),
    );

    expect(res.status).toBe(500);
    const row = [...store.rows.values()][0]!;
    // Ni `processing` (se quedaría colgada) ni `failed` (no se reintentaría).
    expect(row.status).toBe('received');
    // Y SIN backoff: una pausa que no se aplica es lo peor que le puede pasar
    // a la coexistencia, así que se deja disponible de inmediato.
    expect(row.nextAttemptAt).toBeLessThanOrEqual(Date.now());
  });

  it('K · la reentrega del mismo idempotency key lo recupera, sin duplicar la pausa', async () => {
    const raw = body(humanOutboundMessage());
    const store = new FakeWebhookEventStore();
    let primera = true;
    const { channel, calls } = fakeChannel({
      async handleHumanTakeover() {
        if (primera) {
          primera = false;
          throw new Error('supabase caída');
        }
        calls.takeover += 1;
        return {
          result: 'ok',
          conversationId: 'conv-uuid',
          message: 'duplicate',
          pause: 'paused',
          controlEvent: 'inserted',
        };
      },
    });

    const p = params(store, raw, { headers: takeoverHeaders(raw), agentChannel: channel });
    const primerIntento = await acceptKapsoWebhook(p);
    expect(primerIntento.status).toBe(500);

    // Kapso reentrega con la MISMA clave: una sola fila, y ahora sí se aplica.
    const segundo = await acceptKapsoWebhook(p);
    expect(segundo.status).toBe(200);
    expect(store.rows.size).toBe(1);
    expect(store.statuses()).toEqual(['processed']);
    expect(calls.takeover).toBe(1);
  });

  it('K · el recovery también puede terminar un takeover a medias', async () => {
    const raw = body(humanOutboundMessage());
    const store = new FakeWebhookEventStore();
    let primera = true;
    const { channel } = fakeChannel({
      async handleHumanTakeover() {
        if (primera) {
          primera = false;
          throw new Error('supabase caída');
        }
        return {
          result: 'ok',
          conversationId: 'conv-uuid',
          message: 'duplicate',
          pause: 'already_paused',
          controlEvent: 'duplicate',
        };
      },
    });

    const p = params(store, raw, { headers: takeoverHeaders(raw), agentChannel: channel });
    await acceptKapsoWebhook(p);

    // Sin ninguna reentrega: el worker lo recoge por sí solo. Una sola
    // implementación del negocio, alcanzable por los dos caminos.
    const tick = await runInboxTick({ selector: store, processing: p });
    expect(tick.processed).toBe(1);
    expect(store.statuses()).toEqual(['processed']);
  });
});

describe('ACK durable — O/P · idempotencia y rollback', () => {
  it('O · la misma clave dos veces produce UNA sola fila durable', async () => {
    const raw = body(textMessage());
    const store = new FakeWebhookEventStore();
    const p = params(store, raw, { agentChannel: fakeChannel().channel });

    await acceptKapsoWebhook(p);
    await acceptKapsoWebhook(p);

    expect(store.rows.size).toBe(1);
  });

  it('O · ACK perdido tras el INSERT: la reentrega no duplica el negocio', async () => {
    const raw = body(textMessage());
    const store = new FakeWebhookEventStore();
    const { channel, calls } = fakeChannel();
    const p = params(store, raw, { agentChannel: channel });

    // Aceptamos y el 200 se pierde por el camino. Kapso reentrega.
    const primero = await acceptKapsoWebhook(p);
    const segundo = await acceptKapsoWebhook(p);

    // Misma fila: la reentrega sirve para volver a intentarlo ya, no para
    // abrir un trabajo nuevo.
    expect(segundo.pending?.rowId).toBe(primero.pending!.rowId);
    expect(store.rows.size).toBe(1);

    await processWebhookEvent(primero.pending!.rowId, p);
    const tercero = await processWebhookEvent(primero.pending!.rowId, p);

    expect(tercero.outcome).toBe('in_progress');
    expect(calls.turn).toBe(1);
  });

  it('O · una fila ya `processed` responde duplicate y no vuelve a trabajar', async () => {
    const raw = body(textMessage());
    const store = new FakeWebhookEventStore();
    const { channel, calls } = fakeChannel();
    const p = params(store, raw, { agentChannel: channel });

    const accepted = await acceptKapsoWebhook(p);
    await processWebhookEvent(accepted.pending!.rowId, p);

    const repetido = await acceptKapsoWebhook(p);
    expect(repetido.body).toEqual({ ok: true, duplicate: true });
    expect(repetido.pending).toBeNull();
    expect(calls.turn).toBe(1);
  });

  it('P · el modo inline conserva el comportamiento anterior a 5C.1', async () => {
    const raw = body(textMessage());
    const store = new FakeWebhookEventStore();
    const { channel, calls } = fakeChannel();
    const p = params(store, raw, { agentChannel: channel });

    const res = await handleKapsoWebhook(p);

    // Procesa ANTES de responder y devuelve el cuerpo del negocio, no un acuse.
    expect(res.status).toBe(200);
    expect(res.outcome).toBe('processed');
    expect(res.body).toMatchObject({ agent_history: 'persisted', agent_turn: 'replied' });
    expect(calls.turn).toBe(1);
    expect(store.statuses()).toEqual(['processed']);
  });

  it('P · inline y async ejecutan EXACTAMENTE el mismo negocio', async () => {
    const raw = body(textMessage());

    const inlineStore = new FakeWebhookEventStore();
    const inline = fakeChannel();
    const inlineRes = await handleKapsoWebhook(
      params(inlineStore, raw, { agentChannel: inline.channel }),
    );

    const asyncStore = new FakeWebhookEventStore();
    const asincrono = fakeChannel();
    const asyncParams = params(asyncStore, raw, { agentChannel: asincrono.channel });
    const accepted = await acceptKapsoWebhook(asyncParams);
    const asyncRes = await processWebhookEvent(accepted.pending!.rowId, asyncParams);

    // Mismo cuerpo de negocio y las mismas llamadas: lo que cambia entre modos
    // es CUÁNDO se procesa, nunca QUÉ se hace.
    expect(asyncRes.body).toEqual(inlineRes.body);
    expect(asincrono.calls).toEqual(inline.calls);
  });
});

describe('ACK durable — N · la pausa detiene al AGENTE, no al negocio', () => {
  /** Canal con la conversación tomada por una persona. */
  function pausedChannel() {
    const calls = { turn: 0 };
    const channel: AgentChannelPort = {
      async persistCustomerInbound() {
        return { result: 'persisted', conversationId: 'conv-uuid' };
      },
      async handleHumanTakeover() {
        return {
          result: 'ok',
          conversationId: 'conv-uuid',
          message: 'inserted',
          pause: 'already_paused',
          controlEvent: 'duplicate',
        };
      },
      async runAgentTurn(): Promise<AgentTurnResult> {
        calls.turn += 1;
        return { result: 'skipped', reason: 'paused', runId: 'run-1' };
      },
    };
    return { channel, calls };
  }

  it('TESTMENU9842 sigue mandando el CTA con la conversación pausada', async () => {
    const raw = body({ ...textMessage('wamid.QA'), text: { body: 'TESTMENU9842' } });
    const store = new FakeWebhookEventStore();
    const enviados: string[] = [];
    const p = params(store, raw, {
      agentChannel: pausedChannel().channel,
      sendMenuCta: async (input) => {
        enviados.push(input.sourceMessageId);
        return { result: 'sent', deliveryId: 'del-1', wamid: 'wamid.CTA' };
      },
    });

    const res = await handleKapsoWebhook(p);

    expect(res.body).toMatchObject({ handled: 'menu_cta', result: 'sent' });
    expect(enviados).toEqual(['wamid.QA']);
  });

  it('una ubicación se sigue guardando con la conversación pausada', async () => {
    const locationMessage = {
      id: 'wamid.LOC',
      type: 'location',
      from: '59170000000',
      context: { id: 'wamid.LOC_REQ' },
      location: { latitude: -17.78, longitude: -63.18 },
    };
    const raw = body(locationMessage);
    const store = new FakeWebhookEventStore();
    const adjuntadas: string[] = [];
    const p = params(store, raw, {
      agentChannel: pausedChannel().channel,
      attachOrderLocation: async (input) => {
        adjuntadas.push(input.contextId);
        return {
          result: 'attached',
          order: { id: 'ord-1', order_number: 'ORD-1', status: 'confirmed' },
        };
      },
    });

    const res = await handleKapsoWebhook(p);

    // El GPS de un cliente al que atiende una persona sigue haciendo falta.
    expect(res.body).toMatchObject({ handled: 'location', result: 'attached' });
    expect(adjuntadas).toEqual(['wamid.LOC_REQ']);
  });

  it('el agente SÍ se calla: es el único que la pausa detiene', async () => {
    const raw = body(textMessage());
    const store = new FakeWebhookEventStore();
    const { channel, calls } = pausedChannel();
    const res = await handleKapsoWebhook(params(store, raw, { agentChannel: channel }));

    // Se le invoca —el webhook no decide por él— y es el turno quien para.
    expect(calls.turn).toBe(1);
    expect(res.body).toMatchObject({ agent_turn: 'skipped:paused' });
  });
});

// ── El endpoint del recovery worker ─────────────────────────────────────────

describe('ACK durable — recovery worker: contrato del endpoint', () => {
  const TOKEN = 'token-interno-de-prueba';

  function tickDeps(store: FakeWebhookEventStore, over: Partial<InboxWorkerDeps> = {}) {
    return {
      internalToken: TOKEN,
      selector: store,
      processing: params(store, body(textMessage()), { agentChannel: fakeChannel().channel }),
      ...over,
    };
  }

  function tickRequest(over: { method?: string; auth?: string | null; body?: string } = {}) {
    const headers: Record<string, string> = {};
    if (over.auth !== null) headers.Authorization = over.auth ?? `Bearer ${TOKEN}`;
    return new Request('https://ejemplo.test/api/internal/webhook-events/worker/tick', {
      method: over.method ?? 'POST',
      headers,
      ...(over.method === 'GET' ? {} : { body: over.body ?? '{}' }),
    });
  }

  it('GET sigue devolviendo 405: el tick no se dispara desde un navegador', async () => {
    const store = new FakeWebhookEventStore();
    const res = await handleInboxTick(tickRequest({ method: 'GET' }), tickDeps(store));
    expect(res.status).toBe(405);
  });

  it('POST sin Bearer → 401', async () => {
    const store = new FakeWebhookEventStore();
    const res = await handleInboxTick(tickRequest({ auth: null }), tickDeps(store));
    expect(res.status).toBe(401);
  });

  it('POST con Bearer incorrecto → 401', async () => {
    const store = new FakeWebhookEventStore();
    const res = await handleInboxTick(tickRequest({ auth: 'Bearer otro' }), tickDeps(store));
    expect(res.status).toBe(401);
  });

  it('sin token configurado se responde 401, nunca se abre', async () => {
    const store = new FakeWebhookEventStore();
    const res = await handleInboxTick(tickRequest(), tickDeps(store, { internalToken: null }));
    expect(res.status).toBe(401);
  });

  it('JSON inválido → 400; cuerpo con campos → 422', async () => {
    const store = new FakeWebhookEventStore();
    expect((await handleInboxTick(tickRequest({ body: '{' }), tickDeps(store))).status).toBe(400);
    // El caller NO elige el trabajo: cualquier campo se rechaza.
    expect(
      (await handleInboxTick(tickRequest({ body: '{"limit":50}' }), tickDeps(store))).status,
    ).toBe(422);
  });

  it('un tick correcto devuelve ok=true y los recuentos', async () => {
    const store = new FakeWebhookEventStore();
    const res = await handleInboxTick(tickRequest(), tickDeps(store));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      claimed: 0,
      processed: 0,
      failed: 0,
      budget_exhausted: false,
    });
  });

  it('la respuesta no filtra payload, teléfono, wamid ni claves', async () => {
    const store = new FakeWebhookEventStore();
    const raw = body(textMessage());
    await store.insertReceived({
      event_id: 'idem-1',
      event_name: KAPSO_SUPPORTED_EVENT,
      message_id: 'wamid.TEXT_1',
      payload: JSON.parse(raw),
    });

    const res = await handleInboxTick(tickRequest(), tickDeps(store));
    const dump = JSON.stringify(await res.json());

    for (const secreto of ['59170000000', 'wamid.TEXT_1', 'idem-1', 'hola', TOKEN]) {
      expect(dump, secreto).not.toContain(secreto);
    }
  });
});

describe('ACK durable — recovery worker: presupuesto', () => {
  async function seedDue(store: FakeWebhookEventStore, n: number) {
    const raw = body(textMessage());
    for (let i = 0; i < n; i += 1) {
      await store.insertReceived({
        event_id: `idem-${i}`,
        event_name: KAPSO_SUPPORTED_EVENT,
        message_id: `wamid.${i}`,
        payload: JSON.parse(raw),
      });
    }
  }

  it('nunca reclama más del límite, aunque haya mucho vencido', async () => {
    const store = new FakeWebhookEventStore();
    await seedDue(store, INBOX_TICK_BUDGET + 4);

    const tick = await runInboxTick({
      selector: store,
      processing: params(store, body(textMessage()), { agentChannel: fakeChannel().channel }),
    });

    expect(tick.claimed).toBe(INBOX_TICK_BUDGET);
    expect(tick.processed).toBe(INBOX_TICK_BUDGET);
    // Lo que no entró sigue disponible: lo toma el siguiente tick.
    expect(store.statuses().filter((s) => s === 'received')).toHaveLength(4);
  });

  it('el límite es 3, no 5: cinco turnos del agente no caben en 55 s', () => {
    // 11-12 s medidos por turno con herramienta en Production.
    expect(INBOX_TICK_BUDGET).toBe(3);
    expect(INBOX_TICK_BUDGET * 12_000).toBeLessThan(INBOX_TICK_WALL_CLOCK_MS);
  });

  it('el presupuesto de reloj corta el tick antes del timeout del caller', async () => {
    const store = new FakeWebhookEventStore();
    await seedDue(store, INBOX_TICK_BUDGET);

    // Cada evento "tarda" más que todo el presupuesto: solo cabe el primero.
    const guion = [0, 0, INBOX_TICK_WALL_CLOCK_MS];
    let paso = 0;
    const tick = await runInboxTick({
      selector: store,
      processing: params(store, body(textMessage()), { agentChannel: fakeChannel().channel }),
      now: () => guion[Math.min(paso++, guion.length - 1)],
    });

    expect(tick.claimed).toBe(1);
    expect(tick.budget_exhausted).toBe(true);
  });

  it('el presupuesto se mira ANTES de reclamar: no se gasta un intento sin intentarlo', async () => {
    const store = new FakeWebhookEventStore();
    await seedDue(store, 2);

    const guion = [0, 0, INBOX_TICK_WALL_CLOCK_MS];
    let paso = 0;
    await runInboxTick({
      selector: store,
      processing: params(store, body(textMessage()), { agentChannel: fakeChannel().channel }),
      now: () => guion[Math.min(paso++, guion.length - 1)],
    });

    // La segunda fila ni se tocó: sigue en `received` con 0 intentos gastados.
    const intactas = [...store.rows.values()].filter((r) => r.status === 'received');
    expect(intactas).toHaveLength(1);
    expect(intactas[0].attempts).toBe(0);
  });

  it('el presupuesto de reloj cabe holgado bajo el timeout del despertador', () => {
    // El Worker de Cloudflare aborta a los 55 s; el endpoint tiene que poder
    // cerrar por su cuenta y devolver recuentos en vez de que le corten.
    expect(INBOX_TICK_WALL_CLOCK_MS).toBeLessThan(55_000);
  });
});
