import { describe, it, expect } from 'vitest';
import { createUsersRepository, normalizeUsername, type UsersDataSource } from './users-repository';
import { hashPassword } from '@/lib/security/password';
import type { DashboardUser } from '@/types';

// Ficticia a proposito: conserva el `$` final, que es lo que el test necesita
// ejercitar. Las credenciales reales NUNCA entran al repositorio.
const PASSWORD = 'claveDePrueba$1';

async function user(over: Partial<DashboardUser> = {}): Promise<DashboardUser> {
  return {
    id: 'uuid-1',
    username: 'encargado.demo',
    password_hash: await hashPassword(PASSWORD),
    role: 'admin',
    is_active: true,
    created_at: '2026-08-22T12:00:00.000Z',
    updated_at: '2026-08-22T12:00:00.000Z',
    ...over,
  };
}

/** Fuente falsa que registra con qué se la consultó. */
function fakeSource(row: DashboardUser | null) {
  const asked: string[] = [];
  const source: UsersDataSource = {
    async findByUsername(username) {
      asked.push(username);
      return row;
    },
  };
  return { source, asked };
}

describe('usuarios — autenticación correcta', () => {
  it('devuelve el rol guardado en la base', async () => {
    const { source } = fakeSource(await user({ role: 'admin' }));
    expect(await createUsersRepository(source).authenticate('encargado.demo', PASSWORD))
      .toBe('admin');
  });

  it('un usuario de cocina obtiene el rol kitchen, no admin', async () => {
    const { source } = fakeSource(
      await user({ username: 'cocina.demo', role: 'kitchen' }),
    );
    expect(await createUsersRepository(source).authenticate('cocina.demo', PASSWORD))
      .toBe('kitchen');
  });

  it('el usuario no distingue mayúsculas ni espacios sobrantes', async () => {
    const row = await user();
    for (const tecleado of [
      'encargado.demo',
      'ENCARGADO.DEMO',
      '  encargado.demo  ',
    ]) {
      const { source, asked } = fakeSource(row);
      expect(await createUsersRepository(source).authenticate(tecleado, PASSWORD), tecleado)
        .toBe('admin');
      // A la fuente siempre se le pide la forma normalizada.
      expect(asked[0]).toBe('encargado.demo');
    }
  }, 30_000);

  it('la contraseña SÍ distingue mayúsculas y caracteres especiales', async () => {
    const { source } = fakeSource(await user());
    const repo = createUsersRepository(source);
    expect(await repo.authenticate('encargado.demo', PASSWORD)).toBe('admin');
    expect(await repo.authenticate('encargado.demo', 'claveDePrueba$')).toBeNull();
    expect(await repo.authenticate('encargado.demo', 'CLAVEDEPRUEBA$1')).toBeNull();
  }, 30_000);
});

describe('usuarios — credenciales rechazadas', () => {
  it('contraseña incorrecta no entra', async () => {
    const { source } = fakeSource(await user());
    expect(await createUsersRepository(source).authenticate('encargado.demo', 'otra'))
      .toBeNull();
  });

  it('usuario inexistente no entra', async () => {
    const { source } = fakeSource(null);
    expect(await createUsersRepository(source).authenticate('fantasma', PASSWORD)).toBeNull();
  });

  it('campos vacíos no entran y no consultan la base', async () => {
    const { source, asked } = fakeSource(await user());
    const repo = createUsersRepository(source);
    expect(await repo.authenticate('', PASSWORD)).toBeNull();
    expect(await repo.authenticate('encargado.demo', '')).toBeNull();
    expect(await repo.authenticate('   ', PASSWORD)).toBeNull();
    expect(asked).toEqual([]);
  });

  it('un usuario dado de baja no entra aunque la contraseña sea correcta', async () => {
    // La fuente ya filtra por is_active, pero el repositorio no lo da por hecho.
    const { source } = fakeSource(await user({ is_active: false }));
    expect(await createUsersRepository(source).authenticate('encargado.demo', PASSWORD))
      .toBeNull();
  });

  it('un rol desconocido en la base se rechaza en vez de colarse', async () => {
    const { source } = fakeSource(
      await user({ role: 'superadmin' as DashboardUser['role'] }),
    );
    expect(await createUsersRepository(source).authenticate('encargado.demo', PASSWORD))
      .toBeNull();
  });

  it('un hash corrupto en la base no autentica ni lanza', async () => {
    const { source } = fakeSource(await user({ password_hash: 'basura' }));
    await expect(
      createUsersRepository(source).authenticate('encargado.demo', PASSWORD),
    ).resolves.toBeNull();
  });
});

describe('usuarios — el comodín no entrega otra cuenta', () => {
  it('si la búsqueda devolviera un usuario distinto al pedido, se rechaza', async () => {
    // Simula que un patrón como `%` hiciera match con la primera fila: aunque
    // la contraseña de ESA cuenta fuera correcta, el nombre no es el pedido.
    const { source } = fakeSource(await user({ username: 'encargado.demo' }));
    expect(await createUsersRepository(source).authenticate('%', PASSWORD)).toBeNull();
    expect(await createUsersRepository(source).authenticate('encargado%', PASSWORD)).toBeNull();
    expect(await createUsersRepository(source).authenticate('_'.repeat(25), PASSWORD)).toBeNull();
  }, 30_000);
});

describe('normalizeUsername', () => {
  it('recorta y pasa a minúsculas', () => {
    expect(normalizeUsername('  EncargadoDemo ')).toBe('encargadodemo');
    expect(normalizeUsername('')).toBe('');
  });
});
