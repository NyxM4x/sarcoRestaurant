import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ProofCandidateOrder } from './association';

/**
 * MEDIA SIN PARSEAR: cuándo deja rastro y cuándo no.
 *
 * La regla que se prueba aquí es un equilibrio, no una obviedad. Registrar todo
 * archivo que no sabemos leer llenaría el panel de audios de "¿ya salió mi
 * pedido?", y una alerta que salta siempre deja de mirarse justo cuando importa.
 * No registrar nada es lo que teníamos: un comprobante en PDF se evaporaba.
 *
 * El corte lo decide el MISMO motor de enrutado que decide el resto —no una
 * condición escrita aparte—, así que "esto parecía un pago" significa
 * exactamente lo mismo aquí que en una captura normal.
 */

const INSERTADAS: Array<{ sourceMessageId: string; declaredMimeType: string | null }> = [];
let CANDIDATOS: ProofCandidateOrder[] = [];

vi.mock('server-only', () => ({}));

vi.mock('@/lib/env/env', () => ({
  getServerEnv: () => ({
    PAYMENT_PROOF_CAPTURE_ENABLED: 'true',
    KAPSO_API_KEY: 'clave',
  }),
}));

vi.mock('@/lib/log', () => ({ log: { info: () => {}, warn: () => {}, error: () => {} } }));

vi.mock('./storage', () => ({
  isProofStorageConfigured: () => true,
  putProofObject: async () => ({ ok: true }),
}));

// El resolutor NO debe llegar a usarse cuando no hay adjunto: si se usara, este
// mock lo delataría lanzando.
vi.mock('@/lib/kapso/media-resolver', () => ({
  createKapsoMediaResolver: () => ({
    resolveImage: async () => {
      throw new Error('no se debe resolver media sin adjunto');
    },
  }),
}));

vi.mock('./intake-data-source', () => ({
  newClaimToken: () => 'token-de-prueba',
  createSupabaseIntakeDataSource: () => ({
    candidatesForPhone: async () => CANDIDATOS,
    findBySourceMessageId: async () => null,
    async insertClaimed(row: { sourceMessageId: string; declaredMimeType: string | null }) {
      INSERTADAS.push({
        sourceMessageId: row.sourceMessageId,
        declaredMimeType: row.declaredMimeType,
      });
      return 'proof-1';
    },
    reclaim: async () => true,
    findByContentHash: async () => null,
    updateContent: async () => {},
    markStored: async () => true,
    markFailed: async () => {},
    attachToAttempt: async () => 'attempt-1',
  }),
}));

const { intakePaymentProof } = await import('./intake-service');

/** Pedido QR esperando cobro, abierto ahora mismo. */
function pedidoAbierto(id: string): ProofCandidateOrder {
  return {
    orderId: id,
    status: 'confirmed',
    paymentMethod: 'qr',
    openedAt: new Date().toISOString(),
    hasAcceptedPayment: false,
    rejectionGraceEndsAtMs: null,
  };
}

async function llegaArchivoSinParsear(mime: string | null) {
  return intakePaymentProof({
    sourceMessageId: 'wamid.SIN_PARSEAR',
    customerPhone: '59100000000',
    attachment: null,
    declaredMimeType: mime,
    providerPhoneNumberId: null,
    receivedAtMs: Date.now(),
  });
}

beforeEach(() => {
  INSERTADAS.length = 0;
  CANDIDATOS = [];
});

describe('archivo sin parsear — cuándo SÍ deja rastro', () => {
  it('con un pedido esperando cobro se registra, y queda como fallido', async () => {
    CANDIDATOS = [pedidoAbierto('order-1')];

    const res = await llegaArchivoSinParsear('application/pdf');

    // La fila existe: el operador verá que llegó algo.
    expect(INSERTADAS).toHaveLength(1);
    expect(INSERTADAS[0].sourceMessageId).toBe('wamid.SIN_PARSEAR');
    // Y sabrá QUÉ llegó, aunque nunca se descargara.
    expect(INSERTADAS[0].declaredMimeType).toBe('application/pdf');
    // No se finge una captura: sin bytes no hay comprobante.
    expect(res.result).toBe('failed');
  });

  it('el tipo declarado puede faltar sin impedir el registro', async () => {
    CANDIDATOS = [pedidoAbierto('order-1')];
    await llegaArchivoSinParsear(null);
    expect(INSERTADAS).toHaveLength(1);
    expect(INSERTADAS[0].declaredMimeType).toBeNull();
  });

  it('con DOS pedidos abiertos TAMBIÉN: ambiguo es "varios", no "ninguno"', async () => {
    // Este caso llegó en la PRIMERA prueba real y la primera versión lo perdía.
    // El razonamiento equivocado era "sin saber a cuál iba, la fila no informa
    // de nada". Informa: hay dos pedidos esperando cobro y un archivo que no
    // pudimos leer. Quien mira el panel desambigua por el monto; nosotros no
    // podemos, pero él sí.
    //
    // Y sale del flujo normal: se rechaza un pago, el cliente vuelve a pedir, y
    // quedan dos pedidos vivos a la vez.
    CANDIDATOS = [pedidoAbierto('order-1'), pedidoAbierto('order-2')];

    await llegaArchivoSinParsear('application/pdf');

    expect(INSERTADAS).toHaveLength(1);
    expect(INSERTADAS[0].declaredMimeType).toBe('application/pdf');
  });
});

describe('archivo sin parsear — cuándo NO se registra', () => {
  it('sin ningún pedido, no se abre nada', async () => {
    CANDIDATOS = [];

    const res = await llegaArchivoSinParsear('audio/ogg');

    expect(INSERTADAS).toEqual([]);
    expect(res).toMatchObject({ result: 'failed', reason: 'unsupported_media_ignored' });
  });

  it('con el pedido fuera de plazo tampoco', async () => {
    const viejo = pedidoAbierto('order-1');
    viejo.openedAt = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    CANDIDATOS = [viejo];

    await llegaArchivoSinParsear('application/pdf');

    expect(INSERTADAS).toEqual([]);
  });

  it('con el pago ya aceptado tampoco', async () => {
    const pagado = pedidoAbierto('order-1');
    pagado.hasAcceptedPayment = true;
    CANDIDATOS = [pagado];

    await llegaArchivoSinParsear('application/pdf');

    expect(INSERTADAS).toEqual([]);
  });

  it('un pedido en efectivo no espera comprobante', async () => {
    const efectivo = pedidoAbierto('order-1');
    efectivo.paymentMethod = 'cash';
    CANDIDATOS = [efectivo];

    await llegaArchivoSinParsear('application/pdf');

    expect(INSERTADAS).toEqual([]);
  });
});

describe('el filtro NO alcanza a los adjuntos de verdad', () => {
  it('una imagen se registra aunque no haya ningún pedido abierto', async () => {
    // Esta es la regresión que importa: el filtro existe para lo que NO se puede
    // descargar. Un archivo real se captura siempre y su enrutado —`unresolved`,
    // `ambiguous`— lo decide el motor como antes, no esta puerta.
    CANDIDATOS = [];

    await intakePaymentProof({
      sourceMessageId: 'wamid.IMAGEN',
      customerPhone: '59100000000',
      attachment: {
        facts: { mediaId: 'm1', sha256: null, mimeType: 'image/jpeg', byteSize: 1000, filename: null },
        transient: { kapsoMediaUrl: 'https://app.kapso.ai/x', link: null, metaUrl: null },
        caption: null,
      } as never,
      providerPhoneNumberId: null,
      receivedAtMs: Date.now(),
    });

    expect(INSERTADAS).toHaveLength(1);
    expect(INSERTADAS[0].sourceMessageId).toBe('wamid.IMAGEN');
  });
});
