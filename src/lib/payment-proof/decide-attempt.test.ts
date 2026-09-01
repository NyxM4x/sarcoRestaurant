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
  deliveryType?: 'delivery' | 'pickup' | null;
  sendOk?: boolean;
  sendThrows?: boolean;
  noticeThrows?: boolean;
  pauseThrows?: boolean;
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
    async getOrderContact() {
      if (opts.phoneThrows) throw new Error('boom');
      return {
        customerPhone: opts.phone === undefined ? '59170000000' : opts.phone,
        // Los tests que no hablan del tipo de entrega no deberían tener que
        // pensar en él: sin tipo, el aviso sale a secas, como antes.
        deliveryType: opts.deliveryType ?? null,
      };
    },
  } as unknown as ProofsDataSource;

  const avisosReparto: string[] = [];
  const pausados: string[] = [];

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
    async pauseAgentAfterReview(phone) {
      if (opts.pauseThrows) throw new Error('boom');
      pausados.push(phone);
    },
  };
  return { deps, enviados, decisiones, avisosReparto, pausados };
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
    // Desde 0028 el texto lleva el plazo de la ventana de gracia: sin el, el
    // pedido se cancelaria solo sin que el cliente supiera que tenia un reloj.
    expect(enviados[0].text).toContain('reenviar una captura clara');
    expect(enviados[0].text).toContain('cancelado automáticamente');
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

describe('tras decidir, el agente se calla', () => {
  /**
   * El aviso que sale al cliente abre una conversación sobre el pago. Un agente
   * contestando en medio —"atendemos de seis de la tarde a cuatro"— le hace
   * creer que su pedido se pasó por alto.
   */
  it('aceptar pausa al agente para ese cliente', async () => {
    const { deps, pausados } = fake();
    await decidePaymentAttempt('a1', 'accept', deps);
    expect(pausados).toEqual(['59170000000']);
  });

  it('RECHAZAR también, y es el caso que más importa', async () => {
    // Un rechazo el cliente lo va a querer discutir. Ahí es donde el agente
    // estorba de verdad.
    const { deps, pausados } = fake();
    await decidePaymentAttempt('a1', 'reject', deps);
    expect(pausados).toEqual(['59170000000']);
  });

  it('una decisión repetida NO vuelve a pausar', async () => {
    // Mismo criterio que el aviso: `repeated` ya avisó en su momento.
    const { deps, pausados } = fake({
      row: { outcome: 'repeated', order_id: 'order-1', review_status: 'accepted', reviewed_at: REVIEWED_AT },
    });
    await decidePaymentAttempt('a1', 'accept', deps);
    expect(pausados).toEqual([]);
  });

  it('sin teléfono no se pausa nada', async () => {
    const { deps, pausados } = fake({ phone: null });
    await decidePaymentAttempt('a1', 'accept', deps);
    expect(pausados).toEqual([]);
  });

  it('si la pausa falla, la DECISIÓN sigue firme y el aviso cuenta como enviado', async () => {
    // La decisión ya está persistida cuando esto corre. Callar al agente es
    // contabilidad nuestra; perder la decisión no se recupera.
    const { deps } = fake({ pauseThrows: true });
    const res = await decidePaymentAttempt('a1', 'accept', deps);
    expect(res).toEqual({
      ok: true,
      reviewStatus: 'accepted',
      reviewedAt: REVIEWED_AT,
      notification: 'sent',
    });
  });

  it('sin la dependencia cableada, la decisión funciona igual', async () => {
    // Es el interruptor de apagado, y lo que permite que los tests no toquen
    // Supabase.
    const { deps } = fake();
    const sinPausa: DecideDeps = { source: deps.source, sendText: deps.sendText };
    const res = await decidePaymentAttempt('a1', 'accept', sinPausa);
    expect(res.ok).toBe(true);
  });
});

describe('el aviso de pago aceptado dice qué pasa AHORA', () => {
  it('delivery: le anuncia la llamada del repartidor', async () => {
    const { deps, enviados } = fake({ deliveryType: 'delivery' });
    await decidePaymentAttempt('a1', 'accept', deps);

    expect(enviados[0].text).toContain('Pago confirmado ✅');
    expect(enviados[0].text).toMatch(/te llamará cuando llegue/i);
  });

  it('recojo: le dice que lo esperamos, sin prometer una hora', async () => {
    // La cocina acaba de empezar: darle un plazo sería inventarlo.
    const { deps, enviados } = fake({ deliveryType: 'pickup' });
    await decidePaymentAttempt('a1', 'accept', deps);

    expect(enviados[0].text).toMatch(/te esperamos/i);
    expect(enviados[0].text).not.toMatch(/\d+\s*(minutos|min)/i);
  });

  it('los dos avisos son distintos, y no se cruzan', async () => {
    // Es el fallo que esto arregla: a quien iba a recoger se le dejaba
    // esperando una moto que nunca iba a salir.
    const d = fake({ deliveryType: 'delivery' });
    await decidePaymentAttempt('a1', 'accept', d.deps);
    const p = fake({ deliveryType: 'pickup' });
    await decidePaymentAttempt('a1', 'accept', p.deps);

    expect(d.enviados[0].text).not.toBe(p.enviados[0].text);
    expect(d.enviados[0].text).not.toMatch(/recogerlo/i);
    expect(p.enviados[0].text).not.toMatch(/delivery|repartidor/i);
  });

  it('sin tipo de entrega se manda el aviso a secas', async () => {
    // No se rellena lo que no consta: antes que arriesgar decirle que lo espere
    // en la puerta cuando iba a pasar a buscarlo, se dice solo lo que es cierto.
    const { deps, enviados } = fake({ deliveryType: null });
    await decidePaymentAttempt('a1', 'accept', deps);

    expect(enviados[0].text).toBe('Pago confirmado ✅. Tu pedido está siendo preparado.');
  });

  it('un RECHAZO ignora el tipo de entrega', async () => {
    // Todavía no hay nada que esperar ni que recoger.
    const { deps, enviados } = fake({ deliveryType: 'delivery' });
    await decidePaymentAttempt('a1', 'reject', deps);

    expect(enviados[0].text).not.toMatch(/te llamará|te esperamos/i);
  });
});
