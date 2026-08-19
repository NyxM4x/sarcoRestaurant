import { describe, it, expect, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  acceptKapsoWebhook,
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
import { WEBHOOK_LEASE_SECONDS } from './inbox';
import { FakeWebhookEventStore } from './fake-store';
import { runAgentTurn } from '@/lib/agent/core/run';
import { persistCustomerInbound } from '@/lib/agent/memory/persist-inbound';
import { createSendMenuTool, SEND_MENU, type MenuDispatchPort } from '@/lib/agent/tools/menu-tools';
import { createAnswerDirectlyAction } from '@/lib/agent/tools/answer-directly';
import type { AgentModel, AgentModelResult } from '@/lib/agent/core/model';
import type {
  AgentChannelPort,
  AgentConversationRef,
  AgentPauseState,
  AgentRunStore,
  AgentSendPort,
  AgentStore,
  ClaimAgentRunInput,
  ClaimAgentRunResult,
  FinishAgentRunInput,
  InsertAgentMessageInput,
  InsertMessageResult,
} from '@/lib/agent/core/types';
import type { ContextMessage } from '@/lib/agent/core/context';
import type { AgentRunStatus } from '@/types';
import type { DispatchMenuResult } from '@/lib/menu/dispatch';

/**
 * RECOVERY DEL INBOX × BARRERAS DEL AGENTE (Fase 6D.2F.5C.1).
 *
 * Lo que se prueba aquí no está probado en ningún otro sitio, y no es una suma
 * de lo que ya hay.
 *
 * `durable-ack.test.ts` demuestra que el transporte reclama, respeta el lease y
 * no reprocesa un terminal — pero lo hace con un canal de agente que solo cuenta
 * llamadas, así que no puede decir nada sobre los efectos.
 * `run.test.ts` y `dispatch.test.ts` demuestran que el run y el envío de menú
 * deduplican por WAMID — pero cada uno por su cuenta, invocado directamente.
 *
 * Lo que queda en medio es la COSTURA: que el camino de recuperación entregue el
 * MISMO `source_message_id` a esas barreras. Si el reproceso reconstruyera el
 * mensaje de otra forma —perdiendo el WAMID, por ejemplo— las barreras no
 * engancharían y el sistema duplicaría el efecto exactamente en el escenario
 * para el que existe el recovery. Cada mitad seguiría verde por separado.
 *
 * Por eso aquí se cablea el `runAgentTurn` REAL y el `send_menu` REAL sobre
 * dobles que reproducen los dos UNIQUE de 0014/0015:
 *   · agent_runs.source_message_id            UNIQUE
 *   · menu_send_deliveries.source_message_id  UNIQUE
 */

const SECRET = 'test-webhook-secret';
const PHONE_RAW = '+591 621-39119';
const PHONE_DIGITS = '59162139119';
const WAMID_IN = 'wamid.INBOUND_RECOVERY_1';
const MODEL = 'gpt-4.1-mini';

function sign(rawBody: string): string {
  return createHmac('sha256', SECRET).update(rawBody, 'utf8').digest('hex');
}

/** Entrante real del cliente: el mensaje del smoke de producción. */
function inboundBody(text = 'Que opciones tiene ?', wamid = WAMID_IN): string {
  return JSON.stringify({
    phone_number_id: 'pn-1',
    message: {
      id: wamid,
      type: 'text',
      text: { body: text },
      from: PHONE_RAW,
      timestamp: 1_760_000_000,
      kapso: { direction: 'inbound', origin: 'business_app', status: 'received' },
    },
    conversation: { id: 'kapso-conv-1', phone_number: PHONE_RAW },
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

// ── Doble del backend del agente ────────────────────────────────────────────

interface FakeRun {
  id: string;
  sourceMessageId: string;
  status: AgentRunStatus;
  model: string | null;
  toolRounds: number;
  skippedAtBarrier: string | null;
  errorCode: string | null;
}

interface FakeDelivery {
  sourceMessageId: string;
  reason: string;
  status: DispatchMenuResult['result'];
}

/**
 * Reproduce SOLO lo que el turno usa, y con los guards reales. Cada método que
 * no debería tocarse lanza, para que un cambio de camino se vea como un fallo y
 * no como un silencio.
 */
class FakeAgentBackend implements AgentStore, AgentRunStore {
  conversationId = 'conv-1';
  messages: InsertAgentMessageInput[] = [];
  runs: FakeRun[] = [];
  deliveries: FakeDelivery[] = [];
  /** Envíos REALES intentados contra el proveedor, duplicados incluidos. */
  dispatchAttempts = 0;
  private seq = 0;

  // ── AgentStore ────────────────────────────────────────────────────────────

  async upsertConversation(): Promise<AgentConversationRef> {
    return { id: this.conversationId, state: 'active' };
  }

  async insertMessage(input: InsertAgentMessageInput): Promise<InsertMessageResult> {
    // UNIQUE parcial de 0014 sobre provider_message_id.
    if (
      input.providerMessageId !== null &&
      this.messages.some((m) => m.providerMessageId === input.providerMessageId)
    ) {
      return 'duplicate';
    }
    this.messages.push(input);
    return 'inserted';
  }

  async touchCustomerMessageAt(): Promise<void> {}
  async touchHumanMessageAt(): Promise<void> {
    throw new Error('un entrante del cliente no toca marcas humanas');
  }
  async pauseConversation(): Promise<never> {
    throw new Error('el turno del agente jamás pausa');
  }
  async renewPause(): Promise<never> {
    throw new Error('el turno del agente jamás renueva una pausa');
  }
  async resumeConversation(): Promise<never> {
    throw new Error('el turno del agente jamás reanuda');
  }
  async insertControlEvent(): Promise<never> {
    throw new Error('el turno del agente no registra eventos de control');
  }
  async hasResumeEvent(): Promise<boolean> {
    return false;
  }
  async hasPauseEventForMessage(): Promise<boolean> {
    return false;
  }

  async findPauseStateByPhone(customerPhone: string): Promise<AgentPauseState | null> {
    if (customerPhone !== PHONE_DIGITS) return null;
    return {
      conversationId: this.conversationId,
      state: 'active',
      pausedAt: null,
      pauseExpiresAt: null,
      pauseReason: null,
      pauseSource: null,
      resumedAt: null,
    };
  }

  // ── AgentRunStore ─────────────────────────────────────────────────────────

  /**
   * `INSERT ... ON CONFLICT DO NOTHING` sobre el UNIQUE de `source_message_id`.
   * Es ATÓMICO a propósito: un comprobar-y-luego-insertar dejaría la ventana por
   * la que se colaría una segunda llamada a OpenAI.
   */
  async claimRun(input: ClaimAgentRunInput): Promise<ClaimAgentRunResult> {
    const existing = this.runs.find((r) => r.sourceMessageId === input.sourceMessageId);
    if (existing) {
      return { result: 'exists', runId: existing.id, status: existing.status };
    }
    const run: FakeRun = {
      id: `run-${++this.seq}`,
      sourceMessageId: input.sourceMessageId,
      status: 'processing',
      model: input.model,
      toolRounds: 0,
      skippedAtBarrier: null,
      errorCode: null,
    };
    this.runs.push(run);
    return { result: 'claimed', runId: run.id };
  }

  async markRunSending(runId: string): Promise<void> {
    const run = this.runs.find((r) => r.id === runId)!;
    if (run.status === 'processing') run.status = 'sending';
  }

  async finishRun(input: FinishAgentRunInput): Promise<void> {
    const run = this.runs.find((r) => r.id === input.runId)!;
    run.status = input.status;
    run.errorCode = input.errorCode ?? null;
    run.skippedAtBarrier = input.skippedAtBarrier ?? null;
    if (input.model !== undefined && input.model !== null) run.model = input.model;
    if (input.toolRounds !== undefined) run.toolRounds = input.toolRounds;
  }

  async loadRecentMessages(): Promise<ContextMessage[]> {
    return this.messages
      .filter((m) => m.content !== null)
      .map((m) => ({
        actor: m.actor as ContextMessage['actor'],
        role: m.role as ContextMessage['role'],
        content: m.content,
        contentType: m.contentType as ContextMessage['contentType'],
        messageTimestamp: m.messageTimestamp,
        automationAction: null,
      }));
  }

  async findMessageIdByProviderMessageId(providerMessageId: string): Promise<string | null> {
    return this.messages.some((m) => m.providerMessageId === providerMessageId)
      ? `msg-${providerMessageId}`
      : null;
  }

  async touchAiMessageAt(): Promise<void> {}

  // ── Puerto del despacho de menú ───────────────────────────────────────────

  /**
   * UNIQUE de `menu_send_deliveries.source_message_id`: el claim ocurre ANTES
   * del efecto, así que un WAMID ya reclamado no gasta un segundo envío.
   */
  menuPort(): MenuDispatchPort {
    return {
      dispatch: async (input) => {
        const existing = this.deliveries.find(
          (d) => d.sourceMessageId === input.sourceMessageId,
        );
        if (existing) {
          return {
            result: 'duplicate',
            deliveryId: `deliv-${input.sourceMessageId}`,
            status: existing.status as 'sent',
          };
        }

        this.dispatchAttempts += 1;
        this.deliveries.push({
          sourceMessageId: input.sourceMessageId,
          reason: input.reason,
          status: 'sent',
        });
        // El CTA sale por el canal y queda anotado como mensaje del automatismo.
        await this.insertMessage({
          agentConversationId: this.conversationId,
          providerMessageId: `wamid.CTA_${input.sourceMessageId}`,
          providerConversationId: null,
          direction: 'outbound',
          role: 'assistant',
          actor: 'automation',
          content: 'Mirá el menú',
          contentType: 'interactive',
          metadata: { action: 'send_menu', resource_type: 'menu' },
          messageTimestamp: '2025-10-09T08:53:30.000Z',
        });
        return {
          result: 'sent',
          deliveryId: `deliv-${input.sourceMessageId}`,
          wamid: `wamid.CTA_${input.sourceMessageId}`,
        };
      },
    };
  }
}

/** El modelo elige `send_menu` en la ronda de selección. Nunca redacta texto. */
function selectorModel(): AgentModel & { calls: number } {
  const model = {
    model: MODEL,
    calls: 0,
    async complete(): Promise<AgentModelResult> {
      model.calls += 1;
      return {
        ok: true,
        text: '',
        model: MODEL,
        toolCalls: [{ callId: 'call-1', name: SEND_MENU, arguments: '{}' }],
      };
    },
  };
  return model;
}

const NEVER_SEND: AgentSendPort = {
  async sendText() {
    throw new Error('el efecto ES la respuesta: send_menu cierra el turno sin frase');
  },
};

/** Canal con el Agent Core REAL montado sobre el doble. */
function realChannel(backend: FakeAgentBackend, model: AgentModel): AgentChannelPort {
  return {
    persistCustomerInbound: (message) => persistCustomerInbound(message, backend),
    async handleHumanTakeover() {
      throw new Error('este escenario no lleva takeover');
    },
    runAgentTurn: (message) =>
      runAgentTurn(message, {
        store: backend,
        runs: backend,
        model,
        send: NEVER_SEND,
        config: { enabled: true, accessMode: 'allowlist', testPhones: [PHONE_DIGITS], hasApiKey: true },
        systemPrompt: 'Sos el asistente de La Fija.',
        actions: [createSendMenuTool(backend.menuPort()), createAnswerDirectlyAction()],
      }),
  };
}

const NOOP_CONFIRM: ConfirmOrder = async () => ({ result: 'not_found' });
const NOOP_ENSURE: EnsureLocationRequest = async () => ({ result: 'not_applicable' });
const NOOP_ATTACH: AttachOrderLocation = async () => ({ result: 'not_found' });
const NEVER_CTA: SendMenuCta = async () => {
  throw new Error('el CTA determinístico no interviene en este camino');
};

function params(
  store: FakeWebhookEventStore,
  rawBody: string,
  channel: AgentChannelPort,
  idempotencyKey = 'idem-1',
): HandleKapsoWebhookParams {
  return {
    rawBody,
    headers: headers(rawBody, idempotencyKey),
    secret: SECRET,
    store,
    confirmOrder: NOOP_CONFIRM,
    ensureLocationRequest: NOOP_ENSURE,
    attachOrderLocation: NOOP_ATTACH,
    sendMenuCta: NEVER_CTA,
    agentChannel: channel,
  };
}

/**
 * Falla UNA vez al CERRAR la fila, que es el único paso posterior al efecto.
 * Reproduce sin trucos el estado que deja una caída después de mandar el menú:
 * el negocio hecho y la fila todavía pendiente.
 */
class FlakyCloseStore extends FakeWebhookEventStore {
  private pendienteDeFallar = true;

  async markProcessed(id: string): Promise<void> {
    if (this.pendienteDeFallar) {
      this.pendienteDeFallar = false;
      throw new Error('supabase caída al cerrar la fila');
    }
    return super.markProcessed(id);
  }
}

let events: FakeWebhookEventStore;
let backend: FakeAgentBackend;
let model: AgentModel & { calls: number };
let channel: AgentChannelPort;

beforeEach(() => {
  events = new FakeWebhookEventStore();
  backend = new FakeAgentBackend();
  model = selectorModel();
  channel = realChannel(backend, model);
});

/** Los tres efectos que no pueden ocurrir dos veces, contados juntos. */
function efectos() {
  return {
    runs: backend.runs.length,
    deliveries: backend.deliveries.length,
    envios: backend.dispatchAttempts,
    ctas: backend.messages.filter((m) => m.actor === 'automation').length,
    entrantes: backend.messages.filter((m) => m.actor === 'customer').length,
    salientesAi: backend.messages.filter((m) => m.actor === 'ai').length,
  };
}

describe('recovery del inbox — el trabajo abandonado se termina UNA vez', () => {
  it('lease vencido: el worker reclama, el turno corre entero y deja un solo efecto', async () => {
    const raw = inboundBody();
    const p = params(events, raw, channel);

    // Se acepta y alguien la reclama... y muere. La fila queda en `processing`,
    // que es como se ve en la base una invocación que no volvió.
    const accepted = await acceptKapsoWebhook(p);
    await events.claimEvent(accepted.pending!.rowId, WEBHOOK_LEASE_SECONDS);
    expect(events.rows.get(accepted.pending!.rowId)!.status).toBe('processing');
    expect(efectos()).toMatchObject({ runs: 0, deliveries: 0 });

    // Vence el lease: un `processing` vencido ES trabajo abandonado.
    const base = Date.now();
    events.now = () => base + (WEBHOOK_LEASE_SECONDS + 1) * 1000;

    const tick = await runInboxTick({ selector: events, processing: p });

    expect(tick).toEqual({ ok: true, claimed: 1, processed: 1, failed: 0, budget_exhausted: false });
    expect(events.rows.get(accepted.pending!.rowId)!.status).toBe('processed');
    // UN resultado final: un run, un envío, un CTA. Y ninguna frase del agente.
    expect(efectos()).toEqual({
      runs: 1,
      deliveries: 1,
      envios: 1,
      ctas: 1,
      entrantes: 1,
      salientesAi: 0,
    });
    expect(backend.runs[0]).toMatchObject({ status: 'completed', toolRounds: 1, model: MODEL });
    expect(backend.deliveries[0].reason).toBe('agent_suggestion');
  });

  it('si el efecto YA ocurrió antes de morir, el recovery no lo repite', async () => {
    // El caso que más importa y el más difícil de ver: el menú ya salió y la
    // fila NO llegó a cerrarse. Para el transporte es trabajo pendiente; para el
    // cliente ya está hecho. Y no se fuerza a mano: se hace fallar el cierre,
    // que es el único paso que queda después del efecto.
    const flaky = new FlakyCloseStore();
    const p = params(flaky, inboundBody(), channel);

    const accepted = await acceptKapsoWebhook(p);
    const primero = await processWebhookEvent(accepted.pending!.rowId, p);

    // El negocio se hizo entero; lo que falló fue marcar la fila.
    expect(primero.outcome).toBe('failed');
    expect(flaky.rows.get(accepted.pending!.rowId)!.status).toBe('received');
    expect(efectos()).toMatchObject({ runs: 1, deliveries: 1, envios: 1 });
    const llamadasModelo = model.calls;

    // Llega su turno de reintento y el worker la recoge.
    const base = Date.now();
    flaky.now = () => base + 10 * 60 * 1000;
    const tick = await runInboxTick({ selector: flaky, processing: p });

    expect(tick).toMatchObject({ claimed: 1, processed: 1, failed: 0 });
    expect(flaky.rows.get(accepted.pending!.rowId)!.status).toBe('processed');
    // Ni un envío más, ni un run más, ni una llamada más al modelo: las tres
    // barreras enganchan porque el WAMID que llega es el mismo.
    expect(efectos()).toMatchObject({ runs: 1, deliveries: 1, envios: 1, ctas: 1 });
    expect(model.calls).toBe(llamadasModelo);
  });

  it('dos ticks concurrentes sobre la misma fila vencida: un solo efecto', async () => {
    const raw = inboundBody();
    const p = params(events, raw, channel);

    const accepted = await acceptKapsoWebhook(p);
    await events.claimEvent(accepted.pending!.rowId, WEBHOOK_LEASE_SECONDS);
    const base = Date.now();
    events.now = () => base + (WEBHOOK_LEASE_SECONDS + 1) * 1000;

    const [a, b] = await Promise.all([
      runInboxTick({ selector: events, processing: p }),
      runInboxTick({ selector: events, processing: p }),
    ]);

    // El reclamo es un UPDATE condicionado, no un SELECT seguido de UPDATE: solo
    // uno se lleva la fila y el otro no encuentra trabajo.
    expect(a.claimed + b.claimed).toBe(1);
    expect(a.processed + b.processed).toBe(1);
    expect(a.failed + b.failed).toBe(0);
    expect(efectos()).toMatchObject({ runs: 1, deliveries: 1, envios: 1, ctas: 1 });
  });

  it('otra clave de idempotencia del MISMO wamid tampoco duplica el efecto', async () => {
    // `webhook_events` deduplica por CLAVE, no por WAMID. Con otra clave el
    // evento se procesa de verdad: la única defensa son las barreras del
    // agente, y aquí se comprueba que llegan a activarse.
    const raw = inboundBody();
    const primera = params(events, raw, channel, 'entrega-A');
    const segunda = params(events, raw, channel, 'entrega-B');

    const a = await acceptKapsoWebhook(primera);
    await processWebhookEvent(a.pending!.rowId, primera);
    const b = await acceptKapsoWebhook(segunda);
    const res = await processWebhookEvent(b.pending!.rowId, segunda);

    // Dos filas de transporte, las dos cerradas.
    expect(events.rows.size).toBe(2);
    expect(events.statuses()).toEqual(['processed', 'processed']);
    expect(res.outcome).toBe('processed');
    // Un solo efecto.
    expect(efectos()).toMatchObject({ runs: 1, deliveries: 1, envios: 1, ctas: 1, entrantes: 1 });
  });

  it('la costura: el recovery entrega el MISMO wamid que el camino síncrono', async () => {
    // La afirmación de la que dependen todas las anteriores. Si el reproceso
    // reconstruyera el mensaje sin WAMID, las barreras no engancharían y cada
    // mitad del sistema seguiría verde por su cuenta.
    const raw = inboundBody();
    const p = params(events, raw, channel);

    const accepted = await acceptKapsoWebhook(p);
    await runInboxTick({ selector: events, processing: p });

    expect(backend.messages[0].providerMessageId).toBe(WAMID_IN);
    expect(backend.runs[0].sourceMessageId).toBe(WAMID_IN);
    expect(backend.deliveries[0].sourceMessageId).toBe(WAMID_IN);
    // Y el evento de transporte guardó ese wamid, que es por donde lo busca el
    // smoke de producción.
    expect(events.rows.get(accepted.pending!.rowId)!.messageId).toBe(WAMID_IN);
  });

  it('dos wamid distintos siguen siendo dos operaciones: la barrera no es un cierre', async () => {
    // Contrapunto imprescindible. Una idempotencia demasiado ancha se vería
    // igual de verde en todo lo anterior y dejaría al segundo cliente sin menú.
    const primero = inboundBody('Que opciones tiene ?', 'wamid.UNO');
    const segundo = inboundBody('Y que bebidas hay ?', 'wamid.DOS');

    const a = await acceptKapsoWebhook(params(events, primero, channel, 'k-1'));
    await runInboxTick({ selector: events, processing: params(events, primero, channel, 'k-1') });
    const b = await acceptKapsoWebhook(params(events, segundo, channel, 'k-2'));
    await runInboxTick({ selector: events, processing: params(events, segundo, channel, 'k-2') });

    expect(a.pending!.rowId).not.toBe(b.pending!.rowId);
    expect(efectos()).toMatchObject({ runs: 2, deliveries: 2, envios: 2, ctas: 2, entrantes: 2 });
  });
});
