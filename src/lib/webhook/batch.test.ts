import { describe, it, expect, beforeEach } from 'vitest';
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
import { runInboxTick } from './inbox-worker';
import { FakeWebhookEventStore } from './fake-store';
import { toEnvelopes } from './envelopes';
import type { AgentChannelPort, AgentTurnResult } from '@/lib/agent/core/types';
import type { ProvenanceMessage } from '@/lib/kapso/channel/provenance';

/**
 * SOPORTE DE LOTES DE KAPSO (Fase 6D.2F.5C.2).
 *
 * Con el buffering activado, Kapso agrupa varios `whatsapp.message.received` en
 * una sola entrega. Lo que se prueba aquí es la afirmación central de la fase:
 *
 *   un lote NO es un mensaje grande — son N mensajes que llegaron juntos,
 *   y de ellos sale COMO MÁXIMO un turno del agente.
 *
 * Los dos extremos importan por igual. Si los mensajes se fusionaran se perdería
 * el WAMID individual y con él la idempotencia; si cada uno abriera su turno, una
 * ráfaga de tres produciría tres respuestas y tres CTAs.
 *
 * El buffering sigue APAGADO en Kapso: este camino existe antes de encenderlo,
 * que es el mismo orden que el de las migraciones — primero el código, después
 * el interruptor.
 */

const SECRET = 'test-webhook-secret';
const PHONE_RAW = '+591 700-00001';
const PHONE_DIGITS = '59170000001';

function sign(rawBody: string): string {
  return createHmac('sha256', SECRET).update(rawBody, 'utf8').digest('hex');
}

/** Sobre individual: EXACTAMENTE la forma de un webhook sin buffering. */
function envelope(
  over: {
    wamid?: string;
    text?: string;
    timestamp?: number;
    phone?: string;
    phoneNumberId?: string;
    message?: Record<string, unknown>;
  } = {},
): Record<string, unknown> {
  const phone = over.phone ?? PHONE_RAW;
  return {
    phone_number_id: over.phoneNumberId ?? 'pn-1',
    is_new_conversation: false,
    message: over.message ?? {
      id: over.wamid ?? 'wamid.UNO',
      type: 'text',
      text: { body: over.text ?? 'Hola' },
      from: phone,
      timestamp: over.timestamp ?? 1_760_000_000,
      kapso: { direction: 'inbound', origin: 'business_app', status: 'received' },
    },
    conversation: { id: 'kapso-conv-1', phone_number: phone },
  };
}

/** Ubicación: ruta determinística, con su propio WAMID. */
function locationEnvelope(wamid = 'wamid.LOC'): Record<string, unknown> {
  return envelope({
    message: {
      id: wamid,
      type: 'location',
      // `context.id` correlaciona con el `location_request_message` saliente:
      // sin él el mensaje no valida y no entra por la ruta determinística.
      context: { id: 'wamid.LOC_REQUEST' },
      location: { latitude: -19.58, longitude: -65.75, address: 'Av. X 123', name: 'Casa' },
      from: PHONE_RAW,
      timestamp: 1_760_000_000,
      kapso: { direction: 'inbound', origin: 'business_app', status: 'received' },
    },
  });
}

/**
 * Reacción AGREGADA, con la forma REAL capturada en Production (5C.4): WAMID
 * propio, `reaction.emoji` presente, y la frase que Kapso redacta en
 * `kapso.content`. Esa frase se conserva a propósito — es la contaminación que
 * el sistema tiene que impedir que llegue a `content`.
 */
function reactionEnvelope(wamid = 'wamid.REACT', target = 'wamid.UNO'): Record<string, unknown> {
  return envelope({
    message: {
      id: wamid,
      type: 'reaction',
      reaction: { message_id: target, emoji: '❤️' },
      from: PHONE_RAW,
      timestamp: 1_760_000_000,
      kapso: {
        direction: 'inbound',
        origin: 'business_app',
        status: 'received',
        content: `Reacted with ❤️ to message ${target}`,
        message_type_data: { message_id: target, emoji: '❤️' },
      },
    },
  });
}

/** Reacción QUITADA: otro WAMID propio y SIN `reaction.emoji`. */
function reactionRemovedEnvelope(
  wamid = 'wamid.UNREACT',
  target = 'wamid.UNO',
): Record<string, unknown> {
  return envelope({
    message: {
      id: wamid,
      type: 'reaction',
      reaction: { message_id: target },
      from: PHONE_RAW,
      timestamp: 1_760_000_060,
      kapso: {
        direction: 'inbound',
        origin: 'business_app',
        status: 'received',
        content: `Reaction removed from message ${target}`,
        message_type_data: { message_id: target },
      },
    },
  });
}

/**
 * Sobre del lote, fielmente según el contrato oficial. Sin campos inventados:
 * `type`, `batch`, `data` y `batch_info` con sus cinco claves documentadas.
 */
function batchBody(
  data: readonly Record<string, unknown>[],
  over: Partial<{ size: number; conversationId: string }> = {},
): string {
  return JSON.stringify({
    type: 'whatsapp.message.received',
    batch: true,
    data,
    batch_info: {
      size: over.size ?? data.length,
      window_ms: 5000,
      first_sequence: 1,
      last_sequence: data.length,
      conversation_id: over.conversationId ?? 'kapso-conv-1',
    },
  });
}

function headers(rawBody: string, idempotencyKey = 'idem-1') {
  return {
    signature: sign(rawBody),
    version: KAPSO_PAYLOAD_VERSION,
    event: KAPSO_SUPPORTED_EVENT,
    idempotencyKey,
  };
}

const NOOP_CONFIRM: ConfirmOrder = async () => ({ result: 'not_found' });
const NOOP_ENSURE: EnsureLocationRequest = async () => ({ result: 'not_applicable' });
const NEVER_CTA: SendMenuCta = async () => {
  throw new Error('sendMenuCta no debía llamarse');
};

/** Registra qué mensajes llegaron a cada puerta, con su WAMID y en orden. */
function spyChannel() {
  const persisted: ProvenanceMessage[] = [];
  const turns: ProvenanceMessage[] = [];
  const attached: string[] = [];

  const channel: AgentChannelPort = {
    async persistCustomerInbound(message) {
      persisted.push(message);
      return { result: 'persisted', conversationId: 'conv-uuid' };
    },
    async handleHumanTakeover() {
      throw new Error('un lote nunca lleva takeover');
    },
    async runAgentTurn(message): Promise<AgentTurnResult> {
      turns.push(message);
      return { result: 'replied', runId: `run-${turns.length}` };
    },
  };

  const attachOrderLocation: AttachOrderLocation = async (input) => {
    attached.push(input.customerPhoneDigits);
    return { result: 'not_found' };
  };

  return { channel, persisted, turns, attached, attachOrderLocation };
}

function params(
  store: FakeWebhookEventStore,
  rawBody: string,
  over: Partial<HandleKapsoWebhookParams> = {},
  idempotencyKey = 'idem-1',
): HandleKapsoWebhookParams {
  return {
    rawBody,
    headers: headers(rawBody, idempotencyKey),
    secret: SECRET,
    store,
    confirmOrder: NOOP_CONFIRM,
    ensureLocationRequest: NOOP_ENSURE,
    attachOrderLocation: async () => ({ result: 'not_found' }),
    sendMenuCta: NEVER_CTA,
    ...over,
  };
}

let events: FakeWebhookEventStore;
beforeEach(() => {
  events = new FakeWebhookEventStore();
});

/** Acepta y procesa, como hace `after()` en Production con async=true. */
async function deliver(rawBody: string, over: Partial<HandleKapsoWebhookParams> = {}, key = 'idem-1') {
  const p = params(events, rawBody, over, key);
  const accepted = await acceptKapsoWebhook(p);
  if (!accepted.pending) return { accepted, processed: null };
  const processed = await processWebhookEvent(accepted.pending.rowId, p);
  return { accepted, processed };
}

// ── 1/2/3/15: la forma ──────────────────────────────────────────────────────

describe('lotes — normalización', () => {
  it('1 · una entrega individual sigue siendo un solo sobre, sin marca de lote', () => {
    const payload = envelope();
    const res = toEnvelopes(payload);

    expect(res).toMatchObject({ ok: true, batched: false, batchInfo: null });
    expect(res.ok && res.envelopes).toEqual([{ index: 0, payload }]);
  });

  it('2 · un lote de uno se normaliza igual que cualquier otro', () => {
    const res = toEnvelopes(JSON.parse(batchBody([envelope()])));

    expect(res).toMatchObject({ ok: true, batched: true });
    expect(res.ok && res.envelopes).toHaveLength(1);
    expect(res.ok && res.batchInfo).toMatchObject({ size: 1, windowMs: 5000 });
  });

  it('3 · el orden de `data[]` se conserva tal cual, con su índice original', () => {
    const data = [
      envelope({ wamid: 'wamid.A', text: 'Hola' }),
      envelope({ wamid: 'wamid.B', text: 'Qué hamburguesas tienen?' }),
      envelope({ wamid: 'wamid.C', text: 'Y bebidas?' }),
    ];
    const res = toEnvelopes(JSON.parse(batchBody(data)));

    expect(res.ok && res.envelopes.map((e) => e.index)).toEqual([0, 1, 2]);
    expect(res.ok && res.envelopes.map((e) => (e.payload as { message: { id: string } }).message.id))
      .toEqual(['wamid.A', 'wamid.B', 'wamid.C']);
  });

  it('15 · el phone_number_id sale del ELEMENTO, nunca del sobre exterior', async () => {
    // El contrato lo garantiza por elemento y el código no lee ninguna raíz
    // exterior. Aquí el sobre del lote declara uno distinto a propósito: si se
    // usara como fallback, ganaría — y no gana.
    const spy = spyChannel();
    const conRaiz = JSON.parse(
      batchBody([
        envelope({ wamid: 'wamid.A', phoneNumberId: 'pn-elemento' }),
        envelope({ wamid: 'wamid.B', phoneNumberId: 'pn-elemento' }),
      ]),
    ) as Record<string, unknown>;
    conRaiz.phone_number_id = 'pn-sobre-exterior';

    await deliver(JSON.stringify(conRaiz), { agentChannel: spy.channel });

    expect(spy.persisted.map((m) => m.providerPhoneNumberId)).toEqual([
      'pn-elemento',
      'pn-elemento',
    ]);
  });
});

// ── 13/14/16/19: lo que no se acepta ────────────────────────────────────────

describe('lotes — fail closed ante un sobre que no entendemos', () => {
  const casos: readonly [string, unknown, string][] = [
    ['13 · data no es array', { batch: true, data: 'nope', batch_info: {} }, 'batch_data_not_array'],
    ['14 · data vacío', { batch: true, data: [], batch_info: {} }, 'batch_data_empty'],
    [
      '13 · sin batch_info',
      { batch: true, data: [envelope()] },
      'batch_missing_batch_info',
    ],
    [
      '13 · un elemento sin message',
      { batch: true, data: [envelope(), { conversation: {} }], batch_info: {} },
      'batch_element_invalid',
    ],
  ];

  for (const [nombre, payload, reason] of casos) {
    it(`${nombre} → 422, sin fila durable`, async () => {
      const raw = JSON.stringify(payload);
      const res = await acceptKapsoWebhook(params(events, raw));

      expect(res.status).toBe(422);
      expect(res.outcome).toBe('unsupported_batch');
      expect(res.body).toEqual({ ok: false, error: 'unsupported_batch', reason });
      // Nada se acepta a medias: un lote roto no deja rastro que reprocesar.
      expect(events.rows.size).toBe(0);
    });
  }

  it('un lote malformado NUNCA se degrada a entrega individual', async () => {
    // La tentación evidente sería «si el lote no sirve, trátalo como un mensaje».
    // Pero el sobre exterior no tiene `message`: se estaría inventando uno.
    const spy = spyChannel();
    const raw = JSON.stringify({ batch: true, data: [], batch_info: {} });

    await acceptKapsoWebhook(params(events, raw, { agentChannel: spy.channel }));

    expect(spy.persisted).toEqual([]);
    expect(spy.turns).toEqual([]);
  });

  it('16 · un lote que mezcla conversaciones se rechaza entero', async () => {
    // Kapso agrupa por conversación. Si esa garantía fallara, el daño no sería
    // un error visible sino un turno que responde a un cliente con el contexto
    // de otro. Preferimos no procesar y que la entrega falle a la vista.
    const raw = batchBody([
      envelope({ wamid: 'wamid.A', phone: PHONE_RAW }),
      envelope({ wamid: 'wamid.B', phone: '+591 700-00002' }),
    ]);

    const res = await acceptKapsoWebhook(params(events, raw));

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ reason: 'batch_mixed_conversations' });
    expect(events.rows.size).toBe(0);
  });

  it('4 · un lote con phone_number_id distintos se rechaza entero', async () => {
    // Kapso debería garantizarlo. Si no lo hiciera, el turno saldría por un
    // número que el cliente no reconoce como el del negocio — y solo se vería
    // desde el lado del cliente, que es donde no miramos.
    const raw = batchBody([
      envelope({ wamid: 'wamid.A', phoneNumberId: 'pn-A' }),
      envelope({ wamid: 'wamid.B', phoneNumberId: 'pn-B' }),
    ]);

    const res = await acceptKapsoWebhook(params(events, raw));

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ reason: 'batch_mixed_phone_number_ids' });
    expect(events.rows.size).toBe(0);
  });

  it('4 · un lote con conversation.id distintos se rechaza entero', async () => {
    const raw = JSON.stringify({
      type: 'whatsapp.message.received',
      batch: true,
      data: [
        { ...envelope({ wamid: 'wamid.A' }), conversation: { id: 'conv-1', phone_number: PHONE_RAW } },
        { ...envelope({ wamid: 'wamid.B' }), conversation: { id: 'conv-2', phone_number: PHONE_RAW } },
      ],
      batch_info: { size: 2, window_ms: 5000, first_sequence: 1, last_sequence: 2, conversation_id: 'conv-1' },
    });

    const res = await acceptKapsoWebhook(params(events, raw));

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ reason: 'batch_mixed_conversation_ids' });
  });

  it('4 · un campo AUSENTE no es una contradicción: el lote pasa', async () => {
    // Faltar no es contradecir. Rechazar por ausencia tiraría lotes válidos, y
    // el resto del pipeline ya sabe convivir con un `phone_number_id` nulo.
    const spy = spyChannel();
    const sinPnid = envelope({ wamid: 'wamid.B' });
    delete (sinPnid as { phone_number_id?: unknown }).phone_number_id;
    const raw = batchBody([envelope({ wamid: 'wamid.A', phoneNumberId: 'pn-1' }), sinPnid]);

    const { processed } = await deliver(raw, { agentChannel: spy.channel });

    expect(processed?.outcome).toBe('processed');
    expect(spy.persisted.map((m) => m.providerPhoneNumberId)).toEqual(['pn-1', null]);
  });

  it('un lote de un evento que NO es `received` se rechaza', async () => {
    // El buffering solo agrupa entrantes. Lo que llegaría por ahí es justo lo
    // que no puede diferirse: el takeover humano viaja en `message.sent`.
    const raw = batchBody([envelope()]);
    const res = await acceptKapsoWebhook({
      ...params(events, raw),
      headers: { ...headers(raw), event: 'whatsapp.message.sent' },
      agentChannel: spyChannel().channel,
    });

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ reason: 'batch_unsupported_event' });
  });

  it('19 · batch_info.size que no cuadra NO descarta mensajes reales', async () => {
    // `size` es diagnóstico; la autoridad es `data.length`. Tirar mensajes que
    // tenemos delante por un contador que no cuadra sería el peor intercambio.
    const spy = spyChannel();
    const raw = batchBody([envelope({ wamid: 'wamid.A' }), envelope({ wamid: 'wamid.B' })], {
      size: 7,
    });

    const { processed } = await deliver(raw, { agentChannel: spy.channel });

    expect(processed?.outcome).toBe('processed');
    expect(spy.persisted.map((m) => m.providerMessageId)).toEqual(['wamid.A', 'wamid.B']);
  });
});

// ── 4/5/18: el ancla ────────────────────────────────────────────────────────

describe('lotes — el ancla es la POSICIÓN, no el reloj', () => {
  it('4 · con timestamps IGUALES gana la posición en data[]', async () => {
    // El caso que obliga a la regla. El timestamp de WhatsApp viene en SEGUNDOS
    // y el buffering agrupa ráfagas: tres mensajes seguidos comparten segundo
    // muy a menudo. Ordenar por reloj dejaría indeterminado justo esto.
    const spy = spyChannel();
    const mismoSegundo = 1_760_000_000;
    const raw = batchBody([
      envelope({ wamid: 'wamid.A', text: 'Hola', timestamp: mismoSegundo }),
      envelope({ wamid: 'wamid.B', text: 'Qué hamburguesas tienen?', timestamp: mismoSegundo }),
    ]);

    const { processed } = await deliver(raw, { agentChannel: spy.channel });

    expect(spy.turns).toHaveLength(1);
    expect(spy.turns[0].providerMessageId).toBe('wamid.B');
    expect(spy.turns[0].content).toBe('Qué hamburguesas tienen?');
    expect(processed?.body).toMatchObject({ anchor_index: 1 });
  });

  it('4 · un timestamp ANTERIOR en la última posición no mueve el ancla', async () => {
    // Prueba negativa del mismo punto: si el criterio fuera el reloj, el ancla
    // sería el primero. Es la posición.
    const spy = spyChannel();
    const raw = batchBody([
      envelope({ wamid: 'wamid.A', text: 'Hola', timestamp: 1_760_000_100 }),
      envelope({ wamid: 'wamid.B', text: 'Y bebidas?', timestamp: 1_760_000_000 }),
    ]);

    await deliver(raw, { agentChannel: spy.channel });

    expect(spy.turns[0].providerMessageId).toBe('wamid.B');
  });

  it('5 · tres textos: tres persistencias, UN turno, anclado en el último', async () => {
    const spy = spyChannel();
    const raw = batchBody([
      envelope({ wamid: 'wamid.A', text: 'Hola' }),
      envelope({ wamid: 'wamid.B', text: 'quería saber' }),
      envelope({ wamid: 'wamid.C', text: 'qué hamburguesas tienen?' }),
    ]);

    const { processed } = await deliver(raw, { agentChannel: spy.channel });

    // Nada se fusiona: tres mensajes reales, con su WAMID y en orden.
    expect(spy.persisted.map((m) => m.providerMessageId)).toEqual([
      'wamid.A',
      'wamid.B',
      'wamid.C',
    ]);
    expect(spy.persisted.map((m) => m.content)).toEqual([
      'Hola',
      'quería saber',
      'qué hamburguesas tienen?',
    ]);
    // Y un solo turno: una ráfaga es una intervención, no tres.
    expect(spy.turns).toHaveLength(1);
    expect(spy.turns[0].providerMessageId).toBe('wamid.C');
    expect(processed?.body).toMatchObject({
      handled: 'batch',
      batch_size: 3,
      anchor_index: 2,
      agent_turn: 'replied',
    });
  });

  it('18 · el ancla que viaja al turno es el mensaje REAL, no uno fabricado', async () => {
    // No se concatenan los textos ni se inventa un mensaje nuevo: el turno
    // recibe el ProvenanceMessage del último elegible, con su WAMID, y de ahí
    // sale `agent_runs.source_message_id`.
    const spy = spyChannel();
    const raw = batchBody([
      envelope({ wamid: 'wamid.A', text: 'Hola' }),
      envelope({ wamid: 'wamid.B', text: 'Y bebidas?' }),
    ]);

    await deliver(raw, { agentChannel: spy.channel });

    expect(spy.turns[0]).toMatchObject({
      providerMessageId: 'wamid.B',
      content: 'Y bebidas?',
      customerPhone: PHONE_DIGITS,
      contentType: 'text',
    });
    expect(spy.turns[0].content).not.toContain('Hola');
  });
});

// ── 6/7/8/9: clasificación por elemento ─────────────────────────────────────

describe('lotes — cada elemento por su ruta', () => {
  it('6 · texto + ubicación + texto: la ubicación va por lo determinístico', async () => {
    const spy = spyChannel();
    const raw = batchBody([
      envelope({ wamid: 'wamid.A', text: 'hola' }),
      locationEnvelope('wamid.LOC'),
      envelope({ wamid: 'wamid.C', text: 'y bebidas?' }),
    ]);

    const { processed } = await deliver(raw, {
      agentChannel: spy.channel,
      attachOrderLocation: spy.attachOrderLocation,
    });

    // Los tres se persisten, cada uno con su WAMID.
    expect(spy.persisted.map((m) => m.providerMessageId)).toEqual([
      'wamid.A',
      'wamid.LOC',
      'wamid.C',
    ]);
    // La ubicación entró por su ruta, con la identidad del cliente.
    expect(spy.attached).toEqual([PHONE_DIGITS]);
    // Y el turno se ancla en la pregunta, no en la ubicación.
    expect(spy.turns).toHaveLength(1);
    expect(spy.turns[0].providerMessageId).toBe('wamid.C');
    expect(processed?.body).toMatchObject({ anchor_index: 2 });

    const results = (processed?.body as { results: { kind: string }[] }).results;
    expect(results.map((r) => r.kind)).toEqual(['eligible', 'deterministic', 'eligible']);
  });

  it('7 · solo elementos determinísticos: CERO turnos', async () => {
    const spy = spyChannel();
    const raw = batchBody([locationEnvelope('wamid.L1'), locationEnvelope('wamid.L2')]);

    const { processed } = await deliver(raw, {
      agentChannel: spy.channel,
      attachOrderLocation: spy.attachOrderLocation,
    });

    expect(spy.persisted).toHaveLength(2);
    expect(spy.turns).toEqual([]);
    expect(processed?.body).toMatchObject({ anchor_index: null });
    expect(processed?.body).not.toHaveProperty('agent_turn');
  });

  it('8 · solo elementos silenciosos: se persisten y el agente no responde', async () => {
    // Una reacción llega sin contenido legible. El ancla existe —para no
    // cambiar el camino individual— pero el gate de contenido del core la
    // descarta antes de reclamar ningún run.
    const spy = spyChannel();
    const raw = batchBody([reactionEnvelope('wamid.R1'), reactionEnvelope('wamid.R2')]);

    const { processed } = await deliver(raw, { agentChannel: spy.channel });

    expect(spy.persisted.map((m) => m.providerMessageId)).toEqual(['wamid.R1', 'wamid.R2']);
    const results = (processed?.body as { results: { kind: string }[] }).results;
    expect(results.map((r) => r.kind)).toEqual(['silent', 'silent']);
  });

  it('9 · determinístico + silencioso, sin ningún elegible: no hay ancla', async () => {
    const spy = spyChannel();
    const raw = batchBody([locationEnvelope('wamid.LOC'), reactionEnvelope('wamid.R1')]);

    const { processed } = await deliver(raw, {
      agentChannel: spy.channel,
      attachOrderLocation: spy.attachOrderLocation,
    });

    // La ubicación no puede anclar: ya la atendió su ruta. Y desde 5C.4 la
    // reacción tampoco, ni como último recurso — es un evento de canal. Antes
    // anclaba aquí y moría en el gate del core; ahora no llega a intentarlo.
    expect(processed?.body).toMatchObject({ anchor_index: null });
    expect(spy.turns).toEqual([]);
    // La ubicación sí se atendió: excluir el ancla no apaga ninguna ruta.
    expect(spy.attached).toEqual([PHONE_DIGITS]);
  });

  it('un elegible después de uno silencioso gana el ancla', async () => {
    // El caso del documento de auditoría: ["qué hamburguesas hay?", ❤️]. La
    // reacción cierra el lote pero la pregunta es lo que hay que contestar.
    const spy = spyChannel();
    const raw = batchBody([
      envelope({ wamid: 'wamid.A', text: 'qué hamburguesas hay?' }),
      reactionEnvelope('wamid.R1'),
    ]);

    const { processed } = await deliver(raw, { agentChannel: spy.channel });

    expect(spy.turns[0].providerMessageId).toBe('wamid.A');
    expect(processed?.body).toMatchObject({ anchor_index: 0 });
  });
});

// ── 1: el camino individual, intacto ────────────────────────────────────────

describe('lotes — la entrega individual no cambia', () => {
  it('1 · un entrante suelto devuelve el MISMO cuerpo que antes de 5C.2', async () => {
    const spy = spyChannel();
    const raw = JSON.stringify(envelope({ wamid: 'wamid.SOLO', text: 'Hola' }));

    const { processed } = await deliver(raw, { agentChannel: spy.channel });

    // Sin `handled: 'batch'`, sin `results`, sin `anchor_index`: el cuerpo del
    // negocio con sus dos añadidos de siempre.
    expect(processed?.body).toEqual({
      ok: true,
      handled: 'ignored',
      result: 'ignored',
      agent_history: 'persisted',
      agent_turn: 'replied',
    });
    expect(spy.turns).toHaveLength(1);
    expect(spy.turns[0].providerMessageId).toBe('wamid.SOLO');
  });

  it('1 · sin Agent Core inyectado el cuerpo individual tampoco cambia', async () => {
    const raw = JSON.stringify(envelope({ wamid: 'wamid.SOLO' }));

    const res = await handleKapsoWebhook(params(events, raw));

    expect(res.body).toEqual({ ok: true, handled: 'ignored', result: 'ignored' });
  });
});

// ── 10/11/12/17: idempotencia y recuperación ────────────────────────────────

describe('lotes — un mensaje se atiende una vez, llegue como llegue', () => {
  it('10 · el mismo lote con la MISMA clave: duplicate, sin reproceso', async () => {
    const spy = spyChannel();
    const raw = batchBody([envelope({ wamid: 'wamid.A' }), envelope({ wamid: 'wamid.B' })]);

    await deliver(raw, { agentChannel: spy.channel }, 'entrega-1');
    const repetido = await acceptKapsoWebhook(
      params(events, raw, { agentChannel: spy.channel }, 'entrega-1'),
    );

    expect(repetido.body).toEqual({ ok: true, duplicate: true });
    expect(repetido.pending).toBeNull();
    expect(spy.persisted).toHaveLength(2);
    expect(spy.turns).toHaveLength(1);
  });

  it('12 · otra clave con los MISMOS wamid: otra fila de transporte, mismos efectos', async () => {
    // `webhook_events` deduplica por CLAVE, no por WAMID. Con otra clave el
    // lote se procesa de verdad; quien impide duplicar son los UNIQUE de abajo,
    // que aquí se ven como `duplicate` en cada puerta.
    const spy = spyChannel();
    const raw = batchBody([envelope({ wamid: 'wamid.A' }), envelope({ wamid: 'wamid.B' })]);

    await deliver(raw, { agentChannel: spy.channel }, 'entrega-A');
    await deliver(raw, { agentChannel: spy.channel }, 'entrega-B');

    // Dos filas de transporte, las dos cerradas.
    expect(events.rows.size).toBe(2);
    expect(events.statuses()).toEqual(['processed', 'processed']);
    // El webhook vuelve a llamar a las puertas con los MISMOS wamid: son ellas
    // —no esta capa— las que deduplican, y aquí se comprueba que reciben la
    // clave correcta para poder hacerlo.
    expect(spy.persisted.map((m) => m.providerMessageId)).toEqual([
      'wamid.A',
      'wamid.B',
      'wamid.A',
      'wamid.B',
    ]);
    expect(spy.turns.map((m) => m.providerMessageId)).toEqual(['wamid.B', 'wamid.B']);
  });

  it('11 · fallback de Kapso a entrega individual: mismos wamid, mismo ancla', async () => {
    // Si el lote agota sus reintentos, Kapso entrega los mensajes sueltos. Cada
    // uno llega con SU wamid, así que las barreras de abajo reconocen los que ya
    // se atendieron y el turno se reclama por el mismo `source_message_id`.
    const spy = spyChannel();
    const lote = batchBody([envelope({ wamid: 'wamid.A' }), envelope({ wamid: 'wamid.B', text: 'Y bebidas?' })]);

    await deliver(lote, { agentChannel: spy.channel }, 'lote');
    await deliver(JSON.stringify(envelope({ wamid: 'wamid.A' })), { agentChannel: spy.channel }, 'suelto-A');
    await deliver(
      JSON.stringify(envelope({ wamid: 'wamid.B', text: 'Y bebidas?' })),
      { agentChannel: spy.channel },
      'suelto-B',
    );

    // El turno del lote y el del reenvío suelto de B apuntan al MISMO wamid: es
    // el UNIQUE de `agent_runs.source_message_id` el que impide el segundo run.
    expect(spy.turns.map((m) => m.providerMessageId)).toEqual([
      'wamid.B',
      'wamid.A',
      'wamid.B',
    ]);
    expect(spy.persisted).toHaveLength(4);
  });

  it('17 · el recovery reprocesa el lote entero sin cambiar el ancla', async () => {
    // Un lote es UNA fila durable. Si `after()` no llega a correr, el worker la
    // recoge y ejecuta el mismo negocio: N persistencias y UN turno, con el
    // mismo ancla. Los WAMID son los mismos, así que las barreras enganchan.
    const spy = spyChannel();
    const raw = batchBody([
      envelope({ wamid: 'wamid.A', text: 'Hola' }),
      envelope({ wamid: 'wamid.B', text: 'qué hamburguesas hay?' }),
    ]);
    const p = params(events, raw, { agentChannel: spy.channel });

    const accepted = await acceptKapsoWebhook(p);
    // Nadie procesó: es lo que pasa si la invocación muere tras el 200.
    expect(spy.persisted).toEqual([]);
    expect(events.rows.size).toBe(1);

    const tick = await runInboxTick({ selector: events, processing: p });

    expect(tick).toMatchObject({ claimed: 1, processed: 1, failed: 0 });
    expect(events.rows.get(accepted.pending!.rowId)!.status).toBe('processed');
    expect(spy.persisted.map((m) => m.providerMessageId)).toEqual(['wamid.A', 'wamid.B']);
    expect(spy.turns).toHaveLength(1);
    expect(spy.turns[0].providerMessageId).toBe('wamid.B');
  });

  it('un lote es UNA fila durable, no N', async () => {
    const spy = spyChannel();
    const raw = batchBody([
      envelope({ wamid: 'wamid.A' }),
      envelope({ wamid: 'wamid.B' }),
      envelope({ wamid: 'wamid.C' }),
    ]);

    await deliver(raw, { agentChannel: spy.channel });

    expect(events.rows.size).toBe(1);
    expect(spy.persisted).toHaveLength(3);
  });
});

// ── Un WAMID ya consumido no puede tapar a uno nuevo ────────────────────────

/**
 * El riesgo: `claimRun` para al encontrar el run ya reclamado y devuelve
 * `duplicate` SIN responder. Si el ancla cayera en un WAMID ya consumido, el
 * mensaje nuevo del lote quedaría persistido y sin contestar — y en silencio,
 * porque todo lo demás saldría en verde.
 *
 * Kapso puede reentregar mezclando: un lote que reintenta puede traer un
 * mensaje ya procesado junto a uno que no lo estaba. Y `data[]` no viene
 * ordenado por novedad, así que el viejo puede perfectamente ir el último.
 */
function canalConHistoria(yaProcesados: readonly string[]) {
  const spy = spyChannel();
  const base = spy.channel.runAgentTurn!;
  const consumidos = new Set(yaProcesados);

  const channel: AgentChannelPort = {
    ...spy.channel,
    async persistCustomerInbound(message) {
      const visto = consumidos.has(message.providerMessageId ?? '');
      await spy.channel.persistCustomerInbound(message);
      // El UNIQUE de `agent_messages.provider_message_id`: lo ya visto vuelve
      // como duplicado.
      return { result: visto ? 'duplicate' : 'persisted', conversationId: 'conv-uuid' };
    },
    async runAgentTurn(message): Promise<AgentTurnResult> {
      const res = await base(message);
      // El UNIQUE de `agent_runs.source_message_id`: un WAMID consumido no
      // vuelve a llamar al modelo ni responde.
      return consumidos.has(message.providerMessageId ?? '')
        ? { result: 'duplicate', runId: 'run-viejo', status: 'completed' }
        : res;
    },
  };

  return { ...spy, channel };
}

describe('lotes — un WAMID ya consumido no deja al nuevo sin respuesta', () => {
  const VIEJO = 'wamid.VIEJO';
  const NUEVO = 'wamid.NUEVO';

  it('A · [nuevo, viejo]: el ancla es el NUEVO aunque el viejo vaya último', async () => {
    const spy = canalConHistoria([VIEJO]);
    const raw = batchBody([
      envelope({ wamid: NUEVO, text: 'y qué bebidas tienen?' }),
      envelope({ wamid: VIEJO, text: 'hola' }),
    ]);

    const { processed } = await deliver(raw, { agentChannel: spy.channel });

    // Los dos se persisten; el viejo vuelve como duplicado y no se duplica.
    expect(spy.persisted.map((m) => m.providerMessageId)).toEqual([NUEVO, VIEJO]);
    // Y el turno se ancla en el nuevo: si cayera en el viejo, `claimRun` diría
    // `duplicate` y la pregunta se quedaría sin contestar para siempre.
    expect(spy.turns).toHaveLength(1);
    expect(spy.turns[0].providerMessageId).toBe(NUEVO);
    expect(processed?.body).toMatchObject({ anchor_index: 0, agent_turn: 'replied' });
  });

  it('B · [viejo, nuevo]: el ancla sigue siendo el último por posición', async () => {
    const spy = canalConHistoria([VIEJO]);
    const raw = batchBody([
      envelope({ wamid: VIEJO, text: 'hola' }),
      envelope({ wamid: NUEVO, text: 'y qué bebidas tienen?' }),
    ]);

    const { processed } = await deliver(raw, { agentChannel: spy.channel });

    expect(spy.turns.map((m) => m.providerMessageId)).toEqual([NUEVO]);
    expect(processed?.body).toMatchObject({ anchor_index: 1 });
  });

  it('C · [viejo, viejo]: cero trabajo nuevo, y el turno no responde', async () => {
    const spy = canalConHistoria(['wamid.V1', 'wamid.V2']);
    const raw = batchBody([
      envelope({ wamid: 'wamid.V1', text: 'hola' }),
      envelope({ wamid: 'wamid.V2', text: 'qué hamburguesas hay?' }),
    ]);

    const { processed } = await deliver(raw, { agentChannel: spy.channel });

    // Sin nada nuevo se ancla igualmente en el último elegible — que es lo que
    // conserva la reparación de una ejecución a medias— y es `claimRun` quien
    // corta. Cero runs nuevos, cero efectos.
    expect(spy.turns).toHaveLength(1);
    expect(spy.turns[0].providerMessageId).toBe('wamid.V2');
    expect(processed?.body).toMatchObject({ agent_turn: 'duplicate' });
  });

  it('D · [nuevo, nuevo, viejo]: un turno, anclado en el último NUEVO', async () => {
    const spy = canalConHistoria([VIEJO]);
    const raw = batchBody([
      envelope({ wamid: 'wamid.N1', text: 'hola' }),
      envelope({ wamid: 'wamid.N2', text: 'qué hamburguesas hay?' }),
      envelope({ wamid: VIEJO, text: 'buenas' }),
    ]);

    const { processed } = await deliver(raw, { agentChannel: spy.channel });

    // La ráfaga nueva entera se persiste: los dos entran en el contexto por sí
    // solos, en orden, sin que haga falta vincularlos a nada.
    expect(spy.persisted.map((m) => m.providerMessageId)).toEqual([
      'wamid.N1',
      'wamid.N2',
      VIEJO,
    ]);
    expect(spy.turns).toHaveLength(1);
    expect(spy.turns[0].providerMessageId).toBe('wamid.N2');
    expect(processed?.body).toMatchObject({ anchor_index: 1, agent_turn: 'replied' });
  });

  it('la reparación se conserva: un duplicado sin run hecho SÍ se ancla', async () => {
    // El contrapeso que impide "arreglar" esto excluyendo todo duplicado. Aquí
    // el mensaje ya estaba persistido —la ejecución anterior murió justo
    // después— pero su turno nunca llegó a reclamarse. Excluirlo por duplicado
    // dejaría al cliente sin respuesta para siempre.
    const spy = spyChannel();
    const channel: AgentChannelPort = {
      ...spy.channel,
      async persistCustomerInbound(message) {
        await spy.channel.persistCustomerInbound(message);
        return { result: 'duplicate', conversationId: 'conv-uuid' };
      },
    };
    const raw = batchBody([envelope({ wamid: 'wamid.A', text: 'qué hamburguesas hay?' })]);

    const { processed } = await deliver(raw, { agentChannel: channel });

    expect(spy.turns.map((m) => m.providerMessageId)).toEqual(['wamid.A']);
    expect(processed?.body).toMatchObject({ anchor_index: 0, agent_turn: 'replied' });
  });

  it('la novedad NO sustituye a la clasificación: un determinístico nuevo no ancla', async () => {
    // Persistirse no es ser accionable. Una ubicación recién llegada es lo más
    // "nuevo" del lote y aun así el turno no puede anclarse en ella: ya la
    // atendió su ruta.
    const spy = canalConHistoria([VIEJO]);
    const raw = batchBody([
      envelope({ wamid: VIEJO, text: 'hola' }),
      locationEnvelope('wamid.LOC_NUEVA'),
    ]);

    const { processed } = await deliver(raw, {
      agentChannel: spy.channel,
      attachOrderLocation: spy.attachOrderLocation,
    });

    expect(processed?.body).toMatchObject({ anchor_index: 0 });
    expect(spy.turns[0].providerMessageId).toBe(VIEJO);
    expect(spy.attached).toEqual([PHONE_DIGITS]);
  });
});

// ── 8: concurrencia ─────────────────────────────────────────────────────────

describe('lotes — concurrencia', () => {
  it('dos ejecuciones del mismo lote: solo una reclama la fila', async () => {
    // La autoridad sigue siendo el claim de la base, no un candado en memoria:
    // dos invocaciones simultáneas no pueden persistir la ráfaga dos veces.
    const spy = spyChannel();
    const raw = batchBody([envelope({ wamid: 'wamid.A' }), envelope({ wamid: 'wamid.B' })]);
    const p = params(events, raw, { agentChannel: spy.channel });

    const accepted = await acceptKapsoWebhook(p);
    const [a, b] = await Promise.all([
      processWebhookEvent(accepted.pending!.rowId, p),
      processWebhookEvent(accepted.pending!.rowId, p),
    ]);

    const outcomes = [a.outcome, b.outcome].sort();
    expect(outcomes).toEqual(['in_progress', 'processed']);
    expect(spy.persisted).toHaveLength(2);
    expect(spy.turns).toHaveLength(1);
  });

  it('dos lotes distintos de la misma conversación se procesan los dos', async () => {
    // Contrapunto: la protección es por entrega y por WAMID, no un cerrojo por
    // conversación que dejaría ráfagas sin contestar.
    const spy = spyChannel();
    const primero = batchBody([envelope({ wamid: 'wamid.A', text: 'Hola' })]);
    const segundo = batchBody([envelope({ wamid: 'wamid.B', text: 'Y bebidas?' })]);

    await Promise.all([
      deliver(primero, { agentChannel: spy.channel }, 'lote-1'),
      deliver(segundo, { agentChannel: spy.channel }, 'lote-2'),
    ]);

    expect(spy.persisted.map((m) => m.providerMessageId).sort()).toEqual(['wamid.A', 'wamid.B']);
    expect(spy.turns).toHaveLength(2);
  });
});

// ── 5C.4: la reacción es un evento de canal, no un turno ────────────────────

/**
 * REACCIONES (Fase 6D.2F.5C.4).
 *
 * Antes de 5C.4 una reacción suelta llegaba a `runAgentTurn` y salía por el gate
 * de contenido del core: el desenlace era el correcto pero por rebote. Aquí se
 * prueba lo contrario — que el Agent Core NI SIQUIERA se llama, porque la
 * decisión se toma por lo que la reacción es, no por lo que el core opine de su
 * contenido.
 *
 * Y la otra mitad, que es la que se vio en Production: la frase que Kapso
 * redacta ("Reacted with ❤️ to message wamid…") no puede acabar en `content`,
 * porque de ahí saltaría al contexto del modelo como palabras del cliente.
 */
describe('reacciones — silencio explícito', () => {
  it('6/7/8 · A) una reacción sola: 0 llamadas al Agent Core, 0 run, 0 efecto', async () => {
    const spy = spyChannel();
    const raw = batchBody([reactionEnvelope('wamid.R1')]);

    const { processed } = await deliver(raw, { agentChannel: spy.channel, sendMenuCta: NEVER_CTA });

    // Persistida: el historial no pierde nada.
    expect(spy.persisted.map((m) => m.providerMessageId)).toEqual(['wamid.R1']);
    // Pero el turno no se intenta siquiera.
    expect(spy.turns).toEqual([]);
    expect(processed?.body).toMatchObject({ anchor_index: null, batch_size: 1 });
    expect(processed?.body).not.toHaveProperty('agent_turn');
    expect(processed?.outcome).toBe('processed');
  });

  it('5 · la frase de Kapso no se persiste como texto del cliente', async () => {
    const spy = spyChannel();
    const raw = batchBody([reactionEnvelope('wamid.R1', 'wamid.TARGET')]);

    await deliver(raw, { agentChannel: spy.channel });

    const [reaccion] = spy.persisted;
    expect(reaccion.content).toBeNull();
    expect(reaccion.contentType).toBe('unknown');
    expect(reaccion.metadata).toEqual({
      channel_event: 'reaction',
      reaction: { operation: 'add', emoji: '❤️', target_message_id: 'wamid.TARGET' },
    });
    // Ni rastro del copy del proveedor en lo que se guarda.
    expect(JSON.stringify(reaccion)).not.toContain('Reacted with');
  });

  it('11 · B) [texto, reacción]: la reacción se persiste y el texto ancla', async () => {
    const spy = spyChannel();
    const raw = batchBody([
      envelope({ wamid: 'wamid.T1', text: 'qué hamburguesas hay?' }),
      reactionEnvelope('wamid.R1'),
    ]);

    const { processed } = await deliver(raw, { agentChannel: spy.channel });

    expect(spy.persisted.map((m) => m.providerMessageId)).toEqual(['wamid.T1', 'wamid.R1']);
    expect(spy.turns.map((m) => m.providerMessageId)).toEqual(['wamid.T1']);
    expect(processed?.body).toMatchObject({ anchor_index: 0 });
  });

  it('12 · C) [reacción, texto]: ancla el texto, exactamente un turno', async () => {
    const spy = spyChannel();
    const raw = batchBody([
      reactionEnvelope('wamid.R1'),
      envelope({ wamid: 'wamid.T1', text: 'y bebidas?' }),
    ]);

    const { processed } = await deliver(raw, { agentChannel: spy.channel });

    expect(spy.turns.map((m) => m.providerMessageId)).toEqual(['wamid.T1']);
    expect(processed?.body).toMatchObject({ anchor_index: 1 });
  });

  it('13 · D) [texto, reacción, texto]: ancla el último texto y la reacción no aporta contenido', async () => {
    const spy = spyChannel();
    const raw = batchBody([
      envelope({ wamid: 'wamid.T1', text: 'hola' }),
      reactionEnvelope('wamid.R1'),
      envelope({ wamid: 'wamid.T2', text: 'qué hamburguesas hay?' }),
    ]);

    const { processed } = await deliver(raw, { agentChannel: spy.channel });

    expect(processed?.body).toMatchObject({ anchor_index: 2 });
    expect(spy.turns.map((m) => m.providerMessageId)).toEqual(['wamid.T2']);

    // Los tres quedan en el historial y en orden; lo que el contexto podrá leer
    // son los dos textos, porque la reacción se guardó sin contenido.
    expect(spy.persisted.map((m) => m.content)).toEqual(['hola', null, 'qué hamburguesas hay?']);
    expect(JSON.stringify(spy.persisted)).not.toContain('Reacted with');
  });

  it('14 · E) [add, remove]: dos eventos con WAMID propios y ningún turno', async () => {
    const spy = spyChannel();
    const raw = batchBody([
      reactionEnvelope('wamid.R_ADD', 'wamid.TARGET'),
      reactionRemovedEnvelope('wamid.R_DEL', 'wamid.TARGET'),
    ]);

    const { processed } = await deliver(raw, { agentChannel: spy.channel });

    // Mismo target, dos WAMID: son dos hechos distintos y los dos se guardan.
    // No se deduplica por target — poner y quitar es legítimo, y repetirlo también.
    expect(spy.persisted.map((m) => m.providerMessageId)).toEqual(['wamid.R_ADD', 'wamid.R_DEL']);
    expect(spy.persisted.map((m) => m.metadata)).toEqual([
      {
        channel_event: 'reaction',
        reaction: { operation: 'add', emoji: '❤️', target_message_id: 'wamid.TARGET' },
      },
      {
        channel_event: 'reaction',
        reaction: { operation: 'remove', target_message_id: 'wamid.TARGET' },
      },
    ]);
    expect(spy.turns).toEqual([]);
    expect(processed?.body).toMatchObject({ anchor_index: null });
  });

  it('9 · el mismo WAMID de reacción reentregado no duplica historial', async () => {
    // Otra clave de entrega, mismo WAMID: el UNIQUE parcial de
    // `agent_messages.provider_message_id` lo convierte en `duplicate`.
    const spy = canalConHistoria(['wamid.R1']);
    const raw = batchBody([reactionEnvelope('wamid.R1')]);

    const { processed } = await deliver(raw, { agentChannel: spy.channel }, 'idem-reentrega');

    const results = (processed?.body as { results: { agent_history: string }[] }).results;
    expect(results[0].agent_history).toBe('duplicate');
    expect(spy.turns).toEqual([]);
  });

  it('una reacción suelta, SIN lote, también calla', async () => {
    // El camino individual es un lote de uno: mismo recorrido, misma decisión.
    const spy = spyChannel();
    const raw = JSON.stringify(reactionEnvelope('wamid.R1'));

    const { processed } = await deliver(raw, { agentChannel: spy.channel });

    expect(spy.persisted.map((m) => m.providerMessageId)).toEqual(['wamid.R1']);
    expect(spy.turns).toEqual([]);
    expect(processed?.body).not.toHaveProperty('agent_turn');
    expect(processed?.outcome).toBe('processed');
  });

  it('una foto suelta SIGUE llegando al turno: la excepción es solo la reacción', async () => {
    // Guardia contra la generalización fácil. Si esto dejara de llegar al Agent
    // Core, 5C.5 empezaría desde un sistema distinto del que dejó 5C.2.
    const spy = spyChannel();
    const raw = JSON.stringify(
      envelope({
        message: {
          id: 'wamid.IMG',
          type: 'image',
          image: { id: 'media-1' },
          from: PHONE_RAW,
          timestamp: 1_760_000_000,
          kapso: { direction: 'inbound', origin: 'business_app', status: 'received' },
        },
      }),
    );

    const { processed } = await deliver(raw, { agentChannel: spy.channel });

    expect(spy.turns.map((m) => m.providerMessageId)).toEqual(['wamid.IMG']);
    expect(processed?.outcome).toBe('processed');
  });
});

// ── 5C.5: imágenes en el lote ───────────────────────────────────────────────

/**
 * Sobre de IMAGEN con la forma REAL capturada en Production: WAMID propio,
 * `image.{id,url,link,sha256,mime_type}` y el bloque `kapso` con su frase
 * compuesta. Esa frase se conserva porque es lo que no puede acabar en
 * `content`.
 */
function imageEnvelope(
  wamid = 'wamid.IMG',
  caption: string | null = null,
  mediaId = 'media-1',
): Record<string, unknown> {
  const image: Record<string, unknown> = {
    id: mediaId,
    url: 'https://lookaside.example/whatsapp/x',
    link: 'https://api.kapso.example/media/tok',
    sha256: 'c0ffee',
    mime_type: 'image/jpeg',
  };
  if (caption !== null) image.caption = caption;

  return envelope({
    message: {
      id: wamid,
      type: 'image',
      from: PHONE_RAW,
      timestamp: 1_760_000_000,
      image,
      kapso: {
        direction: 'inbound',
        origin: 'business_app',
        status: 'received',
        has_media: true,
        media_url: 'https://api.kapso.example/media/tok',
        media_data: {
          url: 'https://api.kapso.example/media/tok',
          filename: 'foto.jpg',
          byte_size: 70332,
          content_type: 'image/jpeg',
        },
        content: `${caption ?? ''} Image attached (foto.jpg, 70332 bytes, image/jpeg) URL: https://api.kapso.example/media/tok`,
        message_type_data: { caption: caption ?? '', has_media: true },
      },
    },
  });
}

/** Canal que además guarda el BURST con el que se llamó al turno. */
function spyChannelConBurst() {
  const spy = spyChannel();
  const bursts: (readonly ProvenanceMessage[] | undefined)[] = [];

  const channel: AgentChannelPort = {
    ...spy.channel,
    async runAgentTurn(message, burst) {
      bursts.push(burst);
      return spy.channel.runAgentTurn!(message, burst);
    },
  };

  return { ...spy, channel, bursts };
}

describe('lotes — imágenes (5C.5)', () => {
  it('6 · una imagen sola es elegible y abre turno', async () => {
    const spy = spyChannelConBurst();
    const raw = batchBody([imageEnvelope('wamid.IMG1')]);

    const { processed } = await deliver(raw, { agentChannel: spy.channel });

    expect(spy.turns.map((m) => m.providerMessageId)).toEqual(['wamid.IMG1']);
    expect(processed?.body).toMatchObject({ anchor_index: 0 });
    const results = (processed?.body as { results: { kind: string }[] }).results;
    expect(results.map((r) => r.kind)).toEqual(['eligible']);
  });

  it('la frase de Kapso no se persiste como texto del cliente', async () => {
    const spy = spyChannelConBurst();
    const raw = batchBody([imageEnvelope('wamid.IMG1')]);

    await deliver(raw, { agentChannel: spy.channel });

    const [imagen] = spy.persisted;
    expect(imagen.content).toBeNull();
    expect(imagen.contentType).toBe('image');
    expect(imagen.metadata).toEqual({
      channel_event: 'image',
      media: {
        media_id: 'media-1',
        sha256: 'c0ffee',
        mime_type: 'image/jpeg',
        byte_size: 70332,
        filename: 'foto.jpg',
      },
    });
    // Ni la frase compuesta ni ninguna URL en lo que se guarda.
    expect(JSON.stringify(imagen.metadata)).not.toContain('Image attached');
    expect(JSON.stringify(imagen.metadata)).not.toContain('http');
  });

  it('el caption sí se persiste como content', async () => {
    const spy = spyChannelConBurst();
    const raw = batchBody([imageEnvelope('wamid.IMG1', 'Que hamburguesa es esta?')]);

    await deliver(raw, { agentChannel: spy.channel });

    expect(spy.persisted[0].content).toBe('Que hamburguesa es esta?');
  });

  it('8 · [imagen, texto]: un solo turno, anclado en el texto', async () => {
    const spy = spyChannelConBurst();
    const raw = batchBody([
      imageEnvelope('wamid.IMG1'),
      envelope({ wamid: 'wamid.T1', text: 'que hamburguesa es esta?' }),
    ]);

    const { processed } = await deliver(raw, { agentChannel: spy.channel });

    expect(spy.turns).toHaveLength(1);
    expect(spy.turns[0].providerMessageId).toBe('wamid.T1');
    expect(processed?.body).toMatchObject({ anchor_index: 1 });
    // Y el turno recibió el burst COMPLETO: la foto está en el otro elemento.
    expect(spy.bursts[0]?.map((m) => m.providerMessageId)).toEqual(['wamid.IMG1', 'wamid.T1']);
  });

  it('9 · [texto, imagen]: un solo turno, anclado en la imagen', async () => {
    const spy = spyChannelConBurst();
    const raw = batchBody([
      envelope({ wamid: 'wamid.T1', text: 'mira esto' }),
      imageEnvelope('wamid.IMG1'),
    ]);

    const { processed } = await deliver(raw, { agentChannel: spy.channel });

    expect(spy.turns).toHaveLength(1);
    expect(processed?.body).toMatchObject({ anchor_index: 1 });
    expect(spy.bursts[0]?.map((m) => m.providerMessageId)).toEqual(['wamid.T1', 'wamid.IMG1']);
  });

  it('10 · [texto, imagen, texto]: un turno, ancla el último texto', async () => {
    const spy = spyChannelConBurst();
    const raw = batchBody([
      envelope({ wamid: 'wamid.T1', text: 'hola' }),
      imageEnvelope('wamid.IMG1'),
      envelope({ wamid: 'wamid.T2', text: 'que es esto?' }),
    ]);

    const { processed } = await deliver(raw, { agentChannel: spy.channel });

    expect(spy.turns).toHaveLength(1);
    expect(processed?.body).toMatchObject({ anchor_index: 2 });
    expect(spy.bursts[0]?.map((m) => m.providerMessageId)).toEqual([
      'wamid.T1',
      'wamid.IMG1',
      'wamid.T2',
    ]);
  });

  it('11/12 · dos imágenes + texto: UN turno y el orden de data[] intacto', async () => {
    const spy = spyChannelConBurst();
    const raw = batchBody([
      imageEnvelope('wamid.IMG1', null, 'media-1'),
      imageEnvelope('wamid.IMG2', null, 'media-2'),
      envelope({ wamid: 'wamid.T1', text: 'cual es cual?' }),
    ]);

    const { processed } = await deliver(raw, { agentChannel: spy.channel });

    // Tres mensajes, tres filas, UN turno.
    expect(spy.persisted.map((m) => m.providerMessageId)).toEqual([
      'wamid.IMG1',
      'wamid.IMG2',
      'wamid.T1',
    ]);
    expect(spy.turns).toHaveLength(1);
    expect(processed?.body).toMatchObject({ anchor_index: 2 });
    expect(spy.bursts[0]?.map((m) => m.providerMessageId)).toEqual([
      'wamid.IMG1',
      'wamid.IMG2',
      'wamid.T1',
    ]);
  });

  it('14 · el MISMO archivo con otro WAMID son dos mensajes válidos', async () => {
    // Las dos capturas reales compartían sha256 y byte_size. Deduplicar por
    // hash borraría un mensaje que el cliente mandó de verdad.
    const spy = spyChannelConBurst();
    const raw = batchBody([
      imageEnvelope('wamid.IMG1', null, 'media-1'),
      imageEnvelope('wamid.IMG2', null, 'media-2'),
    ]);

    await deliver(raw, { agentChannel: spy.channel });

    expect(spy.persisted).toHaveLength(2);
    const hashes = spy.persisted.map(
      (m) => (m.metadata?.media as Record<string, unknown>).sha256,
    );
    expect(hashes[0]).toBe(hashes[1]);
  });

  it('13 · el mismo WAMID de imagen reentregado no duplica historial', async () => {
    const spy = canalConHistoria(['wamid.IMG1']);
    const raw = batchBody([imageEnvelope('wamid.IMG1')]);

    const { processed } = await deliver(raw, { agentChannel: spy.channel }, 'idem-img');

    const results = (processed?.body as { results: { agent_history: string }[] }).results;
    expect(results[0].agent_history).toBe('duplicate');
  });

  it('una imagen suelta, SIN lote, recorre el mismo camino', async () => {
    const spy = spyChannelConBurst();
    const raw = JSON.stringify(imageEnvelope('wamid.IMG1'));

    const { processed } = await deliver(raw, { agentChannel: spy.channel });

    expect(spy.turns.map((m) => m.providerMessageId)).toEqual(['wamid.IMG1']);
    expect(processed?.outcome).toBe('processed');
  });

  it('la reacción sigue sin anclar aunque ahora las imágenes sí', async () => {
    // Guardia de 5C.4: abrir la puerta a las imágenes no puede reabrirla para
    // los eventos de canal.
    const spy = spyChannelConBurst();
    const raw = batchBody([reactionEnvelope('wamid.R1')]);

    const { processed } = await deliver(raw, { agentChannel: spy.channel });

    expect(spy.turns).toEqual([]);
    expect(processed?.body).toMatchObject({ anchor_index: null });
  });
});
