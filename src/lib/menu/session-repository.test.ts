import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createMenuSessionRepository } from './session-repository';

const TOKEN_HASH = 'a'.repeat(64);
const SESSION_ID = '11111111-1111-4111-8111-111111111111';

/** Llamadas registradas por el doble de Supabase, para verificar la proyección. */
interface RecordedQuery {
  table: string;
  columns: string;
  filters: Array<{ op: string; column: string; value: unknown }>;
  terminator: string;
}

/**
 * Doble encadenable del query builder de Supabase.
 *
 * Solo implementa lo que usa `findValidIdByHash`: from → select → eq → gt →
 * maybeSingle. Registra tabla, columnas y filtros para poder afirmar que la
 * consulta proyecta únicamente `id`.
 */
function fakeSupabase(result: { data: unknown; error: { message: string } | null }) {
  const queries: RecordedQuery[] = [];

  const client = {
    from(table: string) {
      const query: RecordedQuery = { table, columns: '', filters: [], terminator: '' };
      queries.push(query);

      const builder = {
        select(columns: string) {
          query.columns = columns;
          return builder;
        },
        eq(column: string, value: unknown) {
          query.filters.push({ op: 'eq', column, value });
          return builder;
        },
        gt(column: string, value: unknown) {
          query.filters.push({ op: 'gt', column, value });
          return builder;
        },
        order(column: string, opts: unknown) {
          query.filters.push({ op: 'order', column, value: opts });
          return builder;
        },
        limit(n: number) {
          query.filters.push({ op: 'limit', column: '', value: n });
          return builder;
        },
        async maybeSingle() {
          query.terminator = 'maybeSingle';
          return result;
        },
      };

      return builder;
    },
  };

  return { client: client as unknown as SupabaseClient, queries };
}

describe('createMenuSessionRepository.findValidByPhone (6D.2E)', () => {
  it('consulta por teléfono, exige vigencia y toma la más reciente', async () => {
    const row = { id: SESSION_ID, source_message_id: 'wamid.OLD', token_hash: TOKEN_HASH };
    const { client, queries } = fakeSupabase({ data: row, error: null });
    const repo = createMenuSessionRepository(client);

    const result = await repo.findValidByPhone('59170000000');

    expect(result).toEqual(row);
    const q = queries[0];
    expect(q.table).toBe('menu_sessions');
    expect(q.filters).toContainEqual({ op: 'eq', column: 'customer_phone', value: '59170000000' });
    expect(q.filters.some((f) => f.op === 'gt' && f.column === 'expires_at')).toBe(true);
    expect(q.filters).toContainEqual({ op: 'order', column: 'expires_at', value: { ascending: false } });
    expect(q.filters).toContainEqual({ op: 'limit', column: '', value: 1 });
    expect(q.terminator).toBe('maybeSingle');
  });

  it('sin sesión vigente devuelve null', async () => {
    const { client } = fakeSupabase({ data: null, error: null });
    const repo = createMenuSessionRepository(client);
    expect(await repo.findValidByPhone('59170000000')).toBeNull();
  });
});

describe('createMenuSessionRepository.sessionHasOrder (6D.2E.final)', () => {
  it('consulta orders por menu_session_id y devuelve true si existe', async () => {
    const { client, queries } = fakeSupabase({ data: { id: 'order-1' }, error: null });
    const repo = createMenuSessionRepository(client);

    expect(await repo.sessionHasOrder(SESSION_ID)).toBe(true);
    const q = queries[0];
    expect(q.table).toBe('orders');
    expect(q.columns).toBe('id');
    expect(q.filters).toContainEqual({ op: 'eq', column: 'menu_session_id', value: SESSION_ID });
  });

  it('devuelve false cuando la sesión no tiene pedido', async () => {
    const { client } = fakeSupabase({ data: null, error: null });
    const repo = createMenuSessionRepository(client);
    expect(await repo.sessionHasOrder(SESSION_ID)).toBe(false);
  });
});

describe('createMenuSessionRepository.findValidIdByHash', () => {
  it('sesión válida devuelve solamente el id', async () => {
    const { client } = fakeSupabase({ data: { id: SESSION_ID }, error: null });
    const repo = createMenuSessionRepository(client);

    const result = await repo.findValidIdByHash(TOKEN_HASH);

    expect(result).toBe(SESSION_ID);
    expect(typeof result).toBe('string');
  });

  it('proyecta únicamente la columna id', async () => {
    const { client, queries } = fakeSupabase({ data: { id: SESSION_ID }, error: null });

    await createMenuSessionRepository(client).findValidIdByHash(TOKEN_HASH);

    expect(queries).toHaveLength(1);
    expect(queries[0].table).toBe('menu_sessions');
    expect(queries[0].columns).toBe('id');
    // Nada de customer_phone, phone_number_id ni token_hash en la proyección.
    expect(queries[0].columns).not.toContain('customer_phone');
    expect(queries[0].columns).not.toContain('phone_number_id');
    expect(queries[0].columns).not.toContain('token_hash');
    expect(queries[0].columns).not.toBe('*');
  });

  it('filtra por token_hash y por expires_at > now()', async () => {
    const { client, queries } = fakeSupabase({ data: { id: SESSION_ID }, error: null });
    const antes = Date.now();

    await createMenuSessionRepository(client).findValidIdByHash(TOKEN_HASH);

    const [eqFilter, gtFilter] = queries[0].filters;
    expect(eqFilter).toEqual({ op: 'eq', column: 'token_hash', value: TOKEN_HASH });
    expect(gtFilter.op).toBe('gt');
    expect(gtFilter.column).toBe('expires_at');
    expect(new Date(gtFilter.value as string).getTime()).toBeGreaterThanOrEqual(antes - 1000);
    expect(queries[0].terminator).toBe('maybeSingle');
  });

  it('sesión inexistente devuelve null', async () => {
    const { client } = fakeSupabase({ data: null, error: null });

    await expect(createMenuSessionRepository(client).findValidIdByHash(TOKEN_HASH)).resolves.toBeNull();
  });

  it('sesión vencida devuelve null (el filtro gt la excluye)', async () => {
    const { client } = fakeSupabase({ data: null, error: null });

    await expect(createMenuSessionRepository(client).findValidIdByHash(TOKEN_HASH)).resolves.toBeNull();
  });

  it('error de Supabase lanza un error sin incluir el tokenHash', async () => {
    const { client } = fakeSupabase({
      data: null,
      error: { message: `no such row for token_hash=${TOKEN_HASH} at db.internal:5432` },
    });

    await expect(
      createMenuSessionRepository(client).findValidIdByHash(TOKEN_HASH),
    ).rejects.toThrowError(/session\.findValidIdByHash: lookup failed/);
  });

  it('el error tampoco filtra el mensaje crudo de Supabase', async () => {
    const { client } = fakeSupabase({
      data: null,
      error: { message: `token_hash=${TOKEN_HASH} db.internal secret-detail` },
    });

    let captured: unknown;
    try {
      await createMenuSessionRepository(client).findValidIdByHash(TOKEN_HASH);
    } catch (error) {
      captured = error;
    }

    expect(captured).toBeInstanceOf(Error);
    const message = (captured as Error).message;
    expect(message).not.toContain(TOKEN_HASH);
    expect(message).not.toContain('db.internal');
    expect(message).not.toContain('secret-detail');
  });
});
