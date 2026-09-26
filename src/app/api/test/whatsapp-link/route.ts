import 'server-only';
import { getServerEnv } from '@/lib/env/env';
import { getKapsoClient } from '@/lib/kapso/client';

export async function POST() {
  let env: ReturnType<typeof getServerEnv>;

  try {
    env = getServerEnv();
  } catch {
    return Response.json({ ok: false, error: 'server_environment_invalid' }, { status: 503 });
  }

  if (!env.TEST_REDIRECT_URL) {
    return Response.json({ ok: false, error: 'test_redirect_url_not_configured' }, { status: 503 });
  }

  if (!env.TEST_WHATSAPP_TO) {
    return Response.json({ ok: false, error: 'test_whatsapp_to_not_configured' }, { status: 503 });
  }

  try {
    const result = await getKapsoClient().sendText(
      env.TEST_WHATSAPP_TO,
      `Hola Yoan 👋\n\nPara hacer tu pedido ingresa al siguiente link:\n\n${env.TEST_REDIRECT_URL}`,
      { previewUrl: true },
    );

    if (!result.ok) {
      return Response.json({ ok: false, error: result.error }, { status: 502 });
    }

    return Response.json({ ok: true, wamid: result.wamid });
  } catch {
    return Response.json({ ok: false, error: 'kapso_configuration_error' }, { status: 503 });
  }
}
