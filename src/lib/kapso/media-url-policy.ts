/**
 * POLÍTICA DE URL DE MEDIA — módulo puro (Fase 6D.2F.5C.5).
 *
 * El resolutor hace `fetch` desde el SERVIDOR a una URL que vino dentro de un
 * webhook. Eso es una petición server-side con destino elegido por quien mande
 * el payload, y sin política es exactamente la forma de un SSRF: basta una URL
 * apuntando a `http://127.0.0.1:3000/api/...` o a la IP de metadatos de la nube
 * para que nuestro propio backend haga la petición que el atacante no puede
 * hacer desde fuera.
 *
 * La firma del webhook reduce el riesgo, no lo elimina: sigue habiendo un
 * proveedor externo decidiendo a qué host llamamos, y un compromiso allí no
 * debería convertirse en peticiones internas aquí.
 *
 * ── Lista blanca, no lista negra ────────────────────────────────────────────
 *
 * Los hosts salen ÚNICAMENTE de los payloads reales capturados el 18-08-2026:
 * `app.kapso.ai` (Kapso) y `lookaside.fbsbx.com` (lookaside de Meta). No se
 * añade ninguno por analogía ni "por si acaso". Si mañana Kapso sirve desde otro
 * dominio, la descarga fallará como `unavailable` y el log dirá qué hostname
 * apareció — que es un fallo ruidoso y corregible, no un agujero silencioso.
 *
 * Coincidencia EXACTA, nunca por sufijo: `endsWith('kapso.ai')` aceptaría
 * `kapso.ai.evil.com`… y también `evil-app.kapso.ai` si alguien controlara un
 * subdominio. Comparar la cadena entera no tiene ese matiz.
 *
 * ── Límite conocido y NO resuelto: DNS rebinding ────────────────────────────
 *
 * Se valida el NOMBRE, no la IP a la que resuelve. Un host permitido que
 * apuntara a 127.0.0.1 pasaría este filtro. Cerrarlo exige resolver el DNS
 * nosotros, comprobar la IP y fijarla para la conexión (pinning), y eso pide un
 * agente HTTP propio. Se documenta en vez de insinuar que está cubierto.
 */

/** Hosts observados en payloads REALES. Ninguno más. */
export const ALLOWED_MEDIA_HOSTS: readonly string[] = ['app.kapso.ai', 'lookaside.fbsbx.com'];

/** Puertos admitidos: solo el de HTTPS. Vacío = 443 implícito. */
const ALLOWED_PORTS: readonly string[] = ['', '443'];

export type MediaUrlRejection =
  /** No es una URL, o trae credenciales embebidas, o el puerto no es 443. */
  | 'malformed'
  /** Protocolo distinto de `https:` — incluye `http:`, `file:` y `data:`. */
  | 'not_https'
  /** Loopback, IP privada, link-local o CGNAT. Nunca se sale a la red. */
  | 'private_host'
  /** URL válida y pública, pero el host no está en la lista blanca. */
  | 'host_not_allowed';

export type MediaUrlCheck =
  | { ok: true; hostname: string }
  | { ok: false; reason: MediaUrlRejection; hostname: string | null };

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** Nombres que siempre apuntan a nosotros mismos. */
const LOOPBACK_NAMES: readonly string[] = ['localhost', 'localhost.localdomain', 'ip6-localhost'];

/** ¿IPv4 literal de un rango que nunca sale a internet? */
function esIpv4Interna(host: string): boolean {
  const m = IPV4.exec(host);
  if (m === null) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a > 255 || b > 255) return false;
  if (a === 0 || a === 10 || a === 127) return true; // "este host", privada, loopback
  if (a === 172 && b >= 16 && b <= 31) return true; // privada
  if (a === 192 && b === 168) return true; // privada
  if (a === 169 && b === 254) return true; // link-local (incluye metadatos de nube)
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

/**
 * ¿IPv6 literal interna? `URL.hostname` las entrega entre corchetes: `[::1]`.
 *
 * Cubre loopback (`::1`), unique-local (`fc00::/7`), link-local (`fe80::/10`) y
 * las formas mapeadas de IPv4, que son la vía clásica para escribir 127.0.0.1
 * sin que parezca 127.0.0.1.
 */
function esIpv6Interna(host: string): boolean {
  if (!host.startsWith('[') || !host.endsWith(']')) return false;
  const dentro = host.slice(1, -1).toLowerCase();
  if (dentro === '::1' || dentro === '::') return true;
  if (/^f[cd][0-9a-f]{2}:/.test(dentro)) return true; // fc00::/7
  if (/^fe[89ab][0-9a-f]:/.test(dentro)) return true; // fe80::/10
  // IPv4 mapeada: la vía clásica para escribir 127.0.0.1 sin que lo parezca.
  //
  // `URL` NORMALIZA `[::ffff:127.0.0.1]` a `[::ffff:7f00:1]`, así que mirar solo
  // la forma con puntos habría dejado pasar exactamente el caso que se quería
  // cerrar. Se aceptan las dos escrituras y se juzga la IPv4 resultante.
  const conPuntos = /:((?:\d{1,3}\.){3}\d{1,3})$/.exec(dentro);
  if (conPuntos !== null) return esIpv4Interna(conPuntos[1]);

  const enHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(dentro);
  if (enHex !== null) {
    const alto = parseInt(enHex[1], 16);
    const bajo = parseInt(enHex[2], 16);
    return esIpv4Interna(
      `${alto >> 8}.${alto & 0xff}.${bajo >> 8}.${bajo & 0xff}`,
    );
  }
  return false;
}

/** ¿Este host apunta hacia dentro de nuestra red? */
export function isInternalHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (LOOPBACK_NAMES.includes(host)) return true;
  if (host.endsWith('.local') || host.endsWith('.internal')) return true;
  return esIpv4Interna(host) || esIpv6Interna(host);
}

/**
 * ¿Se puede descargar de aquí? FAIL CLOSED: solo pasa lo que cumple TODO.
 *
 * El orden de las comprobaciones importa para el diagnóstico, no para la
 * seguridad: `http://127.0.0.1` se rechaza igual por las dos razones, y se
 * reporta la primera porque es la más específica del error que alguien cometió.
 *
 * Devuelve el hostname para que la observabilidad pueda decir QUÉ host apareció
 * sin registrar jamás la URL —donde viven el token y la ruta.
 */
export function checkMediaUrl(raw: string): MediaUrlCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'malformed', hostname: null };
  }

  if (url.protocol !== 'https:') {
    // `file:` y `data:` no tienen hostname; se informa lo que haya.
    return { ok: false, reason: 'not_https', hostname: url.hostname || null };
  }
  // Credenciales embebidas (`https://user:pass@host/`) son una técnica de
  // confusión de parseadores, y ninguna URL legítima de media las lleva.
  if (url.username !== '' || url.password !== '') {
    return { ok: false, reason: 'malformed', hostname: url.hostname };
  }
  if (!ALLOWED_PORTS.includes(url.port)) {
    return { ok: false, reason: 'malformed', hostname: url.hostname };
  }

  const hostname = url.hostname.toLowerCase();
  if (isInternalHost(hostname)) return { ok: false, reason: 'private_host', hostname };
  if (!ALLOWED_MEDIA_HOSTS.includes(hostname)) {
    return { ok: false, reason: 'host_not_allowed', hostname };
  }

  return { ok: true, hostname };
}

/**
 * ¿A este host se le manda nuestra API key?
 *
 * Solo a Kapso, y por coincidencia exacta. Se pregunta POR SALTO —no una vez al
 * principio— porque un redirect de `app.kapso.ai` a `lookaside.fbsbx.com` es
 * perfectamente legítimo, y arrastrar la cabecera hasta allí sería entregarle
 * nuestra credencial a Meta.
 *
 * NOTA sobre lo que aún no está demostrado: que `kapso.media_url` EXIJA la clave
 * es una hipótesis razonable —es un endpoint del panel de Kapso— pero no está
 * confirmada ni por documentación verificada ni por una descarga real. Mandarla
 * a su propio host no tiene coste si sobra; la primera prueba en Production dirá
 * qué referencia funciona de verdad.
 */
export function shouldSendKapsoKey(hostname: string): boolean {
  return hostname.toLowerCase() === 'app.kapso.ai';
}
