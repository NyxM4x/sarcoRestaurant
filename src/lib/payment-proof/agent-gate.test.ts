import { describe, it, expect } from 'vitest';
import {
  PROOF_TARGET_TTL_MS,
  decideAssociation,
  overrideAsDuplicate,
  type ProofCandidateOrder,
} from './association';
import {
  EMPTY_VISION_ALLOWLIST,
  authorizesVision,
  buildVisionAllowlist,
  classifyForAgentGate,
  isProofBearing,
  isVisionAuthorized,
  withholdAttachments,
  withholdAttachmentsFromBurst,
  type ProofClassification,
} from './agent-gate';
import type { ProvenanceMessage } from '@/lib/kapso/channel/provenance';
import type { OrderStatus } from '@/types';

/**
 * LA PUERTA: qué adjunto puede llegar a OpenAI y cuál no.
 *
 * El contrato es de AUTORIZACIÓN POSITIVA. No se prueba "qué se bloquea" —esa
 * lista siempre se queda corta, y una auditoría demostró exactamente eso— sino
 * "qué se autoriza", que es finito y comprobable: WAMID no vacío + veredicto
 * explícito `not_payment_proof` para ESE WAMID.
 *
 * Las decisiones de enrutado NO se escriben a mano: salen de
 * `decideAssociation`, el mismo motor que corre en producción. Una tabla de
 * veredictos inventados probaría que la puerta sabe leer una tabla; lo que hay
 * que probar es que la puerta y el enrutado no pueden discrepar.
 */

const NOW = Date.parse('2026-08-27T18:00:00.000Z');
const hace = (ms: number) => new Date(NOW - ms).toISOString();

function pedido(orderId: string, over: Partial<ProofCandidateOrder> = {}): ProofCandidateOrder {
  return {
    orderId,
    status: 'confirmed' as OrderStatus,
    paymentMethod: 'qr',
    openedAt: hace(10 * 60_000),
    hasAcceptedPayment: false,
    ...over,
  };
}

function enrutar(over: {
  replyToOrderId?: string | null;
  candidates?: ProofCandidateOrder[];
  duplicateOfProofId?: string | null;
}) {
  return decideAssociation({
    replyToOrderId: over.replyToOrderId ?? null,
    candidates: over.candidates ?? [],
    duplicateOfProofId: over.duplicateOfProofId ?? null,
    nowMs: NOW,
  });
}

// ── El veredicto del motor ──────────────────────────────────────────────────

describe('lo que el motor llama pago no se autoriza', () => {
  const casos: [string, ReturnType<typeof enrutar>][] = [
    ['único pedido QR abierto', enrutar({ candidates: [pedido('ord-1')] })],
    [
      'respuesta al QR',
      enrutar({ replyToOrderId: 'ord-1', candidates: [pedido('ord-1'), pedido('ord-2')] }),
    ],
    ['asociación ambigua', enrutar({ candidates: [pedido('ord-1'), pedido('ord-2')] })],
    [
      'duplicado por contenido',
      overrideAsDuplicate(enrutar({ candidates: [pedido('ord-1')] }), 'proof-anterior'),
    ],
    [
      'pago ya aceptado',
      enrutar({ candidates: [pedido('ord-1', { hasAcceptedPayment: true })] }),
    ],
    [
      'pedido cerrado',
      enrutar({ candidates: [pedido('ord-1', { status: 'delivered' as OrderStatus })] }),
    ],
    [
      'pedido vencido',
      enrutar({ candidates: [pedido('ord-1', { openedAt: hace(PROOF_TARGET_TTL_MS + 60_000) })] }),
    ],
    [
      'responde a un pedido ajeno',
      enrutar({ replyToOrderId: 'ord-de-otro', candidates: [pedido('ord-1')] }),
    ],
  ];

  for (const [nombre, decision] of casos) {
    it(`${nombre}: clasifica payment_proof y NO autoriza`, () => {
      expect(classifyForAgentGate(decision)).toBe('payment_proof');
      expect(authorizesVision(classifyForAgentGate(decision))).toBe(false);
    });
  }

  it('el reenvío tras aceptar el pago es el caso que rompía la regla ingenua', () => {
    // `method` cae a `unresolved` —ningún pedido admite pago— pero la excepción
    // de enrutado dice que sabemos exactamente a cuál iba. Mirar solo el método
    // habría autorizado el comprobante de un pago YA confirmado.
    const d = enrutar({ candidates: [pedido('ord-1', { hasAcceptedPayment: true })] });
    expect(d.method).toBe('unresolved');
    expect(d.routingException).toBe('payment_already_accepted');
    expect(authorizesVision(classifyForAgentGate(d))).toBe(false);
  });
});

describe('una imagen normal sí obtiene permiso', () => {
  it('sin ningún pedido: not_payment_proof y autoriza', () => {
    const d = enrutar({ candidates: [] });
    expect(d.method).toBe('unresolved');
    expect(d.routingException).toBeNull();
    expect(classifyForAgentGate(d)).toBe('not_payment_proof');
    expect(authorizesVision(classifyForAgentGate(d))).toBe(true);
  });

  it('con pedidos, pero ninguno por QR: autoriza', () => {
    const d = enrutar({ candidates: [pedido('ord-1', { paymentMethod: 'cash' })] });
    expect(classifyForAgentGate(d)).toBe('not_payment_proof');
  });

  it('`isProofBearing` es exactamente el complemento de ese caso', () => {
    expect(isProofBearing(enrutar({ candidates: [] }))).toBe(false);
    expect(isProofBearing(enrutar({ candidates: [pedido('ord-1')] }))).toBe(true);
  });
});

// ── GUARDIANES: las excepciones que no pueden volver ────────────────────────

describe('GUARDIÁN · solo `not_payment_proof` explícito autoriza', () => {
  it('la clasificación es la ÚNICA llave, y solo una de las tres abre', () => {
    const todas: ProofClassification[] = ['payment_proof', 'not_payment_proof', 'unknown'];
    const autorizadas = todas.filter(authorizesVision);
    expect(autorizadas).toEqual(['not_payment_proof']);
  });

  it('`unknown` NO autoriza: la duda nunca es un permiso', () => {
    expect(authorizesVision('unknown')).toBe(false);
    expect(buildVisionAllowlist([{ sourceMessageId: 'w.A', classification: 'unknown' }]).size).toBe(
      0,
    );
  });

  it('un veredicto de OTRO WAMID no autoriza a este', () => {
    // La correlación es por identidad exacta, no "había algún veredicto".
    const allowlist = buildVisionAllowlist([
      { sourceMessageId: 'w.OTRO', classification: 'not_payment_proof' },
    ]);
    expect(allowlist.has('w.ESTE')).toBe(false);
    expect(isVisionAuthorized(mensaje({ providerMessageId: 'w.ESTE' }), allowlist)).toBe(false);
  });
});

describe('GUARDIÁN · WAMID ausente nunca permite adjunto', () => {
  const permisiva = buildVisionAllowlist([
    { sourceMessageId: 'w.OK', classification: 'not_payment_proof' },
  ]);

  it('WAMID null no se autoriza', () => {
    expect(isVisionAuthorized(mensaje({ providerMessageId: null }), permisiva)).toBe(false);
  });

  it('WAMID cadena vacía no se autoriza', () => {
    expect(isVisionAuthorized(mensaje({ providerMessageId: '' }), permisiva)).toBe(false);
  });

  it('un WAMID vacío NUNCA entra en la lista, ni con veredicto favorable', () => {
    // Si la cadena vacía entrara, autorizaría a todo mensaje sin identidad.
    const allowlist = buildVisionAllowlist([
      { sourceMessageId: '', classification: 'not_payment_proof' },
    ]);
    expect(allowlist.size).toBe(0);
    expect(isVisionAuthorized(mensaje({ providerMessageId: '' }), allowlist)).toBe(false);
  });

  it('y sus bytes se retiran', () => {
    const sinWamid = mensaje({ providerMessageId: null });
    expect(withholdAttachments(sinWamid, permisiva).image).toBeNull();
  });
});

describe('GUARDIÁN · lista vacía (motor no ejecutado) no permite adjunto', () => {
  it('sin puerto de captura cableado no viaja ningún byte', () => {
    const m = mensaje({ providerMessageId: 'w.CUALQUIERA' });
    expect(isVisionAuthorized(m, EMPTY_VISION_ALLOWLIST)).toBe(false);
    expect(withholdAttachments(m, EMPTY_VISION_ALLOWLIST).image).toBeNull();
  });

  it('la lista vacía NO es un pase libre: retiene el burst entero', () => {
    const burst = [mensaje({ providerMessageId: 'w.1' }), mensaje({ providerMessageId: 'w.2' })];
    const { messages, withheld } = withholdAttachmentsFromBurst(burst, EMPTY_VISION_ALLOWLIST);
    expect(withheld).toBe(2);
    expect(messages.every((m) => m.image === null)).toBe(true);
  });
});

// ── Aplicar la puerta a un burst ────────────────────────────────────────────

function adjunto() {
  return {
    facts: {
      mediaId: 'media-1',
      sha256: 'hash',
      mimeType: 'image/jpeg',
      byteSize: 70332,
      filename: 'comprobante.jpg',
    },
    transient: {
      kapsoMediaUrl: 'https://app.kapso.example/media/token-transitorio',
      link: null,
      metaUrl: null,
    },
    caption: null,
  };
}

function mensaje(over: Partial<ProvenanceMessage> = {}): ProvenanceMessage {
  return {
    providerMessageId: 'wamid.1',
    providerConversationId: 'conv-1',
    customerPhone: '59100000000',
    providerPhoneNumberId: 'pnid-1',
    messageTimestamp: '2026-08-27T18:00:00.000Z',
    direction: 'inbound',
    origin: 'cloud_api',
    status: 'received',
    content: null,
    contentType: 'image',
    metadata: null,
    image: adjunto(),
    ...over,
  };
}

describe('la puerta se lleva los bytes, no el mensaje', () => {
  /** Autoriza SOLO a `wamid.NORMAL`. */
  const allowlist = buildVisionAllowlist([
    { sourceMessageId: 'wamid.NORMAL', classification: 'not_payment_proof' },
    { sourceMessageId: 'wamid.PAGO', classification: 'payment_proof' },
  ]);

  it('el mensaje retenido pierde `image` y `document`, y nada más', () => {
    const original = mensaje({
      providerMessageId: 'wamid.PAGO',
      content: 'ya te pagué',
      document: adjunto(),
    });
    const filtrado = withholdAttachments(original, allowlist);

    expect(filtrado.image).toBeNull();
    expect(filtrado.document).toBeNull();
    // Todo lo demás intacto: el texto, la identidad y el WAMID siguen ahí.
    expect(filtrado.content).toBe('ya te pagué');
    expect(filtrado.providerMessageId).toBe('wamid.PAGO');
    expect(filtrado.customerPhone).toBe(original.customerPhone);
    expect(filtrado.contentType).toBe(original.contentType);
  });

  it('no muta el original: la captura sigue teniendo su adjunto', () => {
    const original = mensaje({ providerMessageId: 'wamid.PAGO' });
    withholdAttachments(original, allowlist);
    expect(original.image).not.toBeNull();
  });

  it('el mensaje AUTORIZADO vuelve tal cual, con sus bytes', () => {
    const original = mensaje({ providerMessageId: 'wamid.NORMAL' });
    expect(withholdAttachments(original, allowlist)).toBe(original);
    expect(withholdAttachments(original, allowlist).image).not.toBeNull();
  });

  it('un mensaje SIN adjunto vuelve tal cual aunque no esté autorizado', () => {
    // La puerta habla de bytes: el texto no necesita permiso de nadie.
    const texto = mensaje({
      providerMessageId: 'wamid.TEXTO',
      contentType: 'text',
      content: 'hola',
      image: null,
    });
    expect(withholdAttachments(texto, allowlist)).toBe(texto);
  });

  it('ninguna URL transitoria sobrevive en el mensaje retenido', () => {
    // Las URLs de media son credenciales de acceso a la foto del cliente.
    const filtrado = withholdAttachments(mensaje({ providerMessageId: 'wamid.PAGO' }), allowlist);
    expect(JSON.stringify(filtrado)).not.toContain('token-transitorio');
  });

  it('el burst conserva orden y longitud: solo se caen los bytes', () => {
    const burst = [
      mensaje({
        providerMessageId: 'wamid.TEXTO',
        contentType: 'text',
        content: 'hola',
        image: null,
      }),
      mensaje({ providerMessageId: 'wamid.PAGO', content: 'ahí va' }),
      mensaje({ providerMessageId: 'wamid.NORMAL' }),
    ];
    const { messages, withheld } = withholdAttachmentsFromBurst(burst, allowlist);

    expect(messages).toHaveLength(3);
    expect(messages.map((m: ProvenanceMessage) => m.providerMessageId)).toEqual([
      'wamid.TEXTO',
      'wamid.PAGO',
      'wamid.NORMAL',
    ]);
    expect(withheld).toBe(1);
    expect(messages[1].image).toBeNull();
    // La imagen normal SÍ pasa: la puerta es por mensaje, no por lote.
    expect(messages[2].image).not.toBeNull();
  });

  it('el ORDEN de los veredictos no cambia el resultado: la clave es el WAMID', () => {
    const alRevés = buildVisionAllowlist([
      { sourceMessageId: 'wamid.PAGO', classification: 'payment_proof' },
      { sourceMessageId: 'wamid.NORMAL', classification: 'not_payment_proof' },
    ]);
    const burst = [
      mensaje({ providerMessageId: 'wamid.NORMAL' }),
      mensaje({ providerMessageId: 'wamid.PAGO' }),
    ];
    const { messages } = withholdAttachmentsFromBurst(burst, alRevés);
    expect(messages[0].image).not.toBeNull();
    expect(messages[1].image).toBeNull();
  });

  it('veredictos de mensajes que ni siquiera están en el burst no molestan', () => {
    // El motor recorre los sobres; el burst puede tener otro filtro. La
    // correlación por identidad tolera que las dos listas no coincidan.
    const conSobrantes = buildVisionAllowlist([
      { sourceMessageId: 'wamid.QUE.NO.ESTA', classification: 'not_payment_proof' },
      { sourceMessageId: 'wamid.NORMAL', classification: 'not_payment_proof' },
    ]);
    const { messages, withheld } = withholdAttachmentsFromBurst(
      [mensaje({ providerMessageId: 'wamid.NORMAL' })],
      conSobrantes,
    );
    expect(withheld).toBe(0);
    expect(messages[0].image).not.toBeNull();
  });
});
