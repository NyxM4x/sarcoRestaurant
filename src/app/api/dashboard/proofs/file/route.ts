import { Readable } from 'node:stream';
import { hasValidSession } from '@/lib/dashboard/auth';
import { createSupabaseProofsDataSource } from '@/lib/dashboard/proofs-data-source';
import { getProofObject } from '@/lib/payment-proof/storage';
import { isProofMimeType } from '@/lib/payment-proof/mime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `GET /api/dashboard/proofs/file?id=<uuid>` — comprobante privado por streaming.
 *
 * Es el ÚNICO camino por el que un comprobante llega al navegador. No existe
 * URL pública ni firmada: cada petición vuelve a comprobar la sesión, así que
 * cerrar sesión corta el acceso de inmediato y una URL copiada no sirve a nadie.
 *
 * Orden deliberado: primero la sesión, después el identificador, y solo al
 * final se toca la base. Un visitante sin sesión no puede ni provocar consultas.
 *
 * Nada de la respuesta revela el bucket, el namespace, la key ni las
 * credenciales; ni siquiera en los mensajes de error.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Respuesta de error genérica: no distingue "no existe" de "no autorizado". */
function fail(status: number): Response {
  return new Response(null, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}

export async function GET(request: Request): Promise<Response> {
  // 1. Sesión primero: sin ella no se consulta nada.
  if (!(await hasValidSession())) return fail(401);

  // 2. Identificador validado antes de tocar la base.
  const id = new URL(request.url).searchParams.get('id') ?? '';
  if (!UUID_RE.test(id)) return fail(400);

  try {
    // 3. Localizar el comprobante en servidor.
    const ref = await createSupabaseProofsDataSource().getProofStorage(id);
    if (!ref) return fail(404);

    // 4. Abrir el stream privado del objeto.
    const obj = await getProofObject(ref.storageKey);
    if (!obj.ok) return fail(obj.reason === 'not_found' ? 404 : 502);

    // 5. El tipo REAL verificado manda. Si por lo que sea no es uno de los
    //    admitidos, se sirve como descarga opaca en vez de dejar que el
    //    navegador adivine (que es como un archivo acaba ejecutándose).
    const mime = isProofMimeType(ref.verifiedMimeType)
      ? ref.verifiedMimeType
      : 'application/octet-stream';

    const filename = ref.safeFilename ?? `comprobante-${id}`;

    return new Response(Readable.toWeb(obj.body) as ReadableStream, {
      status: 200,
      headers: {
        'Content-Type': mime,
        // `inline` para poder mostrarlo en el panel; el nombre es el saneado
        // por nosotros, nunca el que mandó el cliente.
        'Content-Disposition': `inline; filename="${filename}"`,
        // Privado y sin caché: un comprobante no debe quedarse en un proxy ni
        // sobrevivir al cierre de sesión en el disco del navegador.
        'Cache-Control': 'private, no-store, max-age=0',
        // El contenido es de un tercero: se prohíbe que el navegador reinterprete
        // el tipo, y se aísla de scripts por si alguna vez entrara un SVG.
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; img-src 'self'; object-src 'none'; sandbox",
        'Referrer-Policy': 'no-referrer',
        ...(obj.contentLength !== null ? { 'Content-Length': String(obj.contentLength) } : {}),
      },
    });
  } catch {
    // Error saneado: nunca SQL, stack, bucket ni key.
    return fail(500);
  }
}
