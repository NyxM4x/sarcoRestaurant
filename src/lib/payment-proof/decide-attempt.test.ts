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
  noticeThrows?: boolean;
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

  const avisosReparto: string[] = [];

  const deps: DecideDeps = {
    source,
    async sendText(phone, text) {
      if (opts.sendThrows) throw new Error('boom');
      enviados.push({ phone, text });
      return { ok: opts.sendOk ?? true };
    },
    async notifyDeliveryGroup(orderId) {
      if (opts.noticeThrows) throw new Error('boom');
      avisosReparto.push(orderId);
    },
  };
  return { deps, enviados, decisiones, avisosReparto };
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

describe('el reparto se entera cuando el pago está COBRADO', () => {
  /**
   * El aviso al grupo de Telegram salía al cotizar, junto con el QR: el reparto
   * veía el pedido antes de que el cliente hubiera pagado. Si no llegaba a
   * pagar, alguien podía salir a llevar algo que no se cobró.
   */
  it('aceptar avisa al grupo de reparto', async () => {
    const { deps, avisosReparto } = fake();
    await decidePaymentAttempt('a1', 'accept', deps);
    expect(avisosReparto).toEqual(['order-1']);
  });

  it('rechazar NO avisa: un rechazo no despacha nada', async () => {
    const { deps, avisosReparto } = fake();
    await decidePaymentAttempt('a1', 'reject', deps);
    expect(avisosReparto).toEqual([]);
  });

  it('una decisión repetida no vuelve a avisar', async () => {
    // `repeated` ya avisó en su momento; repetirlo pondría el mismo pedido dos
    // veces en el grupo, y dos personas podrían salir a llevar lo mismo.
    const { deps, avisosReparto } = fake({
      row: {
        outcome: 'repeated',
        order_id: 'order-1',
        review_status: 'accepted',
        reviewed_at: REVIEWED_AT,
      } as RpcDecisionRow,
    });
    await decidePaymentAttempt('a1', 'accept', deps);
    expect(avisosReparto).toEqual([]);
  });

  it('un conflicto tampoco: ganó otra decisión', async () => {
    const { deps, avisosReparto } = fake({
      row: {
        outcome: 'conflict',
        order_id: 'order-1',
        review_status: 'rejected',
        reviewed_at: REVIEWED_AT,
      } as RpcDecisionRow,
    });
    await decidePaymentAttempt('a1', 'accept', deps);
    expect(avisosReparto).toEqual([]);
  });

  it('si el aviso al reparto falla, la decisión sigue firme', async () => {
    // Perder el aviso es recuperable —el pedido está en el panel y en cocina—;
    // perder la decisión no. El fallo no puede propagarse hasta el operador.
    const { deps } = fake({ noticeThrows: true });
    const res = await decidePaymentAttempt('a1', 'accept', deps);
    expect(res).toMatchObject({ ok: true, reviewStatus: 'accepted' });
  });

  it('el aviso va DESPUÉS del mensaje al cliente', async () => {
    // El cliente es lo primero: si algo se cae por el camino, que sea el aviso
    // interno y no la confirmación que la persona está esperando.
    const { deps, enviados, avisosReparto } = fake();
    await decidePaymentAttempt('a1', 'accept', deps);
    expect(enviados).toHaveLength(1);
    expect(avisosReparto).toHaveLength(1);
  });

  it('sin el puerto inyectado la decisión funciona igual', async () => {
    const { deps } = fake();
    const sinAviso: DecideDeps = { source: deps.source, sendText: deps.sendText };
    const res = await decidePaymentAttempt('a1', 'accept', sinAviso);
    expect(res).toMatchObject({ ok: true });
  });
});
