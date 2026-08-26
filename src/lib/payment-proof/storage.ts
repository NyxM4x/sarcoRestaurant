import 'server-only';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import type { Readable } from 'node:stream';
import { getServerEnv } from '@/lib/env/env';
import { isValidProofStorageKey, PROOF_STORAGE_PROVIDER } from './storage-key';
import type { ProofMimeType } from './mime';

/**
 * Almacenamiento privado de comprobantes (Cloudflare R2) — server-only.
 *
 * ── Por qué no hay URLs firmadas ────────────────────────────────────────────
 *
 * Sería más sencillo generar una URL firmada y ponerla en el `src` de un `img`.
 * No se hace, y es deliberado: esa URL es una llave al comprobante de un cliente
 * que funciona para cualquiera que la tenga, sobrevive al cierre de sesión, y
 * queda escrita en el HTML, en el historial del navegador y en cualquier
 * captura de pantalla del panel.
 *
 * En su lugar, el navegador pide siempre a NUESTRO endpoint, que comprueba la
 * sesión en cada petición y hace de intermediario con el bucket. Las
 * credenciales, el bucket, el namespace y la key no salen nunca del servidor.
 *
 * ── Fail-closed ─────────────────────────────────────────────────────────────
 *
 * Sin las cuatro variables de R2, `isProofStorageConfigured()` devuelve false y
 * la captura de comprobantes queda apagada. Un bucket mal configurado no debe
 * traducirse en comprobantes guardados a medias ni en errores en el webhook.
 */

interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

function readConfig(): R2Config | null {
  let env;
  try {
    env = getServerEnv();
  } catch {
    return null;
  }
  const accountId = env.R2_ACCOUNT_ID ?? '';
  const accessKeyId = env.R2_ACCESS_KEY_ID ?? '';
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY ?? '';
  const bucket = env.R2_BUCKET ?? '';
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) return null;
  return { accountId, accessKeyId, secretAccessKey, bucket };
}

export function isProofStorageConfigured(): boolean {
  return readConfig() !== null;
}

let cached: { client: S3Client; bucket: string } | null = null;

function getClient(): { client: S3Client; bucket: string } | null {
  if (cached) return cached;
  const cfg = readConfig();
  if (!cfg) return null;
  const client = new S3Client({
    // R2 es compatible con S3 pero vive en su propio endpoint por cuenta.
    region: 'auto',
    endpoint: `https://${cfg.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
    },
  });
  cached = { client, bucket: cfg.bucket };
  return cached;
}

export type StorePutResult =
  | { ok: true; provider: string; bucket: string; key: string }
  | { ok: false; reason: 'not_configured' | 'upload_failed' };

/**
 * Sube el comprobante al bucket privado.
 *
 * El `Content-Type` que se guarda es el tipo REAL verificado sobre los bytes,
 * no el que declaró el proveedor: es el que después devuelve el endpoint, y
 * servir un tipo equivocado es cómo un archivo acaba interpretándose como algo
 * que no es.
 */
export async function putProofObject(
  key: string,
  body: Uint8Array,
  contentType: ProofMimeType,
): Promise<StorePutResult> {
  const conn = getClient();
  if (!conn) return { ok: false, reason: 'not_configured' };
  if (!isValidProofStorageKey(key)) return { ok: false, reason: 'upload_failed' };

  try {
    await conn.client.send(
      new PutObjectCommand({
        Bucket: conn.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        // El objeto es privado; el bucket no debe tener acceso público. Esto es
        // una segunda barrera, no la principal.
        CacheControl: 'private, max-age=0, no-store',
      }),
    );
    return { ok: true, provider: PROOF_STORAGE_PROVIDER, bucket: conn.bucket, key };
  } catch {
    // Error saneado: nunca se propaga el detalle del proveedor ni la key.
    return { ok: false, reason: 'upload_failed' };
  }
}

export type StoreGetResult =
  | { ok: true; body: Readable; contentType: string | null; contentLength: number | null }
  | { ok: false; reason: 'not_configured' | 'not_found' | 'read_failed' };

/**
 * Abre un stream de lectura del objeto privado.
 *
 * Devuelve el stream SIN consumirlo para que el endpoint pueda encadenarlo
 * hacia el navegador: un comprobante de 8 MB no tiene por qué pasar entero por
 * la memoria del servidor antes de empezar a viajar.
 */
export async function getProofObject(key: string): Promise<StoreGetResult> {
  const conn = getClient();
  if (!conn) return { ok: false, reason: 'not_configured' };
  if (!isValidProofStorageKey(key)) return { ok: false, reason: 'not_found' };

  try {
    const res = await conn.client.send(
      new GetObjectCommand({ Bucket: conn.bucket, Key: key }),
    );
    if (!res.Body) return { ok: false, reason: 'not_found' };
    return {
      ok: true,
      body: res.Body as Readable,
      contentType: res.ContentType ?? null,
      contentLength: typeof res.ContentLength === 'number' ? res.ContentLength : null,
    };
  } catch (error) {
    // `NoSuchKey` se distingue de un fallo real solo para elegir el código HTTP;
    // hacia el cliente ambos acaban siendo una respuesta genérica.
    const name = (error as { name?: string } | null)?.name ?? '';
    if (name === 'NoSuchKey' || name === 'NotFound') return { ok: false, reason: 'not_found' };
    return { ok: false, reason: 'read_failed' };
  }
}
