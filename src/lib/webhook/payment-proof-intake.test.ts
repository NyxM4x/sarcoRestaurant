/**
 * Recorrido de un comprobante DESDE LA FRONTERA DEL WEBHOOK (§5.4).
 *
 * No llama al motor directamente: entra por `processClaimedEvent`, que es el
 * punto por el que pasan las tres vías (inline, asíncrona y worker). Usa el
 * fixture REAL de imagen del proyecto —contrato observado en Production el
 * 18-08-2026— para que lo que se prueba sea el payload que de verdad llega.
 */
import { describe, it, expect } from 'vitest';
import { processClaimedEvent, type HandleKapsoWebhookParams, type WebhookEventRow } from './kapso';
import {
  IMAGE_CAPTION_WAMID,
  IMAGE_NO_CAPTION_WAMID,
  imageNoCaptionEnvelope,
  imageWithCaptionEnvelope,
} from '@/lib/kapso/channel/image.fixtures';

const KAPSO_EVENT = 'whatsapp.message.received';

function row(payload: unknown): WebhookEventRow {
  return {
    id: 'evt-1',
    eventId: 'evt-1',
    eventName: KAPSO_EVENT,
    payload,
    attempts: 0,
    maxAttempts: 5,
  } as unknown as WebhookEventRow;
}

/** Params mínimos: solo lo que este camino necesita. */
function params(
  intake?: HandleKapsoWebhookParams['paymentProofIntake'],
): HandleKapsoWebhookParams {
  return {
    rawBody: '',
    headers: { signature: null, version: null, event: KAPSO_EVENT, idempotencyKey: null },
    secret: 'x'.repeat(32),
    store: {
      markProcessed: async () => {},
      markFailed: async () => {},
      releaseForRetry: async () => {},
    } as unknown as HandleKapsoWebhookParams['store'],
    confirmOrder: async () => ({ ok: false, reason: 'not_found' }) as never,
    ensureLocationRequest: async () => ({ ok: false }) as never,
    attachOrderLocation: async () => ({ ok: false }) as never,
    sendMenuCta: async () => ({ ok: false }) as never,
    paymentProofIntake: intake,
  } as unknown as HandleKapsoWebhookParams;
}

describe('frontera del webhook → motor de comprobantes', () => {
  it('una imagen entrante llega al motor con el WAMID y el teléfono reales', async () => {
    const vistos: Array<{ wamid: string; phone: string; mime: string | null }> = [];
    const res = await processClaimedEvent(
      row(imageNoCaptionEnvelope()),
      params(async (input) => {
        vistos.push({
          wamid: input.sourceMessageId,
          phone: input.customerPhone,
          mime: input.attachment?.facts.mimeType ?? null,
        });
        return { result: 'captured' };
      }),
    );

    expect(res.outcome).toBe('processed');
    expect(vistos).toHaveLength(1);
    expect(vistos[0].wamid).toBe(IMAGE_NO_CAPTION_WAMID);
    expect(vistos[0].phone).toBeTruthy();
    expect(vistos[0].mime).toBe('image/jpeg');
  });

  it('el resultado del motor viaja en el cuerpo, sin datos del cliente', async () => {
    const res = await processClaimedEvent(
      row(imageWithCaptionEnvelope()),
      params(async () => ({ result: 'captured' })),
    );
    expect(res.body).toMatchObject({ payment_proofs: ['captured'] });
    const json = JSON.stringify(res.body);
    expect(json).not.toContain(IMAGE_CAPTION_WAMID);
    expect(json).not.toContain('59100000000');
  });

  it('la imagen CON caption también se captura (el caption no la descarta)', async () => {
    const vistos: string[] = [];
    await processClaimedEvent(
      row(imageWithCaptionEnvelope()),
      params(async (i) => {
        vistos.push(i.sourceMessageId);
        return { result: 'captured' };
      }),
    );
    expect(vistos).toEqual([IMAGE_CAPTION_WAMID]);
  });
});

describe('el puerto es un interruptor de apagado', () => {
  it('sin `paymentProofIntake` el webhook se comporta como antes', async () => {
    const res = await processClaimedEvent(row(imageNoCaptionEnvelope()), params(undefined));
    expect(res.outcome).toBe('processed');
    expect(res.body).not.toHaveProperty('payment_proofs');
  });
});

describe('un comprobante problemático NO tumba la entrega', () => {
  it('si el motor lanza, el evento sigue procesándose', async () => {
    const res = await processClaimedEvent(
      row(imageNoCaptionEnvelope()),
      params(async () => {
        throw new Error('boom');
      }),
    );
    expect(res.outcome).toBe('processed');
    expect(res.body).toMatchObject({ payment_proofs: ['failed'] });
  });

  it('un resultado `failed` del motor tampoco rompe el webhook', async () => {
    const res = await processClaimedEvent(
      row(imageNoCaptionEnvelope()),
      params(async () => ({ result: 'failed' })),
    );
    expect(res.outcome).toBe('processed');
  });
});

describe('regresión: lo que NO es un comprobante', () => {
  it('un mensaje de texto no llama al motor', async () => {
    const vistos: string[] = [];
    const texto = {
      message: {
        id: 'wamid.TEXTO',
        type: 'text',
        from: '59100000000',
        text: { body: 'hola' },
        kapso: { direction: 'inbound', origin: 'customer' },
      },
      conversation: { id: '00000000-0000-4000-8000-000000000002', phone_number: '59100000000' },
      phone_number_id: '000000000000000',
    };
    const res = await processClaimedEvent(
      row(texto),
      params(async (i) => {
        vistos.push(i.sourceMessageId);
        return { result: 'captured' };
      }),
    );
    expect(vistos).toEqual([]);
    expect(res.body).not.toHaveProperty('payment_proofs');
  });

  it('un evento de ciclo de vida no llama al motor', async () => {
    const vistos: string[] = [];
    const lifecycle = {
      message: { id: 'wamid.X', kapso: { status: 'delivered', origin: 'cloud_api' } },
      conversation: { id: '00000000-0000-4000-8000-000000000002' },
    };
    await processClaimedEvent(
      { ...row(lifecycle), eventName: 'whatsapp.message.delivered' } as WebhookEventRow,
      params(async (i) => {
        vistos.push(i.sourceMessageId);
        return { result: 'captured' };
      }),
    );
    expect(vistos).toEqual([]);
  });
});

describe('media que el canal no sabe parsear', () => {
  /**
   * Un archivo sin parser NO puede evaporarse.
   *
   * Hasta ahora `capturePaymentProofs` hacía `continue` en cuanto no había
   * `message.image`: sin fila, sin log y —porque el agente descarta ese
   * contenido— sin respuesta al cliente. Un comprobante en PDF, que es lo normal
   * si se descarga de la app del banco, desaparecía sin que se enterara nadie.
   *
   * Se prueba con AUDIO a propósito, no con documento: el contrato del adjunto
   * de documento todavía no se ha observado en un payload real, y un test
   * escrito contra una forma inventada probaría la invención. El audio recorre
   * exactamente el mismo camino y no depende de nada por confirmar.
   */
  function mediaEnvelope(tipo: string, contentType: string | null): Record<string, unknown> {
    return {
      message: {
        id: `wamid.MEDIA_${tipo.toUpperCase()}`,
        type: tipo,
        from: '59100000000',
        timestamp: 1_760_000_000,
        kapso: {
          direction: 'inbound',
          origin: 'business_app',
          has_media: true,
          ...(contentType === null ? {} : { media_data: { content_type: contentType } }),
        },
      },
      conversation: {
        id: '00000000-0000-4000-8000-000000000002',
        phone_number: '59100000000',
      },
      phone_number_id: '000000000000000',
    };
  }

  it('un audio del cliente llega al motor SIN adjunto y con su tipo declarado', async () => {
    const vistos: Array<{ wamid: string; tieneAdjunto: boolean; mime: string | null }> = [];

    const res = await processClaimedEvent(
      row(mediaEnvelope('audio', 'audio/ogg')),
      params(async (input) => {
        vistos.push({
          wamid: input.sourceMessageId,
          tieneAdjunto: input.attachment !== null,
          mime: input.declaredMimeType ?? null,
        });
        return { result: 'failed' };
      }),
    );

    expect(res.outcome).toBe('processed');
    expect(vistos).toHaveLength(1);
    // Sin adjunto: no hay nada que descargar, y el motor lo sabe.
    expect(vistos[0].tieneAdjunto).toBe(false);
    // Pero sí se sabe QUÉ llegó, sin haber tocado la red.
    expect(vistos[0].mime).toBe('audio/ogg');
  });

  it('sin `media_data` el tipo queda en null y aun así se registra', async () => {
    // Si Kapso pusiera el tipo en otro campo, se degrada: se pierde la etiqueta,
    // nunca el hecho de que llegó un archivo.
    const vistos: Array<string | null> = [];
    await processClaimedEvent(
      row(mediaEnvelope('video', null)),
      params(async (input) => {
        vistos.push(input.declaredMimeType ?? null);
        return { result: 'failed' };
      }),
    );
    expect(vistos).toEqual([null]);
  });

  it('un sticker NO abre un comprobante: nadie paga con un sticker', async () => {
    // La lista es de cosas que plausiblemente son un pago, no de todo lo que no
    // sabemos leer. Admitir stickers solo llenaría el panel de ruido.
    const vistos: string[] = [];
    await processClaimedEvent(
      row(mediaEnvelope('sticker', 'image/webp')),
      params(async (i) => {
        vistos.push(i.sourceMessageId);
        return { result: 'failed' };
      }),
    );
    expect(vistos).toEqual([]);
  });

  it('un texto suelto sigue sin llamar al motor', async () => {
    // La red de seguridad es para ARCHIVOS. Un mensaje de texto no es un
    // comprobante fallido por mucho que diga "ya pagué".
    const vistos: string[] = [];
    await processClaimedEvent(
      row({
        message: {
          id: 'wamid.TEXTO',
          type: 'text',
          text: { body: 'ya pagué' },
          from: '59100000000',
          kapso: { direction: 'inbound', origin: 'business_app' },
        },
        conversation: { id: '00000000-0000-4000-8000-000000000002', phone_number: '59100000000' },
      }),
      params(async (i) => {
        vistos.push(i.sourceMessageId);
        return { result: 'failed' };
      }),
    );
    expect(vistos).toEqual([]);
  });
});
