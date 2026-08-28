import { describe, it, expect } from 'vitest';
import { processClaimedEvent, type HandleKapsoWebhookParams, type WebhookEventRow } from './kapso';
import { runInboxTick } from './inbox-worker';
import { runAgentTurn, type AgentTurnDeps } from '@/lib/agent/core/run';
import type { AgentChannelPort, AgentTurnResult } from '@/lib/agent/core/types';
import type { AgentModelInput } from '@/lib/agent/core/model';
import type { ProvenanceMessage } from '@/lib/kapso/channel/provenance';
import type { ProofClassification } from '@/lib/payment-proof/agent-gate';
import {
  IMAGE_CAPTION_WAMID,
  IMAGE_NO_CAPTION_WAMID,
  imageNoCaptionEnvelope,
  imageWithCaptionEnvelope,
} from '@/lib/kapso/channel/image.fixtures';

/**
 * UN ADJUNTO NO LLEGA A OPENAI SIN PERMISO — recorrido completo desde el webhook.
 *
 * No se prueba la puerta aislada (eso es `payment-proof/agent-gate.test.ts`): se
 * prueba la CADENA entera, entrando por `processClaimedEvent` —el punto por el
 * que pasan las tres vías: inline, `after()` y worker de recovery— y llegando
 * hasta el `runAgentTurn` REAL del core, con un resolutor de media y un modelo
 * espiados.
 *
 * Esa composición es la que da la evidencia que hacía falta:
 *
 *   webhook → puerta → runAgentTurn → resolveImage → input_image → OpenAI
 *
 * Si la puerta no autoriza, `resolveImage` no se llama NUNCA, no se construye
 * ninguna parte `input_image` y el modelo no recibe una sola foto. Comprobar
 * solo lo primero sería comprobar una intención; se comprueban los cuatro
 * eslabones porque el que importa es el último.
 *
 * ── El contrato es de AUTORIZACIÓN POSITIVA ─────────────────────────────────
 *
 * Los bytes viajan SOLO si hay WAMID no vacío + veredicto explícito
 * `not_payment_proof` para ese mismo WAMID. Todo lo demás —sin identidad, sin
 * motor, sin puerto, sin veredicto, con duda— retiene. Los escenarios de abajo
 * recorren cada una de esas ausencias.
 */

const KAPSO_EVENT = 'whatsapp.message.received';
const PHONE_DIGITS = '59100000000';
const CONV = '00000000-0000-4000-8000-000000000002';

function row(payload: unknown, id = 'evt-1'): WebhookEventRow {
  return {
    id,
    eventId: id,
    eventName: KAPSO_EVENT,
    payload,
    attempts: 0,
    maxAttempts: 5,
  } as unknown as WebhookEventRow;
}

/** Lote de Kapso con la forma oficial: `batch`, `data[]` y `batch_info`. */
function lote(...data: Record<string, unknown>[]): Record<string, unknown> {
  return {
    type: KAPSO_EVENT,
    batch: true,
    data,
    batch_info: {
      size: data.length,
      window_ms: 5000,
      first_sequence: 1,
      last_sequence: data.length,
      conversation_id: CONV,
    },
  };
}

/** Mensaje de texto del MISMO cliente que las fixtures de imagen. */
function textoEnvelope(wamid: string, text: string): Record<string, unknown> {
  return {
    phone_number_id: '000000000000000',
    message: {
      id: wamid,
      type: 'text',
      text: { body: text },
      from: PHONE_DIGITS,
      timestamp: 1_760_000_200,
      kapso: { direction: 'inbound', origin: 'cloud_api', status: 'received' },
    },
    conversation: { id: CONV, phone_number: PHONE_DIGITS },
  };
}

/**
 * Imagen SIN `message.id`.
 *
 * Es el payload que la auditoría usó para demostrar el primer bypass: sin WAMID
 * el motor de comprobantes no puede reclamarla —no hay clave de idempotencia—
 * así que nunca obtiene veredicto. Con la puerta anterior, "sin veredicto"
 * significaba "pasa".
 */
function imagenSinWamid(): Record<string, unknown> {
  return {
    phone_number_id: '000000000000000',
    message: {
      // `id` deliberadamente AUSENTE.
      type: 'image',
      from: PHONE_DIGITS,
      timestamp: 1_760_000_000,
      image: {
        id: 'media-sin-wamid',
        url: 'https://lookaside.fbsbx.com/whatsapp/SIN_WAMID',
        link: 'https://app.kapso.ai/media/SIN_WAMID',
        sha256: 'c0ffee',
        mime_type: 'image/jpeg',
      },
      kapso: {
        direction: 'inbound',
        origin: 'cloud_api',
        status: 'received',
        has_media: true,
        media_url: 'https://app.kapso.ai/media/SIN_WAMID',
        media_data: { filename: 'x.jpg', byte_size: 1234, content_type: 'image/jpeg' },
        message_type_data: { caption: '' },
      },
    },
    conversation: { id: CONV, phone_number: PHONE_DIGITS },
  };
}

/** Comprobante bancario en PDF: llega como `document`, no como `image`. */
function pdfEnvelope(wamid = 'wamid.PDF'): Record<string, unknown> {
  return {
    phone_number_id: '000000000000000',
    message: {
      id: wamid,
      type: 'document',
      from: PHONE_DIGITS,
      timestamp: 1_760_000_300,
      document: {
        id: '2267829863993481',
        url: 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=SANITIZADO',
        link: 'https://app.kapso.ai/rails/active_storage/blobs/redirect/SANITIZADO/c.pdf',
        sha256: 'bEhGt7Hn3JFXKMeZ2PJ2GlXyAOhX9BvS+tjb8RyGNYw=',
        filename: 'comprobante.pdf',
        mime_type: 'application/pdf',
      },
      kapso: {
        direction: 'inbound',
        origin: 'cloud_api',
        has_media: true,
        media_url: 'https://app.kapso.ai/rails/active_storage/blobs/redirect/SANITIZADO/c.pdf',
        media_data: {
          filename: 'comprobante.pdf',
          byte_size: 792233,
          content_type: 'application/pdf',
        },
        message_type_data: { caption: '', has_media: true },
      },
    },
    conversation: { id: CONV, phone_number: PHONE_DIGITS },
  };
}

// ── El agente REAL, con la red y el modelo espiados ─────────────────────────

/**
 * Doble del canal del agente que ejecuta el `runAgentTurn` de verdad.
 *
 * Solo se falsean los tres bordes que salen del proceso —la base, la descarga de
 * media y el modelo—. Todo lo que hay entre la puerta y OpenAI es el código
 * real, que es justamente lo que había que poner a prueba.
 */
function agenteEspiado() {
  /** Una entrada por llamada a `resolveImage`. */
  const resolveCalls: string[] = [];
  /** Todo lo que se le mandó al modelo, ronda a ronda. */
  const modelCalls: AgentModelInput[][] = [];
  /** Lo que el webhook entregó al turno, ya pasado por la puerta. */
  const recibido: { message: ProvenanceMessage; burst: readonly ProvenanceMessage[] }[] = [];

  /**
   * Historial persistido, como en producción: el texto de un burst NO viaja
   * inline al modelo, viaja por el historial. Un doble que devolviera historial
   * vacío haría imposible comprobar que el texto sobrevivió a la puerta.
   */
  const historial: {
    actor: 'customer';
    role: 'user';
    content: string | null;
    contentType: string;
    messageTimestamp: string;
  }[] = [];

  const deps = {
    store: {
      async findPauseStateByPhone() {
        return {
          conversationId: 'conv-1',
          state: 'active' as const,
          pausedAt: null,
          pauseExpiresAt: null,
          pauseReason: null,
          pauseSource: null,
          resumedAt: null,
        };
      },
      async insertMessage() {
        return 'inserted' as const;
      },
      async touchAiMessageAt() {},
    },
    runs: {
      async findMessageIdByProviderMessageId() {
        return null;
      },
      async claimRun() {
        return { result: 'claimed' as const, runId: `run-${recibido.length}` };
      },
      async loadRecentMessages() {
        return historial;
      },
      async markRunSending() {},
      async finishRun() {},
      async touchAiMessageAt() {},
    },
    model: {
      model: 'gpt-fake',
      async complete(messages: readonly AgentModelInput[]) {
        modelCalls.push([...messages]);
        return { ok: true as const, text: 'listo', model: 'gpt-fake' };
      },
    },
    send: {
      async sendText() {
        return { ok: true as const, wamid: 'wamid.OUT' };
      },
    },
    config: {
      enabled: true,
      accessMode: 'allowlist' as const,
      testPhones: [PHONE_DIGITS],
      hasApiKey: true,
    },
    systemPrompt: 'eres el asistente del restaurante',
    now: () => '2026-08-27T18:00:05.000Z',
    // El resolutor: si la puerta no autoriza, NADIE lo llama.
    media: {
      async resolveImage() {
        resolveCalls.push('resolveImage');
        return {
          ok: true as const,
          dataUrl: 'data:image/jpeg;base64,BYTESDELADJUNTO',
          source: 'transient_kapso' as const,
          byteSize: 4,
          mimeType: 'image/jpeg',
        };
      },
    },
  } as unknown as AgentTurnDeps;

  const channel: AgentChannelPort = {
    async persistCustomerInbound(message) {
      // Se guarda el CONTENIDO, nunca el adjunto: `agent_messages` no almacena
      // píxeles, y por eso el historial jamás puede reintroducir la foto.
      historial.push({
        actor: 'customer',
        role: 'user',
        content: message.content,
        contentType: message.contentType,
        messageTimestamp: message.messageTimestamp ?? '2026-08-27T18:00:00.000Z',
      });
      return { result: 'persisted', conversationId: 'conv-1' };
    },
    async handleHumanTakeover() {
      throw new Error('este camino no lleva takeover');
    },
    async runAgentTurn(message, burst): Promise<AgentTurnResult> {
      recibido.push({ message, burst: burst ?? [message] });
      return runAgentTurn(message, deps, burst);
    },
  };

  /** Todo lo que viajó al modelo, en texto plano, para afirmar ausencias. */
  const dumpModelo = (): string => JSON.stringify(modelCalls);

  return { channel, resolveCalls, modelCalls, recibido, dumpModelo };
}

/** Puerto de comprobantes con el veredicto que se quiera para cada WAMID. */
function intakeQueDice(
  veredicto: ProofClassification | ((wamid: string) => ProofClassification),
  result = 'captured',
) {
  const vistos: string[] = [];
  const intake: HandleKapsoWebhookParams['paymentProofIntake'] = async (input) => {
    vistos.push(input.sourceMessageId);
    return {
      result,
      proofClassification:
        typeof veredicto === 'function' ? veredicto(input.sourceMessageId) : veredicto,
    };
  };
  return { intake, vistos };
}

function params(over: Partial<HandleKapsoWebhookParams> = {}): HandleKapsoWebhookParams {
  return {
    rawBody: '',
    headers: { signature: null, version: null, event: KAPSO_EVENT, idempotencyKey: null },
    secret: 'x'.repeat(32),
    store: {
      markProcessed: async () => {},
      markFailed: async () => {},
      releaseForRetry: async () => {},
    },
    confirmOrder: async () => ({ result: 'not_found' }),
    ensureLocationRequest: async () => ({ result: 'not_applicable' }),
    attachOrderLocation: async () => ({ result: 'not_found' }),
    sendMenuCta: async () => ({ result: 'skipped' }),
    ...over,
  } as unknown as HandleKapsoWebhookParams;
}

/** Partes `input_image` que llegaron al modelo. */
function partesImagen(calls: readonly AgentModelInput[][]): string[] {
  const out: string[] = [];
  for (const call of calls) {
    for (const item of call) {
      if (!('role' in item)) continue;
      if (typeof item.content === 'string') continue;
      for (const parte of item.content) {
        if (parte.type === 'input_image') out.push(parte.image_url);
      }
    }
  }
  return out;
}

/** Afirma el bloqueo total de Vision en los cuatro eslabones. */
function esperaCeroVision(a: ReturnType<typeof agenteEspiado>, nombre: string): void {
  expect(a.resolveCalls, `${nombre}: resolveImage`).toEqual([]);
  expect(partesImagen(a.modelCalls), `${nombre}: input_image`).toEqual([]);
  expect(a.dumpModelo(), `${nombre}: base64`).not.toContain('base64');
  expect(a.dumpModelo(), `${nombre}: bytes`).not.toContain('BYTESDELADJUNTO');
  for (const { burst, message } of a.recibido) {
    expect(message.image ?? null, `${nombre}: ancla`).toBeNull();
    expect(
      burst.every((m) => m.image == null && m.document == null),
      `${nombre}: burst`,
    ).toBe(true);
  }
}

// ── 1. Imagen sin WAMID + texto con WAMID ───────────────────────────────────

describe('1 · [imagen sin WAMID, texto con WAMID]', () => {
  it('la captura no puede correlacionarla, y aun así no llega a Vision', async () => {
    const a = agenteEspiado();
    // Veredicto permisivo a propósito: si la puerta dependiera de "no consta
    // como comprobante", esto la abriría. No debe abrirla.
    const { intake, vistos } = intakeQueDice('not_payment_proof');

    await processClaimedEvent(
      row(lote(imagenSinWamid(), textoEnvelope('wamid.TXT', 'hola, una consulta'))),
      params({ agentChannel: a.channel, paymentProofIntake: intake }),
    );

    // El motor NUNCA la vio: sin WAMID no hay clave con la que reclamarla.
    expect(vistos).toEqual([]);
    // Y precisamente por eso no está autorizada.
    esperaCeroVision(a, 'sin WAMID');

    // El texto del OTRO mensaje sí llega al modelo.
    expect(a.dumpModelo()).toContain('hola, una consulta');
  });

  it('el mensaje sin WAMID no desaparece del burst: solo pierde los bytes', async () => {
    const a = agenteEspiado();
    const { intake } = intakeQueDice('not_payment_proof');

    await processClaimedEvent(
      row(lote(imagenSinWamid(), textoEnvelope('wamid.TXT', 'hola'))),
      params({ agentChannel: a.channel, paymentProofIntake: intake }),
    );

    const { burst } = a.recibido[0];
    expect(burst).toHaveLength(2);
    expect(burst[0].providerMessageId).toBeNull();
    expect(burst[0].image).toBeNull();
  });
});

// ── 2. Imagen con WAMID clasificada como comprobante ────────────────────────

describe('2 · comprobante con WAMID', () => {
  it('se captura con normalidad y no llega nada a Vision', async () => {
    const a = agenteEspiado();
    const { intake, vistos } = intakeQueDice('payment_proof');

    const res = await processClaimedEvent(
      row(imageNoCaptionEnvelope()),
      params({ agentChannel: a.channel, paymentProofIntake: intake }),
    );

    expect(res.outcome).toBe('processed');
    expect(vistos).toEqual([IMAGE_NO_CAPTION_WAMID]);
    expect(res.body).toMatchObject({ payment_proofs: ['captured'] });
    esperaCeroVision(a, 'comprobante');
  });

  it('ninguna URL de acceso al archivo viaja al turno', async () => {
    // Una `media_url` es una credencial de acceso a la foto del cliente: que la
    // imagen no viaje no basta si viaja la llave para descargarla.
    const a = agenteEspiado();
    const { intake } = intakeQueDice('payment_proof');

    await processClaimedEvent(
      row(imageNoCaptionEnvelope()),
      params({ agentChannel: a.channel, paymentProofIntake: intake }),
    );

    const dump = JSON.stringify(a.recibido);
    expect(dump).not.toContain('kapso.ai');
    expect(dump).not.toContain('lookaside');
  });
});

// ── 3. Imagen normal autorizada ─────────────────────────────────────────────

describe('3 · imagen normal con WAMID y veredicto explícito', () => {
  it('Vision funciona: se descarga y viaja como input_image', async () => {
    // La otra mitad del contrato. Una puerta que retuviera todo sería trivial de
    // escribir y habría apagado Vision sin decirlo.
    const a = agenteEspiado();
    const { intake } = intakeQueDice('not_payment_proof');

    await processClaimedEvent(
      row(imageWithCaptionEnvelope()),
      params({ agentChannel: a.channel, paymentProofIntake: intake }),
    );

    expect(a.recibido[0].message.image).not.toBeNull();
    expect(a.resolveCalls).toEqual(['resolveImage']);
    expect(partesImagen(a.modelCalls)).toEqual(['data:image/jpeg;base64,BYTESDELADJUNTO']);
  });
});

// ── 4. PAYMENT_PROOF_CAPTURE_ENABLED apagado ────────────────────────────────

describe('4 · captura apagada (capture_disabled)', () => {
  /** Lo que devuelve `intakePaymentProof` real con el flag apagado. */
  const intakeApagado: HandleKapsoWebhookParams['paymentProofIntake'] = async () => ({
    result: 'failed',
    reason: 'capture_disabled',
    proofClassification: 'unknown',
  });

  it('cero Vision para cualquier adjunto', async () => {
    const a = agenteEspiado();
    await processClaimedEvent(
      row(imageWithCaptionEnvelope()),
      params({ agentChannel: a.channel, paymentProofIntake: intakeApagado }),
    );
    esperaCeroVision(a, 'capture_disabled');
  });

  it('el texto sigue funcionando', async () => {
    const a = agenteEspiado();
    await processClaimedEvent(
      row(lote(textoEnvelope('wamid.T', 'quiero una hamburguesa'), imageNoCaptionEnvelope())),
      params({ agentChannel: a.channel, paymentProofIntake: intakeApagado }),
    );
    expect(a.dumpModelo()).toContain('quiero una hamburguesa');
    esperaCeroVision(a, 'capture_disabled + texto');
  });

  it('NO se afirma que el comprobante se haya almacenado', async () => {
    const res = await processClaimedEvent(
      row(imageNoCaptionEnvelope()),
      params({ agentChannel: agenteEspiado().channel, paymentProofIntake: intakeApagado }),
    );
    const cuerpo = JSON.stringify(res.body);
    expect(cuerpo).toContain('failed');
    expect(cuerpo).not.toContain('captured');
    expect(cuerpo).not.toContain('stored');
  });
});

// ── 5. paymentProofIntake ausente ───────────────────────────────────────────

describe('5 · sin puerto de captura cableado', () => {
  it('cero Vision: no existe un tercer camino sin puerta', async () => {
    const a = agenteEspiado();
    await processClaimedEvent(
      row(imageWithCaptionEnvelope()),
      params({ agentChannel: a.channel }), // sin paymentProofIntake
    );
    esperaCeroVision(a, 'intake ausente');
  });

  it('el texto continúa', async () => {
    const a = agenteEspiado();
    await processClaimedEvent(
      row(lote(textoEnvelope('wamid.T', 'a que hora abren'), imageNoCaptionEnvelope())),
      params({ agentChannel: a.channel }),
    );
    expect(a.dumpModelo()).toContain('a que hora abren');
    esperaCeroVision(a, 'intake ausente + texto');
  });
});

// ── 6. intake_error y storage_not_configured ────────────────────────────────

describe('6 · el motor no pudo decidir', () => {
  const fallos: [string, HandleKapsoWebhookParams['paymentProofIntake']][] = [
    [
      'intake_error',
      async () => ({ result: 'failed', reason: 'intake_error', proofClassification: 'unknown' }),
    ],
    [
      'storage_not_configured (comprobante)',
      async () => ({
        result: 'failed',
        reason: 'storage_not_configured',
        proofClassification: 'payment_proof',
      }),
    ],
    [
      'storage_not_configured (sin veredicto)',
      async () => ({ result: 'failed', reason: 'storage_not_configured' }),
    ],
    ['el motor LANZA', async () => { throw new Error('base inalcanzable'); }],
    ['resultado desconocido sin clasificación', async () => ({ result: 'vete-a-saber' })],
  ];

  for (const [nombre, intake] of fallos) {
    it(`${nombre}: cero Vision`, async () => {
      const a = agenteEspiado();
      const res = await processClaimedEvent(
        row(imageNoCaptionEnvelope()),
        params({ agentChannel: a.channel, paymentProofIntake: intake }),
      );
      // La entrega no se cae por eso…
      expect(res.outcome).toBe('processed');
      // …y los bytes tampoco viajan.
      esperaCeroVision(a, nombre);
    });
  }
});

// ── 7. Dos comprobantes seguidos ────────────────────────────────────────────

describe('7 · dos comprobantes seguidos', () => {
  it('ambos retenidos por su propio WAMID, cero resolveImage', async () => {
    const a = agenteEspiado();
    const { intake, vistos } = intakeQueDice('payment_proof');

    await processClaimedEvent(
      row(lote(imageNoCaptionEnvelope(), imageWithCaptionEnvelope())),
      params({ agentChannel: a.channel, paymentProofIntake: intake }),
    );

    expect(vistos).toEqual([IMAGE_NO_CAPTION_WAMID, IMAGE_CAPTION_WAMID]);
    expect(a.recibido[0].burst).toHaveLength(2);
    esperaCeroVision(a, 'dos comprobantes');
  });
});

// ── 8. Comprobante + imagen normal + texto ──────────────────────────────────

describe('8 · comprobante + imagen normal + texto', () => {
  it('cada adjunto se decide por SU propio veredicto; el texto se preserva', async () => {
    const a = agenteEspiado();
    // Veredicto POR WAMID: el sin-caption es comprobante, el con-caption no.
    const { intake } = intakeQueDice((wamid) =>
      wamid === IMAGE_NO_CAPTION_WAMID ? 'payment_proof' : 'not_payment_proof',
    );

    await processClaimedEvent(
      row(
        lote(
          textoEnvelope('wamid.TXT', 'te mando el comprobante y una foto'),
          imageNoCaptionEnvelope(),
          imageWithCaptionEnvelope(),
        ),
      ),
      params({ agentChannel: a.channel, paymentProofIntake: intake }),
    );

    const { burst } = a.recibido[0];
    expect(burst).toHaveLength(3);
    expect(burst.map((m) => m.providerMessageId)).toEqual([
      'wamid.TXT',
      IMAGE_NO_CAPTION_WAMID,
      IMAGE_CAPTION_WAMID,
    ]);

    // El comprobante retenido…
    expect(burst[1].image).toBeNull();
    // …la imagen normal autorizada, y SOLO por su propio veredicto explícito.
    expect(burst[2].image).not.toBeNull();
    // Exactamente una descarga: la autorizada.
    expect(a.resolveCalls).toEqual(['resolveImage']);
    expect(partesImagen(a.modelCalls)).toHaveLength(1);
    // Y el texto sobrevive.
    expect(a.dumpModelo()).toContain('te mando el comprobante y una foto');
  });
});

// ── 9. Correlación por WAMID con listas desalineadas ────────────────────────

describe('9 · lote con resultados filtrados o en otro orden', () => {
  it('la correlación por WAMID sigue siendo correcta', async () => {
    const a = agenteEspiado();
    const vistos: string[] = [];
    // El motor ve los adjuntos en el orden de los sobres, pero el burst incluye
    // también el texto: las dos listas NO tienen ni la misma longitud ni el
    // mismo orden. Si la correlación fuera posicional, aquí se cruzarían.
    const intake: HandleKapsoWebhookParams['paymentProofIntake'] = async (input) => {
      vistos.push(input.sourceMessageId);
      return {
        result: 'captured',
        proofClassification:
          input.sourceMessageId === IMAGE_CAPTION_WAMID ? 'not_payment_proof' : 'payment_proof',
      };
    };

    await processClaimedEvent(
      row(
        lote(
          imageNoCaptionEnvelope(), // índice 0 del burst → comprobante
          textoEnvelope('wamid.TXT', 'ahí va'), // índice 1 → sin adjunto, el motor lo salta
          imageWithCaptionEnvelope(), // índice 2 → normal
        ),
      ),
      params({ agentChannel: a.channel, paymentProofIntake: intake }),
    );

    // El motor solo vio DOS mensajes; el burst tiene TRES.
    expect(vistos).toEqual([IMAGE_NO_CAPTION_WAMID, IMAGE_CAPTION_WAMID]);
    const { burst } = a.recibido[0];
    expect(burst).toHaveLength(3);

    expect(burst[0].image).toBeNull(); // comprobante
    expect(burst[2].image).not.toBeNull(); // normal
    expect(a.resolveCalls).toEqual(['resolveImage']);
  });
});

// ── 10. PDF ─────────────────────────────────────────────────────────────────

describe('10 · un PDF va por comprobantes y JAMÁS por Vision', () => {
  it('llega al motor de comprobantes con adjunto', async () => {
    const a = agenteEspiado();
    const { intake, vistos } = intakeQueDice('payment_proof');

    const res = await processClaimedEvent(
      row(pdfEnvelope()),
      params({ agentChannel: a.channel, paymentProofIntake: intake }),
    );

    expect(res.outcome).toBe('processed');
    expect(vistos).toEqual(['wamid.PDF']);
  });

  it('no se resuelve como imagen ni produce input_image', async () => {
    const a = agenteEspiado();
    const { intake } = intakeQueDice('payment_proof');
    await processClaimedEvent(
      row(pdfEnvelope()),
      params({ agentChannel: a.channel, paymentProofIntake: intake }),
    );
    esperaCeroVision(a, 'pdf comprobante');
    expect(a.dumpModelo()).not.toContain('comprobante.pdf');
  });

  it('incluso clasificado como NO comprobante, un PDF no entra en Vision', async () => {
    // Un documento nunca es una imagen. Que la puerta lo autorice no puede
    // convertirlo en `input_image`: son dos campos distintos a propósito.
    const a = agenteEspiado();
    const { intake } = intakeQueDice('not_payment_proof');
    await processClaimedEvent(
      row(pdfEnvelope()),
      params({ agentChannel: a.channel, paymentProofIntake: intake }),
    );
    expect(a.resolveCalls).toEqual([]);
    expect(partesImagen(a.modelCalls)).toEqual([]);
  });
});

// ── 11. Inline, async ACK y worker: misma política ──────────────────────────

describe('11 · las tres vías aplican la MISMA política', () => {
  /**
   * Las tres convergen en `processClaimedEvent`. Inline y `after()` comparten
   * literalmente el mismo objeto `params` en la ruta; el worker de recovery lo
   * construye por su cuenta, así que se ejercita por su propio camino real
   * (`runInboxTick`) y no por una imitación.
   */
  it('inline / after(): comprobante retenido, imagen normal autorizada', async () => {
    for (const via of ['inline', 'after']) {
      const a = agenteEspiado();
      const { intake } = intakeQueDice((w) =>
        w === IMAGE_NO_CAPTION_WAMID ? 'payment_proof' : 'not_payment_proof',
      );
      await processClaimedEvent(
        row(lote(imageNoCaptionEnvelope(), imageWithCaptionEnvelope()), `evt-${via}`),
        params({ agentChannel: a.channel, paymentProofIntake: intake }),
      );
      const { burst } = a.recibido[0];
      expect(burst[0].image, via).toBeNull();
      expect(burst[1].image, via).not.toBeNull();
      expect(a.resolveCalls, via).toEqual(['resolveImage']);
    }
  });

  it('worker de recovery: misma política, por su camino real', async () => {
    const a = agenteEspiado();
    const { intake } = intakeQueDice('payment_proof');

    let entregada = false;
    const selector = {
      async claimDue() {
        if (entregada) return [];
        entregada = true;
        return [row(lote(imageNoCaptionEnvelope(), textoEnvelope('wamid.T', 'ya pagué')))];
      },
    };

    const resultado = await runInboxTick({
      selector: selector as never,
      processing: params({ agentChannel: a.channel, paymentProofIntake: intake }),
    });

    expect(resultado).toMatchObject({ ok: true, claimed: 1, processed: 1 });
    esperaCeroVision(a, 'worker');
    // Y el texto del lote sigue llegando.
    expect(a.dumpModelo()).toContain('ya pagué');
  });
});
