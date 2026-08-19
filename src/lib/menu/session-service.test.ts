import { describe, it, expect } from 'vitest';
import { createMenuSessionWithUrl, type MenuSessionServiceDeps } from './session-service';
import { generateMenuSessionToken, hashMenuSessionToken } from './session-token';
import type { MenuSession } from '@/types';

const SECRET = 'test-secret-menu-session';
const APP = 'https://sarco-restaurant.vercel.app';

function session(over: Partial<MenuSession> = {}): MenuSession {
  const sourceId = over.source_message_id ?? 'wamid.OLD';
  const token = generateMenuSessionToken(sourceId, SECRET);
  return {
    id: '00000000-0000-4000-8000-000000000001',
    source_message_id: sourceId,
    token_hash: hashMenuSessionToken(token),
    customer_phone: '59170000000',
    phone_number_id: 'pnid-stored',
    created_at: '2026-08-11T18:00:00.000Z',
    expires_at: '2026-08-11T20:00:00.000Z',
    ...over,
  } as MenuSession;
}

function deps(over: Partial<MenuSessionServiceDeps> = {}): {
  deps: MenuSessionServiceDeps;
  getOrCreateCalls: unknown[];
} {
  const getOrCreateCalls: unknown[] = [];
  return {
    getOrCreateCalls,
    deps: {
      appBaseUrl: APP,
      secret: SECRET,
      envPhoneNumberId: 'pnid-env',
      async findValidByPhone() {
        return null;
      },
      async sessionHasOrder() {
        return false;
      },
      async getOrCreate(input) {
        getOrCreateCalls.push(input);
        return session({ ...input } as Partial<MenuSession>);
      },
      ...over,
    },
  };
}

function tokenFromUrl(url: string): string {
  return new URL(url).searchParams.get('session') ?? '';
}

describe('createMenuSessionWithUrl — reutilización (6D.2E)', () => {
  it('18/20. reutiliza una sesión vigente del teléfono y regenera su token', async () => {
    const existing = session({ source_message_id: 'wamid.OLD', phone_number_id: 'pnid-stored' });
    const { deps: d, getOrCreateCalls } = deps({ async findValidByPhone() { return existing; } });

    const res = await createMenuSessionWithUrl(
      { source_message_id: 'wamid.NEW', customer_phone: '59170000000', phone_number_id_from_event: 'pnid-evento' },
      d,
    );

    // No se creó fila nueva.
    expect(getOrCreateCalls).toHaveLength(0);
    // El token regenerado corresponde a la sesión reutilizada (hashea a su token_hash).
    const token = tokenFromUrl(res.session_url);
    expect(hashMenuSessionToken(token)).toBe(existing.token_hash);
    expect(token).toBe(generateMenuSessionToken('wamid.OLD', SECRET));
    // Usa el phone_number_id persistido de la sesión reutilizada.
    expect(res.effective_phone_number_id).toBe('pnid-stored');
  });

  it('repeat-order: una sesión YA consumida (con pedido) NO se reutiliza → crea nueva', async () => {
    const consumed = session({ source_message_id: 'wamid.S1' });
    const { deps: d, getOrCreateCalls } = deps({
      async findValidByPhone() { return consumed; },
      async sessionHasOrder() { return true; }, // S1 ya generó order A
    });

    const res = await createMenuSessionWithUrl(
      { source_message_id: 'wamid.S2', customer_phone: '59170000000', phone_number_id_from_event: 'pnid-evento' },
      d,
    );

    // No reutiliza S1 (impediría order B): crea una nueva sesión S2.
    expect(getOrCreateCalls).toHaveLength(1);
    expect((getOrCreateCalls[0] as { source_message_id: string }).source_message_id).toBe('wamid.S2');
    // El token entregado corresponde a la NUEVA sesión (S2), no a S1.
    const token = tokenFromUrl(res.session_url);
    expect(token).toBe(generateMenuSessionToken('wamid.S2', SECRET));
    expect(token).not.toBe(generateMenuSessionToken('wamid.S1', SECRET));
  });

  it('reutiliza solo si la sesión vigente NO está consumida', async () => {
    const fresh = session({ source_message_id: 'wamid.OLD' });
    const { deps: d, getOrCreateCalls } = deps({
      async findValidByPhone() { return fresh; },
      async sessionHasOrder() { return false; }, // aún sin pedido
    });
    const res = await createMenuSessionWithUrl(
      { source_message_id: 'wamid.NEW', customer_phone: '59170000000', phone_number_id_from_event: null },
      d,
    );
    expect(getOrCreateCalls).toHaveLength(0);
    expect(tokenFromUrl(res.session_url)).toBe(generateMenuSessionToken('wamid.OLD', SECRET));
  });

  it('si el token regenerado NO hashea al guardado, no confía: crea una nueva', async () => {
    const corrupt = session({ source_message_id: 'wamid.OLD', token_hash: 'hash-que-no-corresponde' });
    const { deps: d, getOrCreateCalls } = deps({ async findValidByPhone() { return corrupt; } });

    const res = await createMenuSessionWithUrl(
      { source_message_id: 'wamid.NEW', customer_phone: '59170000000', phone_number_id_from_event: null },
      d,
    );
    expect(getOrCreateCalls).toHaveLength(1);
    expect(tokenFromUrl(res.session_url)).toBe(generateMenuSessionToken('wamid.NEW', SECRET));
  });
});

describe('createMenuSessionWithUrl — creación (sin sesión vigente)', () => {
  it('19. sin sesión vigente → crea con token del source_message_id nuevo', async () => {
    const { deps: d, getOrCreateCalls } = deps(); // findValidByPhone → null por defecto
    const res = await createMenuSessionWithUrl(
      { source_message_id: 'wamid.NEW', customer_phone: '59170000000', phone_number_id_from_event: 'pnid-evento' },
      d,
    );
    expect(getOrCreateCalls).toHaveLength(1);
    const token = tokenFromUrl(res.session_url);
    expect(token).toBe(generateMenuSessionToken('wamid.NEW', SECRET));
    expect(res.session_url.startsWith(`${APP}/menu?`)).toBe(true);
  });

  it('resuelve phone_number_id: evento → env como fallback', async () => {
    const { deps: d } = deps();
    const withEvent = await createMenuSessionWithUrl(
      { source_message_id: 'w1', customer_phone: '59170000000', phone_number_id_from_event: 'pnid-evento' },
      d,
    );
    expect(withEvent.effective_phone_number_id).toBe('pnid-evento');

    const withEnv = await createMenuSessionWithUrl(
      { source_message_id: 'w2', customer_phone: '59170000000', phone_number_id_from_event: null },
      d,
    );
    expect(withEnv.effective_phone_number_id).toBe('pnid-env');
  });

  it('sin phone_number_id (ni evento ni env) → lanza', async () => {
    const { deps: base } = deps();
    const d = { ...base, envPhoneNumberId: null };
    await expect(
      createMenuSessionWithUrl(
        { source_message_id: 'w3', customer_phone: '59170000000', phone_number_id_from_event: null },
        d,
      ),
    ).rejects.toThrow(/no phone_number_id available/);
  });
});
