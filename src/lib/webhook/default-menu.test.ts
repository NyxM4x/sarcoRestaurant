import { describe, it, expect, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  acceptKapsoWebhook,
  processWebhookEvent,
  KAPSO_PAYLOAD_VERSION,
  KAPSO_SUPPORTED_EVENT,
  type ConfirmOrder,
  type EnsureLocationRequest,
  type HandleKapsoWebhookParams,
  type LookupCustomerState,
  type SendMenuCta,
  type SendMenuCtaInput,
  type SendProofReminder,
} from './kapso';
import { FakeWebhookEventStore } from './fake-store';
import type { AgentChannelPort, AgentTurnResult } from '@/lib/agent/core/types';
import type { ProvenanceMessage } from '@/lib/kapso/channel/provenance';
import type { CustomerStateSnapshot } from './default-reply';

/**
 * EL BOTÓN COMO RESPUESTA POR DEFECTO — de extremo a extremo (03-09-2026).
 *
 * `default-reply.test.ts` prueba la DECISIÓN; esto prueba que el webhook la
 * ejecuta y en el sitio correcto: después de todas las puertas específicas,
 * una sola vez por entrega, y sin quitarle al agente lo que sigue siendo suyo.
 *
 * El caso que da nombre al archivo es la conversación real que lo originó:
 *
 *   "buenas" · "noches" · "a cuanto"  →  antes: "¿En qué puedo ayudarte?"
 *                                        ahora: el botón, una sola vez
 */

const SECRET = 'test-webhook-secret';
const PHONE_RAW = '+591 700-00001';
const PHONE_DIGITS = '59170000001';

function sign(rawBody: string): string {
  return createHmac('sha256', SECRET).update(rawBody, 'utf8').digest('hex');
}

function envelope(
  over: { wamid?: string; text?: string; message?: Record<string, unknown> } = {},
): Record<string, unknown> {
  return {
    phone_number_id: 'pn-1',
    is_new_conversation: false,
    message: over.message ?? {
      id: over.wamid ?? 'wamid.UNO',
      type: 'text',
      text: { body: over.text ?? 'a cuanto' },
      from: PHONE_RAW,
      timestamp: 1_760_000_000,
      kapso: { direction: 'inbound', origin: 'business_app', status: 'received' },
    },
    conversation: { id: 'kapso-conv-1', phone_number: PHONE_RAW },
  };
}

function batchBody(data: readonly Record<string, unknown>[]): string {
  return JSON.stringify({
    type: 'whatsapp.message.received',
    batch: true,
    data,
    batch_info: {
      size: data.length,
      window_ms: 5000,
      first_sequence: 1,
      last_sequence: data.length,
      conversation_id: 'kapso-conv-1',
    },
  });
}

function headers(rawBody: string, idempotencyKey: string) {
  return {
    signature: sign(rawBody),
    version: KAPSO_PAYLOAD_VERSION,
    event: KAPSO_SUPPORTED_EVENT,
    idempotencyKey,
  };
}

const NOOP_CONFIRM: ConfirmOrder = async () => ({ result: 'not_found' });
const NOOP_ENSURE: EnsureLocationRequest = async () => ({ result: 'not_applicable' });

const DESPEJADO: CustomerStateSnapshot = {
  paused: false,
  openOrder: null,
  proofRemindedRecently: false,
};

/** Cuenta los CTAs que salieron y con qué motivo y contexto. */
function spyCta() {
  const enviados: SendMenuCtaInput[] = [];
  const sendMenuCta: SendMenuCta = async (input) => {
    enviados.push(input);
    return { result: 'sent', deliveryId: `del-${enviados.length}`, wamid: `wamid.CTA${enviados.length}` };
  };
  return { sendMenuCta, enviados };
}

/** Cuenta los turnos del agente: lo que el determinístico atiende NO llega aquí. */
function spyChannel() {
  const turns: ProvenanceMessage[] = [];
  const channel: AgentChannelPort = {
    async persistCustomerInbound() {
      return { result: 'persisted', conversationId: 'conv-uuid' };
    },
    async handleHumanTakeover() {
      throw new Error('no aplica');
    },
    async runAgentTurn(message): Promise<AgentTurnResult> {
      turns.push(message);
      return { result: 'replied', runId: `run-${turns.length}` };
    },
  };
  return { channel, turns };
}

let events: FakeWebhookEventStore;
beforeEach(() => {
  events = new FakeWebhookEventStore();
});

async function deliver(
  rawBody: string,
  over: Partial<HandleKapsoWebhookParams>,
  key = 'idem-1',
) {
  const p: HandleKapsoWebhookParams = {
    rawBody,
    headers: headers(rawBody, key),
    secret: SECRET,
    store: events,
    confirmOrder: NOOP_CONFIRM,
    ensureLocationRequest: NOOP_ENSURE,
    attachOrderLocation: async () => ({ result: 'not_found' }),
    sendMenuCta: async () => {
      throw new Error('sendMenuCta no debía llamarse');
    },
    ...over,
  };
  const accepted = await acceptKapsoWebhook(p);
  if (!accepted.pending) return { accepted, processed: null };
  const processed = await processWebhookEvent(accepted.pending.rowId, p);
  return { accepted, processed };
}

const estado = (state: CustomerStateSnapshot | null): LookupCustomerState => async () => state;

describe('el botón por defecto', () => {
  it('un texto que ninguna puerta reconoce recibe el menú, y el agente no habla', async () => {
    const cta = spyCta();
    const agente = spyChannel();

    const { processed } = await deliver(JSON.stringify(envelope({ text: 'a cuanto' })), {
      sendMenuCta: cta.sendMenuCta,
      lookupCustomerState: estado(DESPEJADO),
      agentChannel: agente.channel,
    });

    expect(processed?.body).toMatchObject({ handled: 'menu_cta', result: 'sent' });
    expect(cta.enviados).toHaveLength(1);
    expect(cta.enviados[0].toDigits).toBe(PHONE_DIGITS);
    // El mensaje ya está atendido: pedirle además una frase al modelo sería
    // volver a la respuesta que este cambio vino a quitar.
    expect(agente.turns).toHaveLength(0);
  });

  it('el motivo del ledger sale del entrante REAL, no de quién disparó', async () => {
    const cta = spyCta();

    // "mandame la carta" nombra la carta pero NO está en `isMenuIntent`: llega
    // hasta el default, y aun así en el ledger tiene que constar como petición.
    await deliver(JSON.stringify(envelope({ text: 'mandame la carta' })), {
      sendMenuCta: cta.sendMenuCta,
      lookupCustomerState: estado(DESPEJADO),
    });

    expect(cta.enviados[0].reason).toBe('explicit_request');
  });

  it('el copy contesta lo que preguntó: un precio recibe el botón de precios', async () => {
    const cta = spyCta();

    await deliver(JSON.stringify(envelope({ text: 'cuanto esta el trancapechp' })), {
      sendMenuCta: cta.sendMenuCta,
      lookupCustomerState: estado(DESPEJADO),
    });

    expect(cta.enviados[0].ctaContext).toBe('price');
    expect(cta.enviados[0].reason).toBe('agent_suggestion');
  });

  it('una ráfaga entera produce UN botón, el del último mensaje', async () => {
    const cta = spyCta();
    const agente = spyChannel();

    // La conversación real: saludo, cierre del saludo, y la pregunta.
    const body = batchBody([
      envelope({ wamid: 'wamid.A', text: 'buenas' }),
      envelope({ wamid: 'wamid.B', text: 'noches' }),
      envelope({ wamid: 'wamid.C', text: 'a cuanto' }),
    ]);

    const { processed } = await deliver(body, {
      sendMenuCta: cta.sendMenuCta,
      lookupCustomerState: estado(DESPEJADO),
      agentChannel: agente.channel,
    });

    expect(cta.enviados).toHaveLength(1);
    expect(cta.enviados[0].sourceMessageId).toBe('wamid.C');
    expect(agente.turns).toHaveLength(0);
    expect(processed?.body).toMatchObject({ handled: 'batch', batch_size: 3 });
  });

  it('sin el puerto de estado no sale nada: el texto sigue cayendo en el agente', async () => {
    const agente = spyChannel();

    const { processed } = await deliver(JSON.stringify(envelope({ text: 'a cuanto' })), {
      agentChannel: agente.channel,
    });

    expect(processed?.body).toMatchObject({ handled: 'ignored' });
    expect(agente.turns).toHaveLength(1);
  });

  it('una foto no recibe botón: no es texto', async () => {
    const agente = spyChannel();
    const foto = envelope({
      message: {
        id: 'wamid.IMG',
        type: 'image',
        image: { id: 'media-1', mime_type: 'image/jpeg' },
        from: PHONE_RAW,
        timestamp: 1_760_000_000,
        kapso: { direction: 'inbound', origin: 'business_app', status: 'received' },
      },
    });

    const { processed } = await deliver(JSON.stringify(foto), {
      lookupCustomerState: estado(DESPEJADO),
      agentChannel: agente.channel,
    });

    expect(processed?.body).toMatchObject({ handled: 'ignored' });
  });
});

describe('las excepciones, ejecutadas', () => {
  it('con un humano atendiendo no sale ningún botón', async () => {
    const cta = spyCta();
    const agente = spyChannel();

    const { processed } = await deliver(JSON.stringify(envelope({ text: 'en efectivo' })), {
      sendMenuCta: cta.sendMenuCta,
      lookupCustomerState: estado({ ...DESPEJADO, paused: true }),
      agentChannel: agente.channel,
    });

    expect(cta.enviados).toHaveLength(0);
    // Sigue su camino hacia el agente, que tiene su propia barrera de pausa y
    // se callará también. Lo que aquí importa es que el determinístico no habló.
    expect(processed?.body).toMatchObject({ handled: 'ignored' });
  });

  it('el que ya tiene su QR recibe el recordatorio del comprobante, no el menú', async () => {
    const cta = spyCta();
    const recordatorios: Array<{ orderNumber: string; totalAmount: number }> = [];
    const sendProofReminder: SendProofReminder = async (input) => {
      recordatorios.push({ orderNumber: input.orderNumber, totalAmount: input.totalAmount });
      return { ok: true };
    };

    const { processed } = await deliver(JSON.stringify(envelope({ text: 'ya mande' })), {
      sendMenuCta: cta.sendMenuCta,
      sendProofReminder,
      lookupCustomerState: estado({
        paused: false,
        proofRemindedRecently: false,
        openOrder: {
          orderId: 'order-uuid',
          orderNumber: 'ORD-260903-007',
          status: 'confirmed',
          totalAmount: 95,
          payment: 'no_proof',
          proofReceived: false,
        },
      }),
    });

    expect(cta.enviados).toHaveLength(0);
    expect(recordatorios).toEqual([{ orderNumber: 'ORD-260903-007', totalAmount: 95 }]);
    expect(processed?.body).toMatchObject({ handled: 'proof_reminder', result: 'sent' });
  });

  it('sin puerto de recordatorio no se improvisa con el menú', async () => {
    const cta = spyCta();

    const { processed } = await deliver(JSON.stringify(envelope({ text: 'hola' })), {
      sendMenuCta: cta.sendMenuCta,
      lookupCustomerState: estado({
        paused: false,
        proofRemindedRecently: false,
        openOrder: {
          orderId: 'order-uuid',
          orderNumber: 'ORD-260903-007',
          status: 'confirmed',
          totalAmount: 95,
          payment: 'no_proof',
          proofReceived: false,
        },
      }),
    });

    expect(cta.enviados).toHaveLength(0);
    expect(processed?.body).toMatchObject({ handled: 'ignored' });
  });

  it('quien está esperando su comida no recibe nada', async () => {
    const cta = spyCta();

    await deliver(JSON.stringify(envelope({ text: 'ya salio?' })), {
      sendMenuCta: cta.sendMenuCta,
      lookupCustomerState: estado({
        paused: false,
        proofRemindedRecently: false,
        openOrder: {
          orderId: 'order-uuid',
          orderNumber: 'ORD-260903-007',
          status: 'preparing',
          totalAmount: 95,
          payment: 'accepted',
          proofReceived: false,
        },
      }),
    });

    expect(cta.enviados).toHaveLength(0);
  });
});

describe('"sin cebolla" — la preferencia que no rearma el pedido', () => {
  /** Estado de quien ya tiene su pedido cotizado y aún no pagó. */
  const conPedidoPorPagar = (over: Partial<CustomerStateSnapshot> = {}): CustomerStateSnapshot => ({
    paused: false,
    proofRemindedRecently: false,
    catalogTerms: ['hamburguesa', 'lomito', 'gaseosa', 'salchipapa', 'trancapecho'],
    openOrder: {
      orderId: 'order-uuid',
      orderNumber: 'ORD-260903-007',
      status: 'confirmed',
      totalAmount: 95,
      payment: 'no_proof',
      proofReceived: false,
    },
    ...over,
  });

  it('se anota en el pedido y se le contesta, en vez de recordarle el pago', async () => {
    const cta = spyCta();
    const notas: Array<{ orderId: string; note: string }> = [];
    let recordado = 0;

    const { processed } = await deliver(JSON.stringify(envelope({ text: 'porfa sin cebolla' })), {
      sendMenuCta: cta.sendMenuCta,
      lookupCustomerState: estado(conPedidoPorPagar()),
      sendProofReminder: async () => {
        recordado += 1;
        return { ok: true };
      },
      appendKitchenNote: async (input) => {
        notas.push({ orderId: input.orderId, note: input.note });
        return { ok: true };
      },
    });

    expect(notas).toEqual([{ orderId: 'order-uuid', note: 'porfa sin cebolla' }]);
    expect(recordado).toBe(0);
    expect(cta.enviados).toHaveLength(0);
    expect(processed?.body).toMatchObject({ handled: 'kitchen_note', result: 'saved' });
  });

  it('se atiende aunque acabemos de recordarle el pago: es una petición nueva', async () => {
    const notas: string[] = [];

    await deliver(JSON.stringify(envelope({ text: 'con harta mayonesa' })), {
      lookupCustomerState: estado(conPedidoPorPagar({ proofRemindedRecently: true })),
      appendKitchenNote: async (input) => {
        notas.push(input.note);
        return { ok: true };
      },
    });

    expect(notas).toEqual(['con harta mayonesa']);
  });

  it('pedir MÁS de algo no se anota: se le devuelve su pedido para rearmarlo', async () => {
    const cta = spyCta();
    const notas: string[] = [];
    let recordado = 0;

    const { processed } = await deliver(
      JSON.stringify(envelope({ text: 'agregame una gaseosa' })),
      {
        sendMenuCta: cta.sendMenuCta,
        lookupCustomerState: estado(conPedidoPorPagar()),
        sendProofReminder: async () => {
          recordado += 1;
          return { ok: true };
        },
        appendKitchenNote: async (input) => {
          notas.push(input.note);
          return { ok: true };
        },
      },
    );

    expect(notas).toHaveLength(0);
    expect(recordado).toBe(0);
    // El enlace lleva dentro a qué pedido sustituye: es lo que impide que salga
    // un segundo pedido en vez de una corrección del primero.
    expect(cta.enviados[0]).toMatchObject({
      replacesOrderId: 'order-uuid',
      buttonText: 'MODIFICAR MI PEDIDO',
    });
    expect(cta.enviados[0].bodyText).toContain('#7');
    expect(processed?.body).toMatchObject({ handled: 'order_change', result: 'sent' });
  });

  it('"paso yo a recogerlo" convierte el pedido, no le recuerda el pago', async () => {
    const cta = spyCta();
    const convertidos: string[] = [];
    let recordado = 0;

    const { processed } = await deliver(
      JSON.stringify(envelope({ text: 'Pasar yo a recogerlo' })),
      {
        sendMenuCta: cta.sendMenuCta,
        lookupCustomerState: estado(conPedidoPorPagar()),
        switchToPickup: async (input) => {
          convertidos.push(input.orderId);
          return { ok: true };
        },
        sendProofReminder: async () => {
          recordado += 1;
          return { ok: true };
        },
      },
    );

    expect(convertidos).toEqual(['order-uuid']);
    expect(recordado).toBe(0);
    expect(cta.enviados).toHaveLength(0);
    expect(processed?.body).toMatchObject({ handled: 'pickup_switch', result: 'switched' });
  });

  it('si no se pudo convertir, NO se le dice que quedó para recoger', async () => {
    // El repartidor ya salió, o el envío consta cobrado. El mensaje sigue su
    // camino en vez de darle por buena una conversión que no ocurrió.
    const { processed } = await deliver(
      JSON.stringify(envelope({ text: 'paso a recogerlo' })),
      {
        lookupCustomerState: estado(conPedidoPorPagar()),
        switchToPickup: async () => ({ ok: false }),
        sendProofReminder: async () => ({ ok: true }),
      },
    );

    expect(processed?.body).not.toMatchObject({ handled: 'pickup_switch' });
  });

  it('con la foto ya recibida NO se ofrece rehacer el pedido', async () => {
    // El 04-09-2026 un cliente mandó su comprobante y un minuto después escribió
    // "me olvidé de las salsas". La captura del archivo había fallado —sin
    // bytes, sin intento de pago— así que el sistema lo dio por impago y le
    // mandó el botón: acabó con dos pedidos, pagando el primero y esperando el
    // segundo. `proofReceived` sale de `payment_proofs`, que se escribe aunque
    // la descarga se caiga.
    const cta = spyCta();
    const variantes: (string | undefined)[] = [];

    const { processed } = await deliver(
      JSON.stringify(envelope({ text: 'Quiero armar de nuevo' })),
      {
        sendMenuCta: cta.sendMenuCta,
        lookupCustomerState: estado(
          conPedidoPorPagar({
            openOrder: {
              orderId: 'order-uuid',
              orderNumber: 'ORD-260904-002',
              status: 'confirmed',
              totalAmount: 28,
              payment: 'no_proof',
              proofReceived: true,
            },
          }),
        ),
        sendProofReminder: async (input) => {
          variantes.push(input.variant);
          return { ok: true };
        },
      },
    );

    expect(cta.enviados).toHaveLength(0);
    // Y no se le calla: se le contesta que ya la tenemos. Callar dejaba el turno
    // libre y lo tomaba el modelo, que el 04-09 mandó a ese cliente a hablar con
    // una persona.
    expect(variantes).toEqual(['received']);
    expect(processed?.body).not.toMatchObject({ handled: 'order_change' });
  });

  it('pero una preferencia SÍ se sigue anotando con la foto recibida', async () => {
    // "Sin cebolla" no toca el total ni el QR: se anota igual, que es lo que el
    // cliente pidió. La guarda nueva va después de la nota, a propósito.
    const notas: string[] = [];

    await deliver(JSON.stringify(envelope({ text: 'porfa sin cebolla' })), {
      lookupCustomerState: estado(
        conPedidoPorPagar({
          openOrder: {
            orderId: 'order-uuid',
            orderNumber: 'ORD-260904-002',
            status: 'confirmed',
            totalAmount: 28,
            payment: 'no_proof',
            proofReceived: true,
          },
        }),
      ),
      appendKitchenNote: async (input) => {
        notas.push(input.note);
        return { ok: true };
      },
    });

    expect(notas).toEqual(['porfa sin cebolla']);
  });

  it('el pedido que AÚN ESPERA UBICACIÓN también se rearma', async () => {
    // El 04-09-2026 se probó el flujo con un pedido recién creado —"me aumenta
    // 2 papas" antes de mandar el GPS— y no pasó nada: la guarda solo miraba
    // `confirmed`. Es el momento más seguro para rehacerlo: no hay ubicación,
    // ni total final, ni QR, ni nada en la plancha.
    const cta = spyCta();
    let recordado = 0;

    const { processed } = await deliver(
      JSON.stringify(envelope({ text: 'Quiero armar de nuevo' })),
      {
        sendMenuCta: cta.sendMenuCta,
        lookupCustomerState: estado(
          conPedidoPorPagar({
            openOrder: {
              orderId: 'order-uuid',
              orderNumber: 'ORD-260904-001',
              status: 'awaiting_location',
              totalAmount: 46,
              payment: 'no_proof',
              proofReceived: false,
            },
          }),
        ),
        sendProofReminder: async () => {
          recordado += 1;
          return { ok: true };
        },
      },
    );

    expect(cta.enviados[0]).toMatchObject({
      replacesOrderId: 'order-uuid',
      buttonText: 'MODIFICAR MI PEDIDO',
    });
    expect(recordado).toBe(0);
    expect(processed?.body).toMatchObject({ handled: 'order_change', result: 'sent' });
  });

  it('"puedo aumentar" reabre el pedido, y el modelo no llega a hablar', async () => {
    const cta = spyCta();
    const agente = spyChannel();
    let recordado = 0;

    // Con el recordatorio en cooldown, que es como estaba el 04-09-2026: antes
    // de esto la decisión era `none` y el turno se lo quedaba el modelo, que
    // derivó la conversación a una persona y la dejó callada dos horas.
    const { processed } = await deliver(JSON.stringify(envelope({ text: 'Puedo aumentar' })), {
      sendMenuCta: cta.sendMenuCta,
      lookupCustomerState: estado(conPedidoPorPagar({ proofRemindedRecently: true })),
      agentChannel: agente.channel,
      sendProofReminder: async () => {
        recordado += 1;
        return { ok: true };
      },
    });

    expect(cta.enviados[0]).toMatchObject({
      replacesOrderId: 'order-uuid',
      buttonText: 'MODIFICAR MI PEDIDO',
    });
    expect(recordado).toBe(0);
    expect(processed?.body).toMatchObject({ handled: 'order_change', result: 'sent' });
    // Lo que de verdad arregla esto: el turno queda cerrado y `request_human`
    // ni se plantea.
    expect(agente.turns).toHaveLength(0);
  });

  it('con el pago ya en revisión no se cambian las líneas: hay dinero de por medio', async () => {
    const cta = spyCta();

    const { processed } = await deliver(
      JSON.stringify(envelope({ text: 'agregame una gaseosa' })),
      {
        sendMenuCta: cta.sendMenuCta,
        lookupCustomerState: estado(
          conPedidoPorPagar({
            openOrder: {
              orderId: 'order-uuid',
              orderNumber: 'ORD-260903-007',
              status: 'confirmed',
              totalAmount: 95,
              payment: 'awaiting_review',
              proofReceived: false,
            },
          }),
        ),
      },
    );

    expect(cta.enviados).toHaveLength(0);
    expect(processed?.body).toMatchObject({ handled: 'ignored' });
  });

  it('si el pedido ya está en la plancha, no se promete nada', async () => {
    const notas: string[] = [];

    const { processed } = await deliver(JSON.stringify(envelope({ text: 'sin cebolla' })), {
      lookupCustomerState: estado(
        conPedidoPorPagar({
          openOrder: {
            orderId: 'order-uuid',
            orderNumber: 'ORD-260903-007',
            status: 'preparing',
            totalAmount: 95,
            payment: 'accepted',
            proofReceived: false,
          },
        }),
      ),
      appendKitchenNote: async (input) => {
        notas.push(input.note);
        return { ok: true };
      },
    });

    expect(notas).toHaveLength(0);
    expect(processed?.body).toMatchObject({ handled: 'ignored' });
  });

  it('si la nota no se pudo escribir, el mensaje NO queda atendido', async () => {
    // Un "claro que sí" sin nota escrita es la promesa falsa que este proyecto
    // lleva desde agosto cerrando. Mejor que siga su camino.
    const { processed } = await deliver(JSON.stringify(envelope({ text: 'sin cebolla' })), {
      lookupCustomerState: estado(conPedidoPorPagar()),
      appendKitchenNote: async () => ({ ok: false }),
    });

    expect(processed?.body).toMatchObject({ handled: 'ignored' });
  });

  it('sin puerto de notas no se improvisa con otro mensaje', async () => {
    // La decisión ya dijo "esto es una preferencia". Contestarle el recordatorio
    // del pago sería responder a otra cosa, así que el mensaje sigue su camino
    // —el agente puede atenderlo— y este cliente no recibe un texto que no le
    // encaja. Sin el puerto cableado, esta política sencillamente no existe.
    let recordado = 0;

    const { processed } = await deliver(JSON.stringify(envelope({ text: 'sin cebolla' })), {
      lookupCustomerState: estado(conPedidoPorPagar()),
      sendProofReminder: async () => {
        recordado += 1;
        return { ok: true };
      },
    });

    expect(recordado).toBe(0);
    expect(processed?.body).toMatchObject({ handled: 'ignored' });
  });
});

describe('las dos puertas, un solo filtro', () => {
  it('"quiero pedir" NO manda el botón si hay un humano atendiendo', async () => {
    const cta = spyCta();

    // El agujero que este cambio cierra: hasta el 03-09-2026 la puerta de
    // intención enviaba sin mirar nada, así que el cliente que pedía atención
    // humana seguía recibiendo CTAs automáticos mientras alguien le escribía.
    const { processed } = await deliver(JSON.stringify(envelope({ text: 'quiero pedir' })), {
      sendMenuCta: cta.sendMenuCta,
      lookupCustomerState: estado({ ...DESPEJADO, paused: true }),
    });

    expect(cta.enviados).toHaveLength(0);
    expect(processed?.body).toMatchObject({ handled: 'ignored' });
  });

  it('"quiero pedir" con el pedido esperando pago recibe el recordatorio', async () => {
    const cta = spyCta();
    let recordado = 0;
    const sendProofReminder: SendProofReminder = async () => {
      recordado += 1;
      return { ok: true };
    };

    const { processed } = await deliver(JSON.stringify(envelope({ text: 'quiero pedir' })), {
      sendMenuCta: cta.sendMenuCta,
      sendProofReminder,
      lookupCustomerState: estado({
        paused: false,
        proofRemindedRecently: false,
        openOrder: {
          orderId: 'order-uuid',
          orderNumber: 'ORD-260903-007',
          status: 'confirmed',
          totalAmount: 95,
          payment: 'no_proof',
          proofReceived: false,
        },
      }),
    });

    expect(cta.enviados).toHaveLength(0);
    expect(recordado).toBe(1);
    expect(processed?.body).toMatchObject({ handled: 'proof_reminder' });
  });

  it('el trigger de QA se salta las excepciones: es diagnóstico interno', async () => {
    const cta = spyCta();

    const { processed } = await deliver(JSON.stringify(envelope({ text: 'TESTMENU9842' })), {
      sendMenuCta: cta.sendMenuCta,
      lookupCustomerState: estado({ ...DESPEJADO, paused: true }),
    });

    expect(cta.enviados).toHaveLength(1);
    expect(cta.enviados[0].reason).toBe('qa_trigger');
    expect(processed?.body).toMatchObject({ handled: 'menu_cta', result: 'sent' });
  });

  it('una ráfaga con petición Y pregunta produce un solo botón', async () => {
    const cta = spyCta();
    const agente = spyChannel();

    const body = batchBody([
      envelope({ wamid: 'wamid.A', text: 'quiero pedir' }),
      envelope({ wamid: 'wamid.B', text: 'a cuanto esta el trancapecho' }),
    ]);

    await deliver(body, {
      sendMenuCta: cta.sendMenuCta,
      lookupCustomerState: estado(DESPEJADO),
      agentChannel: agente.channel,
    });

    // La petición explícita gana el envío por ser la primera del lote; el ancla
    // ve que el botón ya salió y no manda otro.
    expect(cta.enviados).toHaveLength(1);
    expect(cta.enviados[0].sourceMessageId).toBe('wamid.A');
    expect(agente.turns).toHaveLength(0);
  });
});

describe('lo que el default NO toca', () => {
  it('la petición explícita la sigue atendiendo la puerta de arriba', async () => {
    const cta = spyCta();

    // `isMenuIntent` reconoce "quiero pedir" y responde ANTES de la ubicación y
    // de la cotización. Esa puerta no consulta el estado del cliente, así que
    // aquí ni siquiera hace falta el puerto.
    await deliver(JSON.stringify(envelope({ text: 'quiero pedir' })), {
      sendMenuCta: cta.sendMenuCta,
    });

    expect(cta.enviados).toHaveLength(1);
    expect(cta.enviados[0].reason).toBe('explicit_request');
  });

  it('"cuánto sale el envío" sigue pidiendo la ubicación, no manda el menú', async () => {
    const cta = spyCta();
    const pedidas: string[] = [];

    const { processed } = await deliver(
      JSON.stringify(envelope({ text: 'cuanto me sale el delivery hasta aqui' })),
      {
        sendMenuCta: cta.sendMenuCta,
        lookupCustomerState: estado(DESPEJADO),
        askLocationForQuote: async (input) => {
          pedidas.push(input.sourceMessageId);
          return { ok: true };
        },
      },
    );

    expect(processed?.body).toMatchObject({ handled: 'delivery_quote_prompt' });
    expect(pedidas).toHaveLength(1);
    expect(cta.enviados).toHaveLength(0);
  });
});
