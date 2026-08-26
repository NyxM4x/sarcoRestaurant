import { describe, it, expect } from 'vitest';
import { decidePaymentAttempt, type DecideDeps } from './decide-attempt';
import type { RpcDecisionRow } from './review-result';
import type { ProofsDataSource } from '@/lib/dashboard/proofs-data-source';

const REVIEWED_AT = '2026-08-26T21:04:00.000Z';

interface FakeOptions {
  row?: RpcDecisionRow | null;
  decideThrows?: boolean;
  phone?: string | null;
  phoneThrows?: boolean;
  sendOk?: boolean;
  sendThrows?: boolean;
}

function fake(opts: FakeOptions = {}) {
  const enviados: Array<{ phone: string; text: string }> = [];
  const decisiones: Array<{ attemptId: string; decision: string }> = [];

  const source = {
    async decide(attemptId: string, decision: string) {
      decisiones.push({ attemptId, decision });
      if (opts.decideThrows) throw new Error('boom');
      return opts.row === undefined
        ? ({
            outcome: 'won',
            order_id: 'order-1',
            review_status: decision === 'accept' ? 'accepted' : 'rejected',
            reviewed_at: REVIEWED_AT,
          } as RpcDecisionRow)
        : opts.row;
    },
    async getCustomerPhone() {
      if (opts.phoneThrows) throw new Error('boom');
      return opts.phone === undefined ? '59170000000' : opts.phone;
    },
  } as unknown as ProofsDataSource;

  const deps: DecideDeps = {
    source,
    async sendText(phone, text) {
      if (opts.sendThrows) throw new Error('boom');
      enviados.push({ phone, text });
      return { ok: opts.sendOk ?? true };
    },
  };
  return { deps, enviados, decisiones };
}

describe('decisión ganadora — avisa exactamente una vez', () => {
  it('aceptar envía UN solo WhatsApp con el texto de confirmación', async () => {
    const { deps, enviados } = fake();
    const res = await decidePaymentAttempt('a1', 'accept', deps);
    expect(res).toEqual({
      ok: true,
      reviewStatus: 'accepted',
      reviewedAt: REVIEWED_AT,
      notification: 'sent',
    });
    expect(enviados).toHaveLength(1);
    expect(enviados[0].text).toContain('Pago confirmado');
  });

  it('rechazar envía UN solo WhatsApp con instrucciones', async () => {
    const { deps, enviados } = fake();
    const res = await decidePaymentAttempt('a1', 'reject', deps);
    expect(res.ok).toBe(true);
    expect(enviados).toHaveLength(1);
    expect(enviados[0].text).toContain('respondiendo al mismo QR');
  });
});

describe('idempotencia — lo repetido NO reenvía', () => {
  it('`repeated` es éxito y no manda nada', async () => {
    const { deps, enviados } = fake({
      row: {
        outcome: 'repeated',
        order_id: 'order-1',
        review_status: 'accepted',
        reviewed_at: REVIEWED_AT,
      },
    });
    const res = await decidePaymentAttempt('a1', 'accept', deps);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.notification).toBeUndefined();
    expect(enviados).toEqual([]);
  });

  it('`conflict` no manda nada y devuelve el estado real', async () => {
    const { deps, enviados } = fake({
      row: {
        outcome: 'conflict',
        order_id: 'order-1',
        review_status: 'rejected',
        reviewed_at: REVIEWED_AT,
      },
    });
    const res = await decidePaymentAttempt('a1', 'accept', deps);
    expect(res).toEqual({ ok: false, reason: 'conflict', current: 'rejected' });
    expect(enviados).toEqual([]);
  });

  it('`not_found` no manda nada', async () => {
    const { deps, enviados } = fake({ row: { outcome: 'not_found' } });
    const res = await decidePaymentAttempt('a1', 'accept', deps);
    expect(res).toEqual({ ok: false, reason: 'not_found', current: null });
    expect(enviados).toEqual([]);
  });
});

describe('un fallo de WhatsApp NO revierte la decisión', () => {
  it('envío rechazado → la decisión sigue firme, con aviso al operador', async () => {
    const { deps, enviados } = fake({ sendOk: false });
    const res = await decidePaymentAttempt('a1', 'accept', deps);
    expect(res.ok, 'la decisión debe seguir siendo un éxito').toBe(true);
    if (res.ok) {
      expect(res.reviewStatus).toBe('accepted');
      expect(res.notification).toBe('failed');
    }
    expect(enviados).toHaveLength(1);
  });

  it('excepción al enviar → tampoco revierte', async () => {
    const { deps } = fake({ sendThrows: true });
    const res = await decidePaymentAttempt('a1', 'accept', deps);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.notification).toBe('failed');
  });

  it('excepción al leer el teléfono → tampoco revierte', async () => {
    const { deps } = fake({ phoneThrows: true });
    const res = await decidePaymentAttempt('a1', 'accept', deps);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.notification).toBe('failed');
  });

  it('sin teléfono guardado no se inventa un destinatario', async () => {
    const { deps, enviados } = fake({ phone: null });
    const res = await decidePaymentAttempt('a1', 'accept', deps);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.notification).toBe('failed');
    expect(enviados).toEqual([]);
  });
});

describe('fallos de la base', () => {
  it('una excepción en la RPC devuelve error saneado y no avisa', async () => {
    const { deps, enviados } = fake({ decideThrows: true });
    const res = await decidePaymentAttempt('a1', 'accept', deps);
    expect(res).toEqual({ ok: false, reason: 'error' });
    expect(enviados).toEqual([]);
  });

  it('una respuesta vacía no finge éxito', async () => {
    const { deps } = fake({ row: null });
    expect(await decidePaymentAttempt('a1', 'accept', deps)).toEqual({
      ok: false,
      reason: 'error',
    });
  });
});

describe('el teléfono nunca llega desde fuera', () => {
  it('el destinatario sale del pedido que devuelve la RPC, no de un parámetro', async () => {
    const { deps, enviados } = fake({ phone: '59171234567' });
    await decidePaymentAttempt('a1', 'accept', deps);
    expect(enviados[0].phone).toBe('59171234567');
    // La firma de la función no admite teléfono: comprobación estructural.
    expect(decidePaymentAttempt.length).toBeLessThanOrEqual(3);
  });

  it('el resultado devuelto al navegador no contiene el teléfono', async () => {
    const { deps } = fake({ phone: '59171234567' });
    const res = await decidePaymentAttempt('a1', 'accept', deps);
    expect(JSON.stringify(res)).not.toContain('59171234567');
    expect(JSON.stringify(res)).not.toContain('order-1');
  });
});
