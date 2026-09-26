import { beforeEach, describe, expect, it, vi } from 'vitest';

const env: {
  TEST_REDIRECT_URL?: string;
  TEST_WHATSAPP_TO?: string;
} = {
  TEST_REDIRECT_URL: 'https://preview.example.test/r/test',
  TEST_WHATSAPP_TO: '59170000001',
};
const sendText = vi.fn();
const sendMenuCtaUrl = vi.fn();
const getKapsoClient = vi.fn();

vi.mock('@/lib/env/env', () => ({ getServerEnv: () => env }));
vi.mock('@/lib/kapso/client', () => ({ getKapsoClient }));

const { POST } = await import('./route');

beforeEach(() => {
  env.TEST_REDIRECT_URL = 'https://preview.example.test/r/test';
  env.TEST_WHATSAPP_TO = '59170000001';
  sendText.mockReset();
  sendMenuCtaUrl.mockReset();
  getKapsoClient.mockReset();
  getKapsoClient.mockReturnValue({ sendText, sendMenuCtaUrl });
});

describe('POST /api/test/whatsapp-link', () => {
  it('uses sendText with the configured recipient and complete redirect URL', async () => {
    sendText.mockResolvedValue({ ok: true, wamid: 'wamid.test' });

    const response = await POST();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, wamid: 'wamid.test' });
    expect(sendText).toHaveBeenCalledWith(
      '59170000001',
      'Hola Yoan 👋\n\nPara hacer tu pedido ingresa al siguiente link:\n\nhttps://preview.example.test/r/test',
    );
    expect(sendMenuCtaUrl).not.toHaveBeenCalled();
  });

  it('fails clearly before using Kapso when the redirect URL is absent', async () => {
    env.TEST_REDIRECT_URL = undefined;

    const response = await POST();

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, error: 'test_redirect_url_not_configured' });
    expect(getKapsoClient).not.toHaveBeenCalled();
  });

  it('fails clearly before using Kapso when the recipient is absent', async () => {
    env.TEST_WHATSAPP_TO = undefined;

    const response = await POST();

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, error: 'test_whatsapp_to_not_configured' });
    expect(getKapsoClient).not.toHaveBeenCalled();
  });

  it('returns the typed Kapso error without provider details', async () => {
    sendText.mockResolvedValue({ ok: false, error: 'timeout' });

    const response = await POST();

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ ok: false, error: 'timeout' });
    expect(sendMenuCtaUrl).not.toHaveBeenCalled();
  });
});
