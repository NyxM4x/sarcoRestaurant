import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { replaceSupersededOrder } from './order-replacement';

/**
 * EL PEDIDO CORREGIDO SUSTITUYE AL ANTERIOR (0035).
 *
 * Es la única función del proyecto que CANCELA un pedido sin que nadie pulse
 * nada, así que lo que se prueba aquí no es tanto que cancele como que NO
 * cancele: teléfono distinto, pedido ya en la plancha, pago en vuelo, consulta
 * caída. Cada una de esas ramas protege comida hecha o dinero recibido.
 */

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const VIEJO = '22222222-2222-4222-8222-222222222222';
const NUEVO = '33333333-3333-4333-8333-333333333333';
const PHONE = '59170000001';

interface Escenario {
  /** Fila de `menu_sessions`, o `null` si no se encuentra. */
  sesion?: { replaces_order_id: string | null; customer_phone: string } | null;
  sesionError?: boolean;
  /** Fila de `orders` del pedido viejo. */
  pedido?: { id: string; status: string; customer_phone: string; notes: string | null } | null;
  /** Intentos de pago vivos que devuelve la consulta. */
  pagos?: Array<{ review_status: string }>;
  pagosError?: boolean;
  /** Filas que devuelve el UPDATE (vacío = el guard de estado no dejó pasar). */
  actualizadas?: Array<{ id: string }>;
}

/** Registro de lo que se intentó escribir, para poder afirmar que NO se escribió. */
interface Registro {
  updates: Array<Record<string, unknown>>;
}

function fakeSupabase(escenario: Escenario): { client: SupabaseClient; registro: Registro } {
  const registro: Registro = { updates: [] };

  const client = {
    from(table: string) {
      const builder = {
        select: () => builder,
        update(values: Record<string, unknown>) {
          registro.updates.push(values);
          return builder;
        },
        eq: () => builder,
        in: () => builder,
        limit: () =>
          Promise.resolve(
            escenario.pagosError
              ? { data: null, error: { message: 'boom' } }
              : { data: escenario.pagos ?? [], error: null },
          ),
        maybeSingle: () => {
          if (table === 'menu_sessions') {
            return Promise.resolve(
              escenario.sesionError
                ? { data: null, error: { message: 'boom' } }
                : { data: escenario.sesion ?? null, error: null },
            );
          }
          return Promise.resolve({ data: escenario.pedido ?? null, error: null });
        },
        // El UPDATE termina en `.select('id')`, que resuelve la promesa.
        then: undefined as unknown,
      };

      // `update(...).eq(...).eq(...).select('id')` tiene que resolver: se
      // distingue del `select()` de lectura porque para entonces ya se registró
      // el update.
      const conSelectFinal = {
        ...builder,
        select: (columns?: string) => {
          if (columns === 'id' && registro.updates.length > 0) {
            return Promise.resolve({
              data: escenario.actualizadas ?? [{ id: VIEJO }],
              error: null,
            });
          }
          return conSelectFinal;
        },
        update(values: Record<string, unknown>) {
          registro.updates.push(values);
          return conSelectFinal;
        },
        eq: () => conSelectFinal,
        in: () => conSelectFinal,
        limit: builder.limit,
        maybeSingle: builder.maybeSingle,
      };

      return conSelectFinal;
    },
  } as unknown as SupabaseClient;

  return { client, registro };
}

const sesionDeCambio = { replaces_order_id: VIEJO, customer_phone: PHONE };
const pedidoVivo = { id: VIEJO, status: 'confirmed', customer_phone: PHONE, notes: null };

describe('replaceSupersededOrder', () => {
  it('cancela el pedido anterior y lo deja anotado', async () => {
    const { client, registro } = fakeSupabase({ sesion: sesionDeCambio, pedido: pedidoVivo });

    const resultado = await replaceSupersededOrder(
      { newOrderId: NUEVO, menuSessionId: SESSION_ID },
      client,
    );

    expect(resultado).toEqual({ result: 'replaced', replacedOrderId: VIEJO });
    expect(registro.updates[0]).toMatchObject({ status: 'cancelled' });
    expect(String(registro.updates[0].notes)).toContain('Reemplazado');
  });

  it('una sesión normal no cancela nada: es el caso de todos los días', async () => {
    const { client, registro } = fakeSupabase({
      sesion: { replaces_order_id: null, customer_phone: PHONE },
    });

    const resultado = await replaceSupersededOrder(
      { newOrderId: NUEVO, menuSessionId: SESSION_ID },
      client,
    );

    expect(resultado).toEqual({ result: 'not_a_replacement' });
    expect(registro.updates).toHaveLength(0);
  });

  it('con un pago ACEPTADO no se toca: hay dinero contra ese total', async () => {
    const { client, registro } = fakeSupabase({
      sesion: sesionDeCambio,
      pedido: pedidoVivo,
      pagos: [{ review_status: 'accepted' }],
    });

    const resultado = await replaceSupersededOrder(
      { newOrderId: NUEVO, menuSessionId: SESSION_ID },
      client,
    );

    expect(resultado).toEqual({ result: 'skipped', reason: 'payment_in_flight' });
    expect(registro.updates).toHaveLength(0);
  });

  it('con un comprobante esperando revisión tampoco', async () => {
    const { client, registro } = fakeSupabase({
      sesion: sesionDeCambio,
      pedido: pedidoVivo,
      pagos: [{ review_status: 'pending_review' }],
    });

    const resultado = await replaceSupersededOrder(
      { newOrderId: NUEVO, menuSessionId: SESSION_ID },
      client,
    );

    expect(resultado).toEqual({ result: 'skipped', reason: 'payment_in_flight' });
    expect(registro.updates).toHaveLength(0);
  });

  it('si no se pudo consultar el pago, NO se cancela', async () => {
    // "No lo sabemos" con dinero de por medio se trata como un sí.
    const { client, registro } = fakeSupabase({
      sesion: sesionDeCambio,
      pedido: pedidoVivo,
      pagosError: true,
    });

    const resultado = await replaceSupersededOrder(
      { newOrderId: NUEVO, menuSessionId: SESSION_ID },
      client,
    );

    expect(resultado).toEqual({ result: 'skipped', reason: 'payment_in_flight' });
    expect(registro.updates).toHaveLength(0);
  });

  it('un pedido que ya está en la plancha no se cancela', async () => {
    const { client, registro } = fakeSupabase({
      sesion: sesionDeCambio,
      pedido: { ...pedidoVivo, status: 'preparing' },
    });

    const resultado = await replaceSupersededOrder(
      { newOrderId: NUEVO, menuSessionId: SESSION_ID },
      client,
    );

    expect(resultado).toEqual({ result: 'skipped', reason: 'not_confirmed' });
    expect(registro.updates).toHaveLength(0);
  });

  it('un enlace que apunta a otro teléfono no cancela el pedido de nadie', async () => {
    const { client, registro } = fakeSupabase({
      sesion: sesionDeCambio,
      pedido: { ...pedidoVivo, customer_phone: '59170000999' },
    });

    const resultado = await replaceSupersededOrder(
      { newOrderId: NUEVO, menuSessionId: SESSION_ID },
      client,
    );

    expect(resultado).toEqual({ result: 'skipped', reason: 'phone_mismatch' });
    expect(registro.updates).toHaveLength(0);
  });

  it('si el UPDATE no alcanza ninguna fila, el estado cambió por debajo', async () => {
    // La cocina aceptó el pago entre la lectura y la escritura. El guard viaja
    // dentro del UPDATE justamente para este instante.
    const { client } = fakeSupabase({
      sesion: sesionDeCambio,
      pedido: pedidoVivo,
      actualizadas: [],
    });

    const resultado = await replaceSupersededOrder(
      { newOrderId: NUEVO, menuSessionId: SESSION_ID },
      client,
    );

    expect(resultado).toEqual({ result: 'skipped', reason: 'not_confirmed' });
  });

  it('un enlace que apunta al pedido recién creado no se muerde la cola', async () => {
    const { client, registro } = fakeSupabase({
      sesion: { replaces_order_id: NUEVO, customer_phone: PHONE },
    });

    const resultado = await replaceSupersededOrder(
      { newOrderId: NUEVO, menuSessionId: SESSION_ID },
      client,
    );

    expect(resultado).toEqual({ result: 'not_a_replacement' });
    expect(registro.updates).toHaveLength(0);
  });

  it('una consulta caída no cancela nada', async () => {
    const { client, registro } = fakeSupabase({ sesionError: true });

    const resultado = await replaceSupersededOrder(
      { newOrderId: NUEVO, menuSessionId: SESSION_ID },
      client,
    );

    expect(resultado).toEqual({ result: 'failed' });
    expect(registro.updates).toHaveLength(0);
  });
});
