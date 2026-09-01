import { describe, it, expect } from 'vitest';
import {
  capturePaymentProof,
  PROOF_CLAIM_LEASE_MS,
  type CapturePorts,
  type ExistingProof,
  type ProofContentUpdate,
  type ProofInsert,
} from './capture';
import type { ProofCandidateOrder } from './association';
import { PROOF_MAX_BYTES } from './mime';

const NOW = Date.parse('2026-08-26T18:00:00.000Z');

function png(): Uint8Array {
  const b = new Uint8Array(64);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  return b;
}

const pedido = (id: string): ProofCandidateOrder => ({
  orderId: id,
  status: 'confirmed',
  paymentMethod: 'qr',
  openedAt: new Date(NOW - 60_000).toISOString(),
  hasAcceptedPayment: false,
  rejectionGraceEndsAtMs: null,
});

interface FakeOptions {
  existente?: ExistingProof | null;
  /** Fila que aparece SOLO en la segunda consulta (carrera del índice único). */
  ganadorTrasChoque?: ExistingProof | null;
  reclaimOk?: boolean;
  bytes?: Uint8Array | null;
  hashPrevio?: string | null;
  insertThrows?: boolean;
  storeOk?: boolean;
  markStoredOk?: boolean;
  attemptId?: string | null;
}

function ports(opts: FakeOptions = {}) {
  const log: string[] = [];
  const insertados: ProofInsert[] = [];
  const contenidos: ProofContentUpdate[] = [];
  const subidos: string[] = [];
  let consultas = 0;

  const p: CapturePorts = {
    async findBySourceMessageId() {
      consultas += 1;
      log.push('find_wamid');
      if (consultas > 1 && opts.ganadorTrasChoque !== undefined) return opts.ganadorTrasChoque;
      return opts.existente ?? null;
    },
    async insertClaimed(row) {
      log.push('insert_claimed');
      if (opts.insertThrows) throw new Error('unique violation');
      insertados.push(row);
      return 'proof-nuevo';
    },
    async reclaim() {
      log.push('reclaim');
      return opts.reclaimOk ?? true;
    },
    async downloadBytes() {
      log.push('download');
      return opts.bytes === undefined ? png() : opts.bytes;
    },
    async hashBytes() {
      log.push('hash');
      return 'a'.repeat(64);
    },
    async findByContentHash() {
      log.push('find_hash');
      return opts.hashPrevio ?? null;
    },
    async updateContent(_id, update) {
      log.push('update_content');
      contenidos.push(update);
    },
    async storeObject(key) {
      log.push('store');
      subidos.push(key);
      return opts.storeOk ?? true;
    },
    async markStored() {
      log.push('mark_stored');
      return opts.markStoredOk ?? true;
    },
    async markFailed() {
      log.push('mark_failed');
    },
    async attachToAttempt() {
      log.push('attach');
      return opts.attemptId === undefined ? 'attempt-1' : opts.attemptId;
    },
    newClaimToken: () => 'token-fijo',
  };
  return { p, log, insertados, contenidos, subidos };
}

const entrada = (over: Partial<Parameters<typeof capturePaymentProof>[0]> = {}) => ({
  sourceMessageId: 'wamid.ABC',
  declaredMimeType: 'image/png',
  receivedAtMs: NOW,
  association: { replyToOrderId: 'O1', candidates: [pedido('O1')], nowMs: NOW },
  ...over,
});

describe('comprobante nuevo → captured', () => {
  it('captura tras ganar el CAS: una descarga, una subida, un cierre', async () => {
    const { p, log, subidos } = ports();
    const res = await capturePaymentProof(entrada(), p);
    expect(res.result).toBe('captured');
    if (res.result === 'captured') {
      expect(res.matchMethod).toBe('reply_to_qr');
      expect(res.duplicateOfProofId).toBeNull();
      expect(res.attemptId).toBe('attempt-1');
    }
    expect(log.filter((l) => l === 'download')).toHaveLength(1);
    expect(log.filter((l) => l === 'store')).toHaveLength(1);
    expect(log.filter((l) => l === 'mark_stored')).toHaveLength(1);
    expect(subidos[0]).toMatch(/^payment-proofs\/\d{4}\/\d{2}\/proof-nuevo\.png$/);
  });

  it('enruta y reclama ANTES de descargar', () => {
    return capturePaymentProof(entrada(), ports().p).then(async () => {
      const { p, log } = ports();
      await capturePaymentProof(entrada(), p);
      expect(log.indexOf('insert_claimed')).toBeLessThan(log.indexOf('download'));
      expect(log.indexOf('store')).toBeLessThan(log.indexOf('mark_stored'));
      expect(log.indexOf('mark_stored')).toBeLessThan(log.indexOf('attach'));
    });
  });
});

describe('mismo WAMID ya almacenado → already_captured', () => {
  it('no descarga, no sube, no abre intento', async () => {
    const { p, log } = ports({
      existente: { proofId: 'proof-previo', captureStatus: 'stored', claimedAtMs: null },
    });
    const res = await capturePaymentProof(entrada(), p);
    expect(res).toEqual({ result: 'already_captured', proofId: 'proof-previo' });
    expect(log).toEqual(['find_wamid']);
  });
});

describe('mismo WAMID en curso → in_progress', () => {
  it('un claim FRESCO de otro worker no se pisa', async () => {
    const { p, log } = ports({
      existente: {
        proofId: 'proof-en-curso',
        captureStatus: 'capturing',
        claimedAtMs: NOW - 1_000,
      },
    });
    const res = await capturePaymentProof(entrada(), p);
    expect(res).toEqual({ result: 'in_progress', proofId: 'proof-en-curso' });
    expect(log).toEqual(['find_wamid']);
  });

  it('si otro gana la re-reclamación, tampoco se pisa', async () => {
    const { p } = ports({
      existente: {
        proofId: 'proof-huerfano',
        captureStatus: 'capturing',
        claimedAtMs: NOW - PROOF_CLAIM_LEASE_MS - 1_000,
      },
      reclaimOk: false,
    });
    const res = await capturePaymentProof(entrada(), p);
    expect(res).toEqual({ result: 'in_progress', proofId: 'proof-huerfano' });
  });

  it('choque del índice único: el ganador manda', async () => {
    const { p } = ports({
      existente: null,
      insertThrows: true,
      ganadorTrasChoque: { proofId: 'proof-ganador', captureStatus: 'capturing', claimedAtMs: NOW },
    });
    const res = await capturePaymentProof(entrada(), p);
    expect(res).toEqual({ result: 'in_progress', proofId: 'proof-ganador' });
  });
});

describe('EL DEFECTO QUE ESTO ARREGLA: comprobante huérfano', () => {
  it('un claim VENCIDO se re-reclama y la captura se completa', async () => {
    const { p, log } = ports({
      existente: {
        proofId: 'proof-abandonado',
        captureStatus: 'capturing',
        claimedAtMs: NOW - PROOF_CLAIM_LEASE_MS - 60_000,
      },
    });
    const res = await capturePaymentProof(entrada(), p);
    expect(res.result, 'el comprobante abandonado debe recuperarse').toBe('captured');
    if (res.result === 'captured') expect(res.proofId).toBe('proof-abandonado');
    expect(log).toContain('reclaim');
    expect(log).toContain('store');
  });

  it('una fila `failed` anterior también se reintenta', async () => {
    const { p } = ports({
      existente: { proofId: 'proof-fallido', captureStatus: 'failed', claimedAtMs: null },
    });
    const res = await capturePaymentProof(entrada(), p);
    expect(res.result).toBe('captured');
  });

  it('una fila `pending` legacy (previa a 0023) también se reintenta', async () => {
    const { p } = ports({
      existente: { proofId: 'proof-legacy', captureStatus: 'pending', claimedAtMs: null },
    });
    expect((await capturePaymentProof(entrada(), p)).result).toBe('captured');
  });

  it('justo dentro del lease sigue siendo in_progress', async () => {
    const { p } = ports({
      existente: {
        proofId: 'x',
        captureStatus: 'capturing',
        claimedAtMs: NOW - PROOF_CLAIM_LEASE_MS + 1_000,
      },
    });
    expect((await capturePaymentProof(entrada(), p)).result).toBe('in_progress');
  });
});

describe('CAS perdido → lost_claim', () => {
  it('no se afirma captura completa si otro cerró primero', async () => {
    const { p, log } = ports({ markStoredOk: false });
    const res = await capturePaymentProof(entrada(), p);
    expect(res).toEqual({ result: 'lost_claim', proofId: 'proof-nuevo' });
    // Y desde luego no se abre un intento con un claim que ya no es nuestro.
    expect(log).not.toContain('attach');
  });
});

describe('duplicado: NO es un outcome, es un matchMethod', () => {
  it('WAMID nuevo + mismo SHA → captured con matchMethod duplicate', async () => {
    const { p, contenidos } = ports({ hashPrevio: 'proof-original' });
    const res = await capturePaymentProof(entrada(), p);
    expect(res.result).toBe('captured');
    if (res.result === 'captured') {
      expect(res.matchMethod).toBe('duplicate');
      expect(res.duplicateOfProofId).toBe('proof-original');
      // Un reenvío no es evidencia nueva: no alimenta un intento.
      expect(res.attemptId).toBeNull();
    }
    expect(contenidos[0].associationMethod).toBe('duplicate');
    expect(contenidos[0].duplicateOfId).toBe('proof-original');
  });

  it('el duplicado se guarda y se sube igual: la trazabilidad importa', async () => {
    const { p, log } = ports({ hashPrevio: 'proof-original' });
    await capturePaymentProof(entrada(), p);
    expect(log).toContain('store');
    expect(log).toContain('mark_stored');
    expect(log).not.toContain('attach');
  });
});

describe('fallos → failed, sin fila marcada stored', () => {
  it('descarga fallida', async () => {
    const { p, log } = ports({ bytes: null });
    const res = await capturePaymentProof(entrada(), p);
    expect(res).toEqual({ result: 'failed', reason: 'download_failed', proofId: 'proof-nuevo' });
    expect(log).toContain('mark_failed');
    expect(log).not.toContain('mark_stored');
  });

  it('storage fallido', async () => {
    const { p, log } = ports({ storeOk: false });
    const res = await capturePaymentProof(entrada(), p);
    expect(res).toEqual({ result: 'failed', reason: 'storage_failed', proofId: 'proof-nuevo' });
    expect(log).toContain('mark_failed');
    expect(log).not.toContain('mark_stored');
  });

  it('contenido no admitido, renombrado y tamaño', async () => {
    const raro = ports({ bytes: new Uint8Array([0x4d, 0x5a, 0x00, 0x00]) });
    expect(await capturePaymentProof(entrada(), raro.p)).toMatchObject({
      result: 'failed',
      reason: 'unsupported_content',
    });

    const renombrado = ports();
    expect(
      await capturePaymentProof(entrada({ declaredMimeType: 'application/pdf' }), renombrado.p),
    ).toMatchObject({ result: 'failed', reason: 'declared_mismatch' });

    const grande = new Uint8Array(PROOF_MAX_BYTES + 1);
    grande.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    expect(await capturePaymentProof(entrada(), ports({ bytes: grande }).p)).toMatchObject({
      result: 'failed',
      reason: 'too_large',
    });
  });
});

describe('enrutado y excepciones', () => {
  it('un pedido cerrado deja excepción y no engancha intento', async () => {
    const { p, log, insertados } = ports();
    const res = await capturePaymentProof(
      entrada({
        association: {
          replyToOrderId: 'O1',
          candidates: [{ ...pedido('O1'), status: 'cancelled' }],
          nowMs: NOW,
        },
      }),
      p,
    );
    expect(res.result).toBe('captured');
    expect(insertados[0].routingException).toBe('closed_order');
    expect(log).not.toContain('attach');
  });

  it('dos pedidos abiertos sin señal queda ambiguo, sin pedido asociado', async () => {
    const { p, insertados } = ports();
    await capturePaymentProof(
      entrada({
        association: { replyToOrderId: null, candidates: [pedido('O1'), pedido('O2')], nowMs: NOW },
      }),
      p,
    );
    expect(insertados[0].associationMethod).toBe('ambiguous');
    expect(insertados[0].orderId).toBeNull();
  });

  it('guarda el tipo declarado al reclamar y el verificado al descargar', async () => {
    const { p, insertados, contenidos } = ports();
    await capturePaymentProof(entrada(), p);
    expect(insertados[0].declaredMimeType).toBe('image/png');
    expect(contenidos[0].verifiedMimeType).toBe('image/png');
    expect(contenidos[0].contentSha256).toHaveLength(64);
  });
});
