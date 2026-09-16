import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { PromoMode } from '@/lib/promotions/promo-mode';

/**
 * "Paso yo a recogerlo" en noche de promoción (14-09-2026).
 *
 * Lo que se prueba es el orden de las cosas: esa noche el pedido NO se toca
 * —ni un UPDATE— y al cliente se le dice que sale igual con delivery. Fuera de
 * la promoción, el cambio a recojo sigue exactamente como antes.
 */

let MODO: PromoMode;
const UPDATES: unknown[] = [];
const TEXTOS: string[] = [];
const MEMORIA: Array<{ content: string; metadata: Record<string, unknown> }> = [];

const FILA = {
  order_number: 'ORD-260914-012',
  delivery_type: 'delivery',
  status: 'preparing',
  subtotal_amount: 25,
  delivery_fee_paid: false,
};

/** Supabase de mentira: lee la fila del pedido y registra cada UPDATE. */
function fakeSupabase() {
  const builder: Record<string, unknown> = {};
  const encadenar = () => builder;
  for (const m of ['select', 'eq', 'in']) builder[m] = encadenar;
  builder.update = (valores: unknown) => {
    UPDATES.push(valores);
    return builder;
  };
  builder.maybeSingle = async () => ({ data: FILA, error: null });
  builder.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve({ data: [{ id: 'order-1' }], error: null }).then(resolve);
  return { from: () => builder };
}

vi.mock('@/lib/supabase/server', () => ({ getSupabaseAdmin: () => fakeSupabase() }));
vi.mock('@/lib/promotions/current-mode', () => ({ readCurrentPromoMode: async () => MODO }));
vi.mock('@/lib/alerts/outbox-store', () => ({ deliveryNoticeAlreadySent: async () => false }));
vi.mock('@/lib/kapso/client', () => ({
  getKapsoClient: () => ({
    sendText: async (_to: string, texto: string) => {
      TEXTOS.push(texto);
      return { ok: true, wamid: 'wamid.OUT_1' };
    },
  }),
}));
vi.mock('@/lib/agent/memory/repository', () => ({
  createAgentStore: () => ({
    upsertConversation: async () => ({ id: 'conv-1' }),
    insertMessage: async (m: { content: string; metadata: Record<string, unknown> }) => {
      MEMORIA.push(m);
    },
  }),
}));
vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(console, 'warn').mockImplementation(() => {});

const { switchOrderToPickup } = await import('./pickup-switch-service');

const INPUT = {
  toDigits: '59170000000',
  phoneNumberId: 'pnid-1',
  sourceMessageId: 'wamid.IN_1',
  orderId: 'order-1',
};

beforeEach(() => {
  UPDATES.length = 0;
  TEXTOS.length = 0;
  MEMORIA.length = 0;
});

describe('con el recojo apagado: no se convierte nada', () => {
  beforeEach(() => {
    MODO = { active: true, cashAllowed: false, pickupAllowed: false, comboOnlyCodes: new Set() };
  });

  it('NO toca el pedido: ni un UPDATE', async () => {
    await switchOrderToPickup(INPUT);
    expect(UPDATES).toEqual([]);
  });

  it('le dice que no, y que su pedido sale igual', async () => {
    const resultado = await switchOrderToPickup(INPUT);

    expect(resultado).toEqual({ ok: true, declined: true });
    expect(TEXTOS).toHaveLength(1);
    expect(TEXTOS[0]).toMatch(/No hacemos recojo/);
    expect(TEXTOS[0]).toMatch(/sigue igual/);
  });

  it('lo anota en la memoria como rechazo, no como cambio', async () => {
    await switchOrderToPickup(INPUT);
    expect(MEMORIA.map((m) => m.metadata.action)).toEqual(['pickup_declined']);
  });
});

/**
 * El camino de vuelta, que hoy no ocurre en producción: desde el 15-09-2026
 * `pickupAllowed` es false siempre (`orders/pickup-enabled`). Se queda aquí
 * porque este servicio obedece al modo, no a la constante: el día que el
 * recojo se encienda, esto dice qué tiene que volver a pasar.
 */
describe('con el recojo encendido: el camino de siempre', () => {
  beforeEach(() => {
    MODO = { active: false, cashAllowed: true, pickupAllowed: true, comboOnlyCodes: new Set() };
  });

  it('pasa el pedido a recojo y lo confirma', async () => {
    const resultado = await switchOrderToPickup(INPUT);

    expect(resultado).toEqual({ ok: true });
    expect(UPDATES).toEqual([{ delivery_type: 'pickup', delivery_amount: 0, total_amount: 25 }]);
    expect(TEXTOS[0]).toMatch(/queda para que lo recojas/);
    expect(MEMORIA.map((m) => m.metadata.action)).toEqual(['pickup_switch']);
  });
});
