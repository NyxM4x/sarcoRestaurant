import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  handleNotificationReconcile,
  type NotificationReconcileDeps,
} from './reconcile-handler';
import type { ReconcileContext } from './reconcile-runner';

const TOKEN = 'internal-token-xyz';
const ORDER_ID = 'c3333333-3333-4333-8333-333333333333';
const RECIPIENT = '59170000000';

function baseDeps(context: ReconcileContext | null): NotificationReconcileDeps {
  return {
    internalToken: TOKEN,
    now: () => Date.parse('2026-07-22T18:05:00.000Z'),
    async loadContext() {
      return context;
    },
    async claim() {
      return { claimed: false, reason: 'not_available' };
    },
    async listOutbound() {
      return { ok: true, messages: [], nextCursor: null };
    },
    async markSent() {
      return true;
    },
    async scheduleRetry() {
      return { scheduled: true };
    },
    async reschedule() {
      return { rescheduled: true };
    },
    async markTerminal() {
      return true;
    },
    async terminalizeExhausted() {
      return true;
    },
  };
}

function request(body: unknown, token = TOKEN): Request {
  return new Request('http://localhost/api/internal/order-notifications/reconcile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('handleNotificationReconcile — autenticación y contrato', () => {
  it('sin token válido responde 401', async () => {
    const res = await handleNotificationReconcile(request({ order_id: ORDER_ID }, 'malo'), baseDeps(null));
    expect(res.status).toBe(401);
  });

  it('sin token configurado también responde 401', async () => {
    const deps = { ...baseDeps(null), internalToken: '' };
    const res = await handleNotificationReconcile(request({ order_id: ORDER_ID }), deps);
    expect(res.status).toBe(401);
  });

  it('cuerpo no JSON responde 400', async () => {
    const res = await handleNotificationReconcile(request('{no-json'), baseDeps(null));
    expect(res.status).toBe(400);
  });

  it('un campo extra en el cuerpo se rechaza con 422', async () => {
    const res = await handleNotificationReconcile(
      request({ order_id: ORDER_ID, notification_type: 'confirmation' }),
      baseDeps(null),
    );
    expect(res.status).toBe(422);
  });

  it('order_id ausente o no-uuid se rechaza con 422', async () => {
    const res = await handleNotificationReconcile(request({ order_id: 'x' }), baseDeps(null));
    expect(res.status).toBe(422);
  });
});

describe('handleNotificationReconcile — resultados', () => {
  it('16. pedido sin notificaciones → not_found', async () => {
    const res = await handleNotificationReconcile(request({ order_id: ORDER_ID }), baseDeps(null));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.reason).toBe('not_found');
    expect(body.confirmation).toBe('not_applicable');
    expect(body.location_request).toBe('not_applicable');
  });

  it('ambas ya enviadas → already_sent, sin efectos', async () => {
    const ctx: ReconcileContext = {
      orderNumber: 'ORD-000009',
      normalizedRecipient: RECIPIENT,
      phoneNumberId: 'pnid-1',
      orderReceived: null,
      confirmation: { notificationType: 'confirmation', status: 'sent', lastAttemptAt: null },
      locationRequest: { notificationType: 'location_request', status: 'sent', lastAttemptAt: null },
    };
    const res = await handleNotificationReconcile(request({ order_id: ORDER_ID }), baseDeps(ctx));
    const body = await res.json();
    expect(body.confirmation).toBe('already_sent');
    expect(body.location_request).toBe('already_sent');
  });

  it('19. la respuesta solo expone order_id y outcomes por tipo', async () => {
    const ctx: ReconcileContext = {
      orderNumber: 'ORD-000009',
      normalizedRecipient: RECIPIENT,
      phoneNumberId: 'pnid-1',
      orderReceived: null,
      confirmation: { notificationType: 'confirmation', status: 'sent', lastAttemptAt: null },
      locationRequest: null,
    };
    const res = await handleNotificationReconcile(request({ order_id: ORDER_ID }), baseDeps(ctx));
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(
      ['confirmation', 'location_request', 'ok', 'order_id', 'order_received', 'reason'].sort(),
    );
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(RECIPIENT);
    expect(serialized).not.toContain('pnid-1');
  });

  it('un fallo inesperado responde 500 sin filtrar detalle', async () => {
    const deps: NotificationReconcileDeps = {
      ...baseDeps(null),
      async loadContext() {
        throw new Error('boom secret detail');
      },
    };
    const res = await handleNotificationReconcile(request({ order_id: ORDER_ID }), deps);
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(JSON.stringify(body)).not.toContain('boom');
  });
});

describe('ruta /api/internal/order-notifications/reconcile', () => {
  const routePath = fileURLToPath(
    new URL('../../../app/api/internal/order-notifications/reconcile/route.ts', import.meta.url),
  );
  const source = readFileSync(routePath, 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  it('declara runtime, dynamic y maxDuration', async () => {
    const route = await import('@/app/api/internal/order-notifications/reconcile/route');
    expect(route.runtime).toBe('nodejs');
    expect(route.dynamic).toBe('force-dynamic');
    expect(route.maxDuration).toBe(60);
  });

  it('expone POST cableado al handler', async () => {
    const route = await import('@/app/api/internal/order-notifications/reconcile/route');
    expect(typeof route.POST).toBe('function');
    expect(source).toContain('handleNotificationReconcile');
  });

  it('no envía: no cablea sender, dispatch ni initialize', () => {
    expect(code).not.toContain('initializeAndDispatch');
    expect(code).not.toContain('dispatchExisting');
    expect(code).not.toContain('sendText');
    expect(code).not.toContain('sendLocationRequest');
  });
});
