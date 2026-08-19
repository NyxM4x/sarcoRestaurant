import { describe, it, expect } from 'vitest';
import { handleAgentResume } from './resume-handler';
import type { AgentResumeDeps } from './resume-handler';
import type { ResumeAgentResult } from '@/lib/agent/core/types';

/**
 * Endpoint interno de resume (`POST /api/internal/agent/resume`).
 *
 * Mismo contrato de seguridad que `/api/internal/order-notifications/retry`:
 * Bearer con el token interno, fail-closed si no está configurado, y ningún
 * dato personal en la respuesta.
 */

const TOKEN = 'internal-token-de-prueba';
const PHONE = '59162139119';

const OK_RESUMED: ResumeAgentResult = {
  result: 'ok',
  conversationId: 'conv-uuid-1',
  transition: 'resumed',
  controlEvent: 'inserted',
};

/** Doble que registra con qué teléfono se llamó al resume real. */
function deps(over: Partial<AgentResumeDeps> = {}) {
  const seen: string[] = [];
  const base: AgentResumeDeps = {
    internalToken: TOKEN,
    resume: async (phone) => {
      seen.push(phone);
      return OK_RESUMED;
    },
    ...over,
  };
  return { deps: base, seen };
}

function request(
  body: unknown,
  headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` },
): Request {
  return new Request('https://example.test/api/internal/agent/resume', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('resume-handler — autenticación', () => {
  it('401 sin cabecera Authorization', async () => {
    const { deps: d, seen } = deps();
    const res = await handleAgentResume(request({ customer_phone: PHONE }, {}), d);

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: 'unauthorized' });
    expect(seen).toEqual([]);
  });

  it('401 con token incorrecto', async () => {
    const { deps: d, seen } = deps();
    const res = await handleAgentResume(
      request({ customer_phone: PHONE }, { authorization: 'Bearer otro-token' }),
      d,
    );

    expect(res.status).toBe(401);
    expect(seen).toEqual([]);
  });

  it('401 sin token configurado: no se revela el estado de configuración', async () => {
    const { deps: d } = deps({ internalToken: undefined });
    const res = await handleAgentResume(request({ customer_phone: PHONE }), d);

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: 'unauthorized' });
  });

  it('401 con un esquema que no es Bearer', async () => {
    const { deps: d } = deps();
    const res = await handleAgentResume(
      request({ customer_phone: PHONE }, { authorization: `Basic ${TOKEN}` }),
      d,
    );

    expect(res.status).toBe(401);
  });
});

describe('resume-handler — contrato del cuerpo', () => {
  it('400 si el cuerpo no es JSON', async () => {
    const { deps: d } = deps();
    const res = await handleAgentResume(request('no-soy-json'), d);

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: 'invalid_json' });
  });

  it('422 si falta customer_phone', async () => {
    const { deps: d, seen } = deps();
    const res = await handleAgentResume(request({}), d);

    expect(res.status).toBe(422);
    expect(seen).toEqual([]);
  });

  it('422 con campos extra: el cuerpo no puede dictar el estado resultante', async () => {
    const { deps: d, seen } = deps();
    const res = await handleAgentResume(
      request({ customer_phone: PHONE, state: 'active', resumed_at: '2020-01-01' }),
      d,
    );

    expect(res.status).toBe(422);
    expect(seen).toEqual([]);
  });

  it('422 si el teléfono no queda en el dominio de 0014', async () => {
    const { deps: d, seen } = deps();
    for (const phone of ['123', 'sin-digitos', '1234567890123456']) {
      const res = await handleAgentResume(request({ customer_phone: phone }), d);
      expect(res.status, phone).toBe(422);
    }
    expect(seen).toEqual([]);
  });

  it('normaliza el teléfono antes de usarlo', async () => {
    const { deps: d, seen } = deps();
    const res = await handleAgentResume(request({ customer_phone: '+591 62-139119' }), d);

    expect(res.status).toBe(200);
    expect(seen).toEqual([PHONE]);
  });
});

describe('resume-handler — desenlaces', () => {
  it('200 cuando la conversación se reanuda', async () => {
    const { deps: d } = deps();
    const res = await handleAgentResume(request({ customer_phone: PHONE }), d);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      outcome: 'resumed',
      conversation_id: 'conv-uuid-1',
      control_event: 'inserted',
    });
  });

  it('200 y already_active cuando ya estaba activa', async () => {
    const { deps: d } = deps({
      resume: async () => ({
        result: 'ok',
        conversationId: 'conv-uuid-1',
        transition: 'already_active',
        controlEvent: 'duplicate',
      }),
    });
    const res = await handleAgentResume(request({ customer_phone: PHONE }), d);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      outcome: 'already_active',
      control_event: 'duplicate',
    });
  });

  it('404 si ese teléfono no tiene conversación', async () => {
    const { deps: d } = deps({ resume: async () => ({ result: 'not_found' }) });
    const res = await handleAgentResume(request({ customer_phone: PHONE }), d);

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({
      ok: false,
      outcome: 'not_found',
      conversation_id: null,
    });
  });

  it('500 si el resume revienta, sin filtrar el error técnico', async () => {
    const { deps: d } = deps({
      resume: async () => {
        throw new Error('permission denied for table agent_conversations');
      },
    });
    const res = await handleAgentResume(request({ customer_phone: PHONE }), d);

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: 'internal_error' });
  });

  it('la respuesta nunca lleva el teléfono, ni entero ni parcial', async () => {
    const { deps: d } = deps();
    const res = await handleAgentResume(request({ customer_phone: PHONE }), d);

    const body = JSON.stringify(await res.json());
    expect(body).not.toContain(PHONE);
    expect(body).not.toContain('9119');
  });
});
