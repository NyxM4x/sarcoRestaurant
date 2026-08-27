import { describe, it, expect } from 'vitest';
import {
  ALLOWED_MEDIA_HOSTS,
  checkMediaUrl,
  isInternalHost,
  shouldSendKapsoKey,
} from './media-url-policy';
import {
  KAPSO_MEDIA_URL,
  KAPSO_R2_REDIRECT_URL,
  META_LOOKASIDE_URL,
} from './channel/image.fixtures';

/** El host de R2 tal cual aparece en el `Location`, para no reescribirlo en cada test. */
const R2_HOST = 'kapso-ai-prod.d77f1e59818b5ed2ec009d1a9116b255.r2.cloudflarestorage.com';

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

  it('el bucket de R2 al que redirige Kapso: es quien entrega los bytes', () => {
    // Sin esta entrada la descarga moría en el salto 1 y todo comprobante
    // quedaba `failed` con el archivo inalcanzable. Es el caso REAL, no un
    // añadido preventivo.
    expect(checkMediaUrl(KAPSO_R2_REDIRECT_URL)).toEqual({ ok: true, hostname: R2_HOST });
  });

  it('la lista blanca tiene exactamente los tres hosts observados', () => {
    // Si alguien añade uno, que sea una decisión visible en un diff, no un
    // efecto colateral de tocar otra cosa.
    expect([...ALLOWED_MEDIA_HOSTS]).toEqual([
      'app.kapso.ai',
      'lookaside.fbsbx.com',
      R2_HOST,
    ]);
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

  it('R2 NO queda abierto: solo el bucket de Kapso, nunca el servicio', () => {
    // Admitir `.r2.cloudflarestorage.com` por sufijo convertiría el bucket de
    // cualquiera con una cuenta de Cloudflare en un destino de descarga
    // server-side. Cada uno de estos comparte sufijo con el permitido y aun así
    // tiene que rebotar.
    for (const host of [
      'evil.r2.cloudflarestorage.com',
      'r2.cloudflarestorage.com',
      'cloudflarestorage.com',
      // La cuenta de OTRO (mismo bucket, hexadecimal distinto).
      'kapso-ai-prod.00000000000000000000000000000000.r2.cloudflarestorage.com',
      // Nuestro host entero, colgado de un dominio ajeno: el caso `endsWith` al revés.
      `${R2_HOST}.evil.com`,
    ]) {
      expect(checkMediaUrl(`https://${host}/objeto`), host).toEqual({
        ok: false,
        reason: 'host_not_allowed',
        hostname: host,
      });
    }
  });

  it('un solo carácter distinto en el host de R2 y se acabó', () => {
    // La cadena tiene 71 caracteres, 32 de ellos un hexadecimal que nadie va a
    // revisar a ojo. Es exactamente donde un typo pasa desapercibido, así que se
    // muta cada tramo por separado.
    const mutaciones = [
      // hexadecimal: un dígito cambiado
      R2_HOST.replace('d77f', 'd77e'),
      // bucket: una letra cambiada
      R2_HOST.replace('kapso-ai-prod', 'kapso-ai-prod2'),
      // un carácter de más
      `${R2_HOST}x`,
      // un carácter de menos
      R2_HOST.slice(0, -1),
      // guion por punto: cambia la frontera del dominio sin cambiar la longitud
      R2_HOST.replace('kapso-ai-prod.', 'kapso-ai-prod-'),
    ];
    for (const host of mutaciones) {
      expect(host, 'la mutación debe diferir del real').not.toBe(R2_HOST);
      expect(checkMediaUrl(`https://${host}/objeto`), host).toMatchObject({
        ok: false,
        reason: 'host_not_allowed',
      });
    }
  });

  it('el host de R2 no se salta las demás reglas por estar permitido', () => {
    // Estar en la lista blanca abre UNA puerta, no todas: el resto de la
    // política sigue aplicándose igual que a `app.kapso.ai`.
    expect(checkMediaUrl(`http://${R2_HOST}/objeto`)).toEqual({
      ok: false,
      reason: 'not_https',
      hostname: R2_HOST,
    });
    expect(checkMediaUrl(`https://user:pass@${R2_HOST}/objeto`)).toMatchObject({
      ok: false,
      reason: 'malformed',
    });
    expect(checkMediaUrl(`https://${R2_HOST}:8443/objeto`)).toMatchObject({
      ok: false,
      reason: 'malformed',
    });
    // El truco de las credenciales: el host REAL es el de después de la arroba.
    expect(checkMediaUrl(`https://${R2_HOST}:x@evil.example.com/objeto`)).toMatchObject({
      ok: false,
    });
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

  it('al bucket de R2 tampoco, aunque sea el propio de Kapso', () => {
    // Es un host de Cloudflare, no de Kapso, y la URL ya viene firmada: la
    // cabecera sobraría y podría invalidar la firma. Que esté en la lista blanca
    // no lo convierte en destinatario de nuestra credencial.
    expect(shouldSendKapsoKey(R2_HOST)).toBe(false);
  });
});
