import { describe, it, expect } from 'vitest';
import {
  DEFAULT_MATCH_WINDOW_MS,
  reconcileOutbound,
  selectMatchingCandidates,
  type ReconciliationInput,
} from './reconciliation';
import {
  normalizeOutboundMessage,
  type NormalizedOutboundMessage,
} from '@/lib/kapso/message-history';

const ORDER_NUMBER = 'ORD-000006';
const PHONE = '59170000001';
const STARTED_AT = '2026-07-21T14:00:00.000Z';

/** Construye un candidato con `timestampMs` coherente con el ISO indicado. */
function at(iso: string): Pick<NormalizedOutboundMessage, 'timestamp' | 'timestampMs'> {
  return { timestamp: iso, timestampMs: Date.parse(iso) };
}

function candidate(overrides: Partial<NormalizedOutboundMessage> = {}): NormalizedOutboundMessage {
  return {
    externalMessageId: 'wamid.CONF_1',
    ...at('2026-07-21T14:00:30.000Z'),
    recipient: PHONE,
    direction: 'outbound',
    type: 'confirmation',
    orderNumber: ORDER_NUMBER,
    status: 'sent',
    conversationId: 'conv-1',
    ...overrides,
  };
}

function input(overrides: Partial<ReconciliationInput> = {}): ReconciliationInput {
  return {
    orderNumber: ORDER_NUMBER,
    normalizedRecipient: PHONE,
    notificationType: 'confirmation',
    attemptStartedAt: STARTED_AT,
    candidates: [candidate()],
    ...overrides,
  };
}

describe('reconcileOutbound — coincidencia', () => {
  it('exactamente un saliente confirmado -> matched', () => {
    expect(reconcileOutbound(input())).toEqual({
      result: 'matched',
      externalMessageId: 'wamid.CONF_1',
      status: 'sent',
    });
  });

  it('delivered y read también cuentan como envío confirmado', () => {
    for (const status of ['delivered', 'read']) {
      const res = reconcileOutbound(input({ candidates: [candidate({ status })] }));
      expect(res.result).toBe('matched');
    }
  });

  it('sin candidatos -> not_found', () => {
    expect(reconcileOutbound(input({ candidates: [] }))).toEqual({ result: 'not_found' });
  });

  it('empareja una solicitud de ubicación por su tipo', () => {
    const res = reconcileOutbound(
      input({
        notificationType: 'location_request',
        candidates: [candidate({ type: 'location_request', externalMessageId: 'wamid.LOC_1' })],
      }),
    );
    expect(res).toEqual({
      result: 'matched',
      externalMessageId: 'wamid.LOC_1',
      status: 'sent',
    });
  });
});

describe('reconcileOutbound — filtros de descarte', () => {
  it('descarta entrantes (direction != outbound)', () => {
    const res = reconcileOutbound(input({ candidates: [candidate({ direction: 'inbound' })] }));
    expect(res).toEqual({ result: 'not_found' });
  });

  it('descarta destinatario distinto', () => {
    const res = reconcileOutbound(input({ candidates: [candidate({ recipient: '59170000002' })] }));
    expect(res).toEqual({ result: 'not_found' });
  });

  it('exige el número de pedido como token exacto', () => {
    // Distinto pedido.
    expect(
      reconcileOutbound(input({ candidates: [candidate({ orderNumber: 'ORD-000007' })] })),
    ).toEqual({ result: 'not_found' });
    // Sin número extraído.
    expect(reconcileOutbound(input({ candidates: [candidate({ orderNumber: null })] }))).toEqual({
      result: 'not_found',
    });
  });

  it('no confunde una notificación de otro tipo', () => {
    const res = reconcileOutbound(
      input({
        notificationType: 'confirmation',
        candidates: [candidate({ type: 'location_request' })],
      }),
    );
    expect(res).toEqual({ result: 'not_found' });
  });

  it('la ventana por defecto es de 300 s', () => {
    expect(DEFAULT_MATCH_WINDOW_MS).toBe(300_000);
  });

  it('un mensaje a los 3 minutos SÍ coincide', () => {
    const threeMinutes = candidate(at('2026-07-21T14:03:00.000Z'));
    expect(reconcileOutbound(input({ candidates: [threeMinutes] })).result).toBe('matched');
  });

  it('un mensaje después de 5 minutos no coincide', () => {
    const beyond = candidate(at('2026-07-21T14:05:30.000Z'));
    expect(reconcileOutbound(input({ candidates: [beyond] }))).toEqual({ result: 'not_found' });
  });

  it('descarta mensajes anteriores al intento', () => {
    const tooEarly = candidate(at('2026-07-21T13:50:00.000Z'));
    expect(reconcileOutbound(input({ candidates: [tooEarly] }))).toEqual({ result: 'not_found' });
  });

  it('tolera un desfase de reloj de 5 s hacia atrás', () => {
    const slightlyBefore = candidate(at('2026-07-21T13:59:58.000Z'));
    expect(reconcileOutbound(input({ candidates: [slightlyBefore] })).result).toBe('matched');

    const tooFarBack = candidate(at('2026-07-21T13:59:50.000Z'));
    expect(reconcileOutbound(input({ candidates: [tooFarBack] })).result).toBe('not_found');
  });

  it('la ventana sigue siendo configurable', () => {
    const late = candidate(at('2026-07-21T14:06:00.000Z'));
    expect(reconcileOutbound(input({ candidates: [late] })).result).toBe('not_found');
    expect(reconcileOutbound(input({ candidates: [late], windowMs: 600_000 })).result).toBe(
      'matched',
    );
  });

  it('un timestamp inválido no puede coincidir', () => {
    const noTimestamp = candidate({ timestamp: null, timestampMs: null });
    expect(reconcileOutbound(input({ candidates: [noTimestamp] }))).toEqual({
      result: 'not_found',
    });

    const notANumber = candidate({ timestamp: 'ayer', timestampMs: Number.NaN });
    expect(reconcileOutbound(input({ candidates: [notANumber] }))).toEqual({
      result: 'not_found',
    });
  });

  it('un Unix en segundos ya normalizado SÍ coincide', () => {
    // 1784irrelevante: lo importante es que timestampMs venga resuelto.
    const unix = candidate({
      timestamp: '2026-07-21T14:02:00.000Z',
      timestampMs: Date.parse('2026-07-21T14:02:00.000Z'),
    });
    expect(reconcileOutbound(input({ candidates: [unix] })).result).toBe('matched');
  });

  it('attemptStartedAt inválido no empareja nada', () => {
    expect(selectMatchingCandidates(input({ attemptStartedAt: 'no-es-fecha' }))).toEqual([]);
  });
});

describe('reconcileOutbound — ambigüedad y fallo del proveedor', () => {
  it('dos confirmados -> ambiguous, nunca se elige uno', () => {
    const res = reconcileOutbound(
      input({
        candidates: [
          candidate({ externalMessageId: 'wamid.A' }),
          candidate({ externalMessageId: 'wamid.B', status: 'delivered' }),
        ],
      }),
    );
    expect(res).toEqual({ result: 'ambiguous', count: 2 });
    expect(JSON.stringify(res)).not.toContain('wamid.A');
    expect(JSON.stringify(res)).not.toContain('wamid.B');
  });

  it('dos mensajes del mismo pedido dentro de 5 minutos -> ambiguous', () => {
    const res = reconcileOutbound(
      input({
        candidates: [
          candidate({ externalMessageId: 'wamid.EARLY', ...at('2026-07-21T14:00:10.000Z') }),
          candidate({
            externalMessageId: 'wamid.LATE',
            ...at('2026-07-21T14:04:50.000Z'),
            status: 'delivered',
          }),
        ],
      }),
    );

    expect(res).toEqual({ result: 'ambiguous', count: 2 });
    // Ni el más reciente ni el primero: no se escoge ninguno.
    const serialized = JSON.stringify(res);
    expect(serialized).not.toContain('wamid.EARLY');
    expect(serialized).not.toContain('wamid.LATE');
  });

  it('solo un fallido -> provider_failed', () => {
    const res = reconcileOutbound(
      input({ candidates: [candidate({ status: 'failed', externalMessageId: 'wamid.F' })] }),
    );
    expect(res).toEqual({ result: 'provider_failed', externalMessageId: 'wamid.F' });
  });

  it('un confirmado gana sobre un fallido previo', () => {
    const res = reconcileOutbound(
      input({
        candidates: [
          candidate({ status: 'failed', externalMessageId: 'wamid.F' }),
          candidate({ status: 'sent', externalMessageId: 'wamid.OK' }),
        ],
      }),
    );
    expect(res).toEqual({ result: 'matched', externalMessageId: 'wamid.OK', status: 'sent' });
  });

  it('estado no concluyente -> ambiguous (no se reintenta a ciegas)', () => {
    for (const status of ['pending', 'queued', null]) {
      const res = reconcileOutbound(input({ candidates: [candidate({ status })] }));
      expect(res.result).toBe('ambiguous');
    }
  });

  it('varios fallidos -> ambiguous (no hay id único que persistir)', () => {
    const res = reconcileOutbound(
      input({
        candidates: [
          candidate({ status: 'failed', externalMessageId: 'wamid.F1' }),
          candidate({ status: 'failed', externalMessageId: 'wamid.F2' }),
        ],
      }),
    );
    expect(res).toEqual({ result: 'ambiguous', count: 2 });
  });
});

describe('reconcileOutbound — seguridad del resultado', () => {
  it('nunca expone teléfono, contenido ni conversación', () => {
    const results = [
      reconcileOutbound(input()),
      reconcileOutbound(input({ candidates: [] })),
      reconcileOutbound(input({ candidates: [candidate({ status: 'failed' })] })),
      reconcileOutbound(
        input({ candidates: [candidate({ externalMessageId: 'a' }), candidate({ externalMessageId: 'b' })] }),
      ),
    ];

    for (const res of results) {
      const serialized = JSON.stringify(res);
      expect(serialized).not.toContain(PHONE);
      expect(serialized).not.toContain('conv-1');
      expect(serialized).not.toContain('Recibí');
      expect(serialized).not.toContain('ubicación');
    }
  });

  it('solo incluye externalMessageId cuando hay uno único', () => {
    const matched = reconcileOutbound(input());
    expect(matched).toHaveProperty('externalMessageId');

    const ambiguous = reconcileOutbound(
      input({ candidates: [candidate({ externalMessageId: 'a' }), candidate({ externalMessageId: 'b' })] }),
    );
    expect(ambiguous).not.toHaveProperty('externalMessageId');
  });
});

describe('6D.1 — reconciliación de confirmación-QR (imagen) de extremo a extremo', () => {
  // Payload real de una imagen QR saliente, tal como llegaría de Kapso.
  function imageQr(caption: string, to = PHONE) {
    return {
      id: 'wamid.IMG_QR',
      timestamp: '2026-07-21T14:00:30.000Z',
      type: 'image',
      to,
      image: { link: 'https://sarco-restaurant.vercel.app/payment/qr-2026.jpeg', caption },
      kapso: { direction: 'outbound', status: 'sent', whatsapp_conversation_id: 'conv-1' },
    };
  }

  const CAPTION = `📦 ¡Recibí tu pedido ${ORDER_NUMBER}!\n\n💳 Escanea este QR para pagar tu pedido.`;

  it('la imagen QR con el número de pedido en el caption SÍ empareja la confirmación', () => {
    const cand = normalizeOutboundMessage(imageQr(CAPTION))!;
    const res = reconcileOutbound(input({ candidates: [cand] }));
    expect(res.result).toBe('matched');
  });

  it('imagen sin número de pedido en el caption → no empareja (queda unknown)', () => {
    const cand = normalizeOutboundMessage(imageQr('Escanea este QR para pagar.'))!;
    expect(selectMatchingCandidates(input({ candidates: [cand] }))).toEqual([]);
  });

  it('imagen de OTRO pedido → no empareja', () => {
    const cand = normalizeOutboundMessage(imageQr('📦 ¡Recibí tu pedido ORD-999999!'))!;
    expect(selectMatchingCandidates(input({ candidates: [cand] }))).toEqual([]);
  });

  it('imagen al destinatario incorrecto → no empareja', () => {
    const cand = normalizeOutboundMessage(imageQr(CAPTION, '59170000002'))!;
    expect(selectMatchingCandidates(input({ candidates: [cand] }))).toEqual([]);
  });
});
