import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createTelegramAlertSender, type TelegramResponse } from './telegram';

const CFG = { botToken: 'bot-secret-123', chatId: 'chat-999', baseUrl: 'https://tg.test' };

const jsonRes = (status: number, value: unknown): TelegramResponse => ({
  status,
  json: async () => value,
});
const badJson = (status: number): TelegramResponse => ({
  status,
  json: async () => {
    throw new Error('not json');
  },
});

function sender(over: {
  fetch?: ReturnType<typeof vi.fn>;
  cfg?: Partial<typeof CFG>;
} = {}) {
  const fetchFn = over.fetch ?? vi.fn(async () => jsonRes(200, { ok: true }));
  const s = createTelegramAlertSender(
    { ...CFG, ...over.cfg },
    { fetch: fetchFn as never, setTimer: () => 0, clearTimer: () => {} },
  );
  return { s, fetchFn };
}

describe('createTelegramAlertSender — clasificación de resultados', () => {
  it('200 + ok:true → sent', async () => {
    const { s, fetchFn } = sender();
    expect(await s.send('hola')).toEqual({ kind: 'sent' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as [string, { method: string; body: string }];
    expect(url).toBe('https://tg.test/botbot-secret-123/sendMessage');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body).chat_id).toBe('chat-999');
    expect(JSON.parse(init.body).text).toBe('hola');
  });

  it('200 + ok:false → invalid (no marcar enviada)', async () => {
    const { s } = sender({ fetch: vi.fn(async () => jsonRes(200, { ok: false })) });
    expect(await s.send('x')).toEqual({ kind: 'invalid' });
  });

  it('respuesta no JSON → invalid', async () => {
    const { s } = sender({ fetch: vi.fn(async () => badJson(200)) });
    expect(await s.send('x')).toEqual({ kind: 'invalid' });
  });

  it('400 → permanent', async () => {
    const { s } = sender({ fetch: vi.fn(async () => jsonRes(400, { ok: false })) });
    expect(await s.send('x')).toEqual({ kind: 'permanent', code: 'http_400' });
  });

  // ── Grupo convertido en supergrupo (06-09-2026) ──────────────────────────
  //
  // El 400 que trae `migrate_to_chat_id` no rechaza el mensaje: dice a dónde
  // mandarlo. Tratarlo como permanente dejó seis pedidos sin avisar al reparto
  // en una sola noche. Ver `chatIdMigrado`.
  const migrado = (id: number | string) =>
    jsonRes(400, {
      ok: false,
      description: 'Bad Request: group chat was upgraded to a supergroup chat',
      parameters: { migrate_to_chat_id: id },
    });

  it('400 con migrate_to_chat_id → reintenta en el chat nuevo y sale', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(migrado(-1004487366646))
      .mockResolvedValueOnce(jsonRes(200, { ok: true }));
    const { s } = sender({ fetch: fetchFn });

    expect(await s.send('hola')).toEqual({ kind: 'sent' });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const [, init1] = fetchFn.mock.calls[0] as [string, { body: string }];
    const [, init2] = fetchFn.mock.calls[1] as [string, { body: string }];
    expect(JSON.parse(init1.body).chat_id).toBe('chat-999');
    // El id nuevo viaja como texto, que es lo que espera la API.
    expect(JSON.parse(init2.body).chat_id).toBe('-1004487366646');
    // Y el mensaje es el MISMO: reintentar no puede reescribir el aviso.
    expect(JSON.parse(init2.body).text).toBe('hola');
  });

  it('el reintento conserva el parse_mode del original', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(migrado(-1004487366646))
      .mockResolvedValueOnce(jsonRes(200, { ok: true }));
    const { s } = sender({ fetch: fetchFn });

    await s.send('<b>QUIERE EFECTIVO</b>', 'HTML');
    const [, init2] = fetchFn.mock.calls[1] as [string, { body: string }];
    expect(JSON.parse(init2.body).parse_mode).toBe('HTML');
  });

  it('si el chat nuevo también falla, es permanent y NO encadena saltos', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(migrado(-1004487366646))
      .mockResolvedValueOnce(migrado(-1009999999999));
    const { s } = sender({ fetch: fetchFn });

    expect(await s.send('x')).toEqual({ kind: 'permanent', code: 'http_400' });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('400 con migrate_to_chat_id ilegible → permanent, sin reintento', async () => {
    const fetchFn = vi.fn(async () => migrado('no-es-un-id'));
    const { s } = sender({ fetch: fetchFn });

    expect(await s.send('x')).toEqual({ kind: 'permanent', code: 'http_400' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('404 sin migración → permanent a la primera', async () => {
    const fetchFn = vi.fn(async () => jsonRes(404, { ok: false }));
    const { s } = sender({ fetch: fetchFn });

    expect(await s.send('x')).toEqual({ kind: 'permanent', code: 'http_404' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('429 → rate_limited con retry_after válido', async () => {
    const { s } = sender({
      fetch: vi.fn(async () => jsonRes(429, { ok: false, parameters: { retry_after: 30 } })),
    });
    expect(await s.send('x')).toEqual({ kind: 'rate_limited', retryAfterSeconds: 30 });
  });

  it('429 sin retry_after válido → rate_limited sin segundos', async () => {
    const { s } = sender({ fetch: vi.fn(async () => jsonRes(429, { ok: false })) });
    expect(await s.send('x')).toEqual({ kind: 'rate_limited', retryAfterSeconds: undefined });
  });

  it('500 → transient', async () => {
    const { s } = sender({ fetch: vi.fn(async () => jsonRes(500, {})) });
    expect(await s.send('x')).toEqual({ kind: 'transient', code: 'http_500' });
  });

  it('16. error de red → transient(network_error)', async () => {
    const { s } = sender({ fetch: vi.fn(async () => { throw new Error('reset'); }) });
    expect(await s.send('x')).toEqual({ kind: 'transient', code: 'network_error' });
  });

  it('15. timeout → transient(timeout)', async () => {
    const fetchFn = vi.fn(
      (_u: string, init: { signal: AbortSignal }) =>
        new Promise<TelegramResponse>((_res, rej) => {
          const a = () => { const e = new Error('abort'); e.name = 'AbortError'; rej(e); };
          if (init.signal.aborted) a(); else init.signal.addEventListener('abort', a);
        }),
    );
    const s = createTelegramAlertSender(CFG, {
      fetch: fetchFn as never,
      setTimer: (cb) => { cb(); return 0; }, // dispara timeout de inmediato
      clearTimer: () => {},
    });
    expect(await s.send('x')).toEqual({ kind: 'transient', code: 'timeout' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('30. sin credenciales → permanent(config_missing) y CERO fetch', async () => {
    const fetchFn = vi.fn();
    const s1 = createTelegramAlertSender({ botToken: '', chatId: 'c' }, { fetch: fetchFn as never });
    const s2 = createTelegramAlertSender({ botToken: 'b', chatId: '' }, { fetch: fetchFn as never });
    expect(await s1.send('x')).toEqual({ kind: 'permanent', code: 'config_missing' });
    expect(await s2.send('x')).toEqual({ kind: 'permanent', code: 'config_missing' });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('telegram/env — server-only, sin exposición en cliente', () => {
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

  it('31/32. telegram.ts es server-only y no usa NEXT_PUBLIC_', () => {
    const src = read('./telegram.ts');
    expect(src).toContain("import 'server-only'");
    expect(src).not.toContain('NEXT_PUBLIC');
  });

  it('las variables Telegram no son NEXT_PUBLIC_ en env.ts', () => {
    const env = read('../env/env.ts');
    expect(env).toContain('TELEGRAM_BOT_TOKEN');
    expect(env).toContain('TELEGRAM_CHAT_ID');
    expect(env).not.toMatch(/NEXT_PUBLIC_TELEGRAM/);
  });
});
