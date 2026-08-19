import { describe, it, expect } from 'vitest';
import {
  ALLOWED_MEDIA_HOSTS,
  checkMediaUrl,
  isInternalHost,
  shouldSendKapsoKey,
} from './media-url-policy';
import { KAPSO_MEDIA_URL, META_LOOKASIDE_URL } from './channel/image.fixtures';

/**
 * POLÍTICA DE URL DE MEDIA — SSRF (endurecimiento pre-push de 5C.5).
 *
 * El resolutor hace `fetch` desde el servidor hacia una URL que eligió quien
 * mandó el webhook. Estos tests son la puerta: lo que no pase aquí, no se
 * descarga.
 */

describe('media-url-policy — lo que SÍ pasa', () => {
  it('las dos URLs reales del contrato observado', () => {
    expect(checkMediaUrl(KAPSO_MEDIA_URL)).toEqual({ ok: true, hostname: 'app.kapso.ai' });
    expect(checkMediaUrl(META_LOOKASIDE_URL)).toEqual({
      ok: true,
      hostname: 'lookaside.fbsbx.com',
    });
  });

  it('la lista blanca tiene exactamente los dos hosts observados', () => {
    // Si alguien añade uno, que sea una decisión visible en un diff, no un
    // efecto colateral de tocar otra cosa.
    expect([...ALLOWED_MEDIA_HOSTS]).toEqual(['app.kapso.ai', 'lookaside.fbsbx.com']);
  });

  it('el puerto 443 explícito y las mayúsculas del host no molestan', () => {
    expect(checkMediaUrl('https://app.kapso.ai:443/media/x').ok).toBe(true);
    expect(checkMediaUrl('https://APP.KAPSO.AI/media/x')).toEqual({
      ok: true,
      hostname: 'app.kapso.ai',
    });
  });
});

describe('media-url-policy — protocolo', () => {
  it('http se rechaza aunque el host esté permitido', () => {
    expect(checkMediaUrl('http://app.kapso.ai/media/x')).toEqual({
      ok: false,
      reason: 'not_https',
      hostname: 'app.kapso.ai',
    });
  });

  it('file: y data: no son transportes de descarga', () => {
    expect(checkMediaUrl('file:///etc/passwd')).toMatchObject({ ok: false, reason: 'not_https' });
    expect(checkMediaUrl('data:image/jpeg;base64,AAAA')).toMatchObject({
      ok: false,
      reason: 'not_https',
    });
  });

  it('un data URL que venga del WEBHOOK no entra por la puerta', () => {
    // El data URL que generamos NOSOTROS tras descargar y validar sí es válido
    // para OpenAI. Lo que no puede pasar es que uno llegue de fuera y se trate
    // como si lo hubiéramos producido aquí.
    const disfrazado = `data:image/jpeg;base64,${'A'.repeat(64)}`;
    expect(checkMediaUrl(disfrazado).ok).toBe(false);
  });
});

describe('media-url-policy — hacia dentro no se sale', () => {
  const internos = [
    'https://localhost/media/x',
    'https://localhost:443/media/x',
    'https://127.0.0.1/media/x',
    'https://127.1.2.3/media/x',
    'https://10.0.0.5/media/x',
    'https://172.16.0.9/media/x',
    'https://192.168.1.10/media/x',
    'https://169.254.169.254/latest/meta-data/', // metadatos de nube
    'https://100.64.0.1/media/x', // CGNAT
    'https://0.0.0.0/media/x',
    'https://[::1]/media/x',
    'https://[fe80::1]/media/x',
    'https://[fc00::1]/media/x',
    'https://[::ffff:127.0.0.1]/media/x',
    'https://algo.local/media/x',
    'https://kapso.internal/media/x',
  ];

  for (const url of internos) {
    it(`rechaza ${url}`, () => {
      expect(checkMediaUrl(url)).toMatchObject({ ok: false, reason: 'private_host' });
    });
  }

  it('una IP pública tampoco pasa: no es un host permitido', () => {
    expect(checkMediaUrl('https://8.8.8.8/media/x')).toMatchObject({
      ok: false,
      reason: 'host_not_allowed',
    });
  });

  it('isInternalHost es la regla, y no confunde un host normal', () => {
    expect(isInternalHost('app.kapso.ai')).toBe(false);
    expect(isInternalHost('127.0.0.1')).toBe(true);
    expect(isInternalHost('LOCALHOST')).toBe(true);
  });
});

describe('media-url-policy — hosts desconocidos', () => {
  it('un dominio cualquiera no se descarga', () => {
    expect(checkMediaUrl('https://evil.example.com/foto.jpg')).toEqual({
      ok: false,
      reason: 'host_not_allowed',
      hostname: 'evil.example.com',
    });
  });

  it('el sufijo NO basta: los parecidos se rechazan', () => {
    // Esto es lo que dejaría pasar un `endsWith`.
    for (const host of [
      'app.kapso.ai.evil.com',
      'evil-app.kapso.ai',
      'kapso.ai',
      'lookaside.fbsbx.com.evil.com',
      'notlookaside.fbsbx.com',
    ]) {
      expect(checkMediaUrl(`https://${host}/media/x`), host).toMatchObject({ ok: false });
    }
  });

  it('credenciales embebidas: confusión de parseadores, fuera', () => {
    expect(checkMediaUrl('https://app.kapso.ai:x@evil.example.com/f.jpg').ok).toBe(false);
    expect(checkMediaUrl('https://user:pass@app.kapso.ai/media/x')).toMatchObject({
      ok: false,
      reason: 'malformed',
    });
  });

  it('un puerto raro en un host permitido tampoco pasa', () => {
    expect(checkMediaUrl('https://app.kapso.ai:8443/media/x')).toMatchObject({
      ok: false,
      reason: 'malformed',
    });
  });
});

describe('media-url-policy — URLs malformadas', () => {
  for (const raw of ['', 'no-es-una-url', '://falta', 'https://', '   ', 'javascript:alert(1)']) {
    it(`rechaza ${JSON.stringify(raw)}`, () => {
      expect(checkMediaUrl(raw).ok).toBe(false);
    });
  }
});

describe('media-url-policy — la clave solo va a Kapso', () => {
  it('a app.kapso.ai sí; a Meta y a cualquier otro, no', () => {
    expect(shouldSendKapsoKey('app.kapso.ai')).toBe(true);
    expect(shouldSendKapsoKey('APP.KAPSO.AI')).toBe(true);
    expect(shouldSendKapsoKey('lookaside.fbsbx.com')).toBe(false);
    expect(shouldSendKapsoKey('evil-app.kapso.ai')).toBe(false);
  });
});
