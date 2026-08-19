import { describe, it, expect } from 'vitest';
import {
  KAPSO_EVENT_RECEIVED,
  KAPSO_EVENT_SENT,
  parseKapsoProvenance,
  toContentType,
} from './provenance';

/**
 * Contrato oficial de Kapso para WhatsApp Coexistence (Fase 6D.2F.2B).
 *
 * Un mensaje enviado a mano desde WhatsApp Business App llega como
 * `whatsapp.message.sent` con `kapso.direction='outbound'` y
 * `kapso.origin='business_app'`. Nuestros envíos por API traen `cloud_api`.
 *
 * `sent`, `delivered` y `read` describen el MISMO wamid; en Coexistence los dos
 * últimos pueden no llegar nunca, así que el takeover se decide en `sent`.
 */

interface MessageOverrides {
  id?: string | null;
  type?: string;
  direction?: string | null;
  origin?: string | null;
  status?: string;
}

function payload(over: MessageOverrides = {}, root: Record<string, unknown> = {}) {
  const kapso: Record<string, unknown> = { status: over.status ?? 'sent' };
  if (over.direction !== null) kapso.direction = over.direction ?? 'outbound';
  if (over.origin !== null) kapso.origin = over.origin ?? 'business_app';

  return {
    phone_number_id: 'PNID_ROOT',
    message: {
      ...(over.id === null ? {} : { id: over.id ?? 'wamid.HUMAN_1' }),
      type: over.type ?? 'text',
      text: { body: 'te confirmo por aqui' },
      from: '59180000000', // numero del NEGOCIO en un saliente
      to: '59170000001',
      timestamp: 1730092860,
      kapso,
    },
    conversation: {
      id: 'conv-abc',
      phone_number: '+591 700-00001',
      phone_number_id: 'PNID_CONV',
    },
    ...root,
  };
}

function inboundPayload(message: Record<string, unknown> = {}) {
  return {
    phone_number_id: 'PNID_ROOT',
    message: {
      id: 'wamid.IN_1',
      type: 'text',
      text: { body: 'quiero pedir' },
      from: '59170000001',
      timestamp: 1730092860,
      kapso: { direction: 'inbound', status: 'received' },
      ...message,
    },
    conversation: { id: 'conv-abc', phone_number: '59170000001' },
  };
}

describe('provenance — A/B: takeover solo con sent + outbound + business_app', () => {
  it('A · sent + outbound + business_app => human_outbound', () => {
    const result = parseKapsoProvenance(KAPSO_EVENT_SENT, payload());
    expect(result.kind).toBe('human_outbound');
  });

  it('B · sent + cloud_api => system_outbound (envio nuestro, NO humano)', () => {
    const result = parseKapsoProvenance(KAPSO_EVENT_SENT, payload({ origin: 'cloud_api' }));
    expect(result.kind).toBe('system_outbound');
  });

  it('exige los TRES campos: sin direction no es humano', () => {
    expect(parseKapsoProvenance(KAPSO_EVENT_SENT, payload({ direction: null })).kind)
      .toBe('system_outbound');
  });

  it('exige los TRES campos: sin origin no es humano', () => {
    expect(parseKapsoProvenance(KAPSO_EVENT_SENT, payload({ origin: null })).kind)
      .toBe('system_outbound');
  });

  it('direction=inbound con business_app tampoco es takeover', () => {
    expect(parseKapsoProvenance(KAPSO_EVENT_SENT, payload({ direction: 'inbound' })).kind)
      .toBe('system_outbound');
  });

  it('un origin desconocido NO se trata como humano (sin heuristicas)', () => {
    expect(parseKapsoProvenance(KAPSO_EVENT_SENT, payload({ origin: 'otro_canal' })).kind)
      .toBe('system_outbound');
  });
});

describe('provenance — C/D: lifecycle nunca es un mensaje humano nuevo', () => {
  it('C · delivered + business_app => lifecycle', () => {
    const result = parseKapsoProvenance('whatsapp.message.delivered', payload({ status: 'delivered' }));
    expect(result.kind).toBe('lifecycle');
  });

  it('D · read + business_app => lifecycle', () => {
    const result = parseKapsoProvenance('whatsapp.message.read', payload({ status: 'read' }));
    expect(result.kind).toBe('lifecycle');
  });

  it('failed + business_app => lifecycle', () => {
    expect(parseKapsoProvenance('whatsapp.message.failed', payload({ status: 'failed' })).kind)
      .toBe('lifecycle');
  });

  it('el lifecycle conserva el wamid para correlacionar, sin crear mensaje', () => {
    const result = parseKapsoProvenance('whatsapp.message.delivered', payload());
    expect(result).toMatchObject({ kind: 'lifecycle', providerMessageId: 'wamid.HUMAN_1' });
  });
});

describe('provenance — E: entrante del cliente', () => {
  it('E · whatsapp.message.received => customer_inbound', () => {
    const result = parseKapsoProvenance(KAPSO_EVENT_RECEIVED, inboundPayload());
    expect(result.kind).toBe('customer_inbound');
  });

  it('un evento desconocido no se clasifica', () => {
    expect(parseKapsoProvenance('whatsapp.message.otro', inboundPayload()).kind).toBe('unknown');
  });

  it('payload vacio o sin message no revienta', () => {
    expect(parseKapsoProvenance(KAPSO_EVENT_RECEIVED, null).kind).toBe('unknown');
    expect(parseKapsoProvenance(KAPSO_EVENT_RECEIVED, {}).kind).toBe('unknown');
    expect(parseKapsoProvenance(KAPSO_EVENT_SENT, { message: 'no-es-objeto' }).kind).toBe('unknown');
  });
});

describe('provenance — F/G: phone_number_id', () => {
  it('F · prefiere payload.phone_number_id de la raiz', () => {
    const result = parseKapsoProvenance(KAPSO_EVENT_SENT, payload());
    expect(result).toMatchObject({ message: { providerPhoneNumberId: 'PNID_ROOT' } });
  });

  it('G · cae a conversation.phone_number_id si falta en la raiz', () => {
    const body = payload();
    delete (body as Record<string, unknown>).phone_number_id;
    const result = parseKapsoProvenance(KAPSO_EVENT_SENT, body);
    expect(result).toMatchObject({ message: { providerPhoneNumberId: 'PNID_CONV' } });
  });

  it('null cuando no hay ninguno (no bloquea persistir historial)', () => {
    const body = payload();
    delete (body as Record<string, unknown>).phone_number_id;
    delete (body.conversation as Record<string, unknown>).phone_number_id;
    expect(parseKapsoProvenance(KAPSO_EVENT_SENT, body))
      .toMatchObject({ message: { providerPhoneNumberId: null } });
  });
});

describe('provenance — H: identidad durable del cliente', () => {
  it('H · normaliza conversation.phone_number a solo digitos', () => {
    const result = parseKapsoProvenance(KAPSO_EVENT_SENT, payload());
    expect(result).toMatchObject({ message: { customerPhone: '59170000001' } });
  });

  it('en un SALIENTE nunca usa message.from (ese es el numero del negocio)', () => {
    const result = parseKapsoProvenance(KAPSO_EVENT_SENT, payload());
    // message.from = 59180000000 (negocio). La identidad debe ser el cliente.
    expect(result).toMatchObject({ message: { customerPhone: '59170000001' } });
  });

  it('en un saliente sin conversation.phone_number cae a message.to', () => {
    const body = payload();
    delete (body.conversation as Record<string, unknown>).phone_number;
    expect(parseKapsoProvenance(KAPSO_EVENT_SENT, body))
      .toMatchObject({ message: { customerPhone: '59170000001' } });
  });

  it('en un entrante sin conversation.phone_number cae a message.from', () => {
    const body = inboundPayload();
    delete (body.conversation as Record<string, unknown>).phone_number;
    expect(parseKapsoProvenance(KAPSO_EVENT_RECEIVED, body))
      .toMatchObject({ message: { customerPhone: '59170000001' } });
  });

  it('sin telefono resoluble devuelve cadena vacia (el core lo rechaza)', () => {
    const body = inboundPayload();
    delete (body.conversation as Record<string, unknown>).phone_number;
    delete (body.message as Record<string, unknown>).from;
    expect(parseKapsoProvenance(KAPSO_EVENT_RECEIVED, body))
      .toMatchObject({ message: { customerPhone: '' } });
  });

  it('conversation.id se expone como referencia tecnica, no como identidad', () => {
    expect(parseKapsoProvenance(KAPSO_EVENT_SENT, payload()))
      .toMatchObject({ message: { providerConversationId: 'conv-abc' } });
  });
});

describe('provenance — contenido y tipo, sin marcadores artificiales', () => {
  it('mapea los tipos del dominio de 0014 y degrada el resto a unknown', () => {
    for (const t of ['text', 'image', 'audio', 'video', 'document', 'sticker', 'location', 'interactive']) {
      expect(toContentType(t)).toBe(t);
    }
    expect(toContentType('contacts')).toBe('unknown');
    expect(toContentType('reaction')).toBe('unknown');
    expect(toContentType(null)).toBe('unknown');
  });

  it('texto: guarda el body real', () => {
    expect(parseKapsoProvenance(KAPSO_EVENT_RECEIVED, inboundPayload()))
      .toMatchObject({ message: { contentType: 'text', content: 'quiero pedir' } });
  });

  it('ubicacion: content NULL y coordenadas en metadata (NUNCA "[LOCATION]")', () => {
    const body = inboundPayload({
      type: 'location',
      text: undefined,
      location: { latitude: -17.7833, longitude: -63.1821, address: 'Av. X', name: 'Casa' },
    });
    const result = parseKapsoProvenance(KAPSO_EVENT_RECEIVED, body);
    expect(result).toMatchObject({
      message: {
        contentType: 'location',
        content: null,
        metadata: { latitude: -17.7833, longitude: -63.1821 },
      },
    });
    // La direccion textual no se copia: metadata es estructural, no PII extra.
    expect(JSON.stringify(result)).not.toContain('Av. X');
  });

  it('imagen con caption real: la guarda; sin caption: NULL', () => {
    const withCaption = parseKapsoProvenance(
      KAPSO_EVENT_RECEIVED,
      inboundPayload({ type: 'image', image: { caption: 'esta es mi ubicacion' } }),
    );
    expect(withCaption).toMatchObject({ message: { contentType: 'image', content: 'esta es mi ubicacion' } });

    const bare = parseKapsoProvenance(
      KAPSO_EVENT_RECEIVED,
      inboundPayload({ type: 'image', image: {} }),
    );
    expect(bare).toMatchObject({ message: { contentType: 'image', content: null } });
  });

  it('sticker: sin texto y sin metadata inventada', () => {
    expect(parseKapsoProvenance(KAPSO_EVENT_RECEIVED, inboundPayload({ type: 'sticker' })))
      .toMatchObject({ message: { contentType: 'sticker', content: null, metadata: null } });
  });

  it('interactivo: body real y su tipo como metadata estructural', () => {
    const body = inboundPayload({
      type: 'interactive',
      interactive: { type: 'nfm_reply', body: { text: 'pedido enviado' } },
    });
    expect(parseKapsoProvenance(KAPSO_EVENT_RECEIVED, body)).toMatchObject({
      message: {
        contentType: 'interactive',
        content: 'pedido enviado',
        metadata: { interactive_type: 'nfm_reply' },
      },
    });
  });

  it('un texto sin body utilizable se degrada a unknown, no a text con NULL', () => {
    // 0014 exige contenido real cuando content_type='text'. Anunciar 'text' con
    // content NULL sería una fila imposible de insertar: se degrada el TIPO en
    // vez de inventar contenido.
    for (const broken of [{ text: {} }, { text: { body: '   ' } }, { text: undefined }]) {
      expect(parseKapsoProvenance(KAPSO_EVENT_RECEIVED, inboundPayload(broken))).toMatchObject({
        message: { contentType: 'unknown', content: null },
      });
    }
  });

  it('nunca fabrica marcadores internos', () => {
    const body = inboundPayload({ type: 'location', text: undefined, location: {} });
    const json = JSON.stringify(parseKapsoProvenance(KAPSO_EVENT_RECEIVED, body));
    for (const marker of ['[LOCATION]', '[IMAGE]', '[MEDIA_SENT]', '[PRODUCT_CONTEXT]']) {
      expect(json).not.toContain(marker);
    }
  });
});

describe('provenance — timestamp del proveedor', () => {
  it('acepta Unix en segundos y lo normaliza a ISO', () => {
    expect(parseKapsoProvenance(KAPSO_EVENT_RECEIVED, inboundPayload()))
      .toMatchObject({ message: { messageTimestamp: new Date(1730092860 * 1000).toISOString() } });
  });

  it('un timestamp ilegible queda en null; el fallback lo decide el core', () => {
    expect(parseKapsoProvenance(KAPSO_EVENT_RECEIVED, inboundPayload({ timestamp: 'basura' })))
      .toMatchObject({ message: { messageTimestamp: null } });
  });
});

describe('provenance — status y wamid', () => {
  it('expone status y wamid reales del proveedor', () => {
    expect(parseKapsoProvenance(KAPSO_EVENT_SENT, payload())).toMatchObject({
      message: { providerMessageId: 'wamid.HUMAN_1', status: 'sent', origin: 'business_app' },
    });
  });

  it('sin message.id el wamid queda null (el core lo rechaza por idempotencia)', () => {
    expect(parseKapsoProvenance(KAPSO_EVENT_SENT, payload({ id: null })))
      .toMatchObject({ message: { providerMessageId: null } });
  });
});
