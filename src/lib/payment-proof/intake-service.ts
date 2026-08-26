import 'server-only';
import { log } from '@/lib/log';
import { getServerEnv } from '@/lib/env/env';
import { createKapsoMediaResolver } from '@/lib/kapso/media-resolver';
import type { ImageAttachment } from '@/lib/kapso/channel/image';
import { capturePaymentProof, type IntakeOutcome } from './capture';
import { createSupabaseIntakeDataSource, newClaimToken } from './intake-data-source';
import { isProofStorageConfigured, putProofObject } from './storage';

/**
 * Entrada de comprobantes desde el canal — server-only.
 *
 * Es el adaptador que une el webhook con el motor canónico
 * `capturePaymentProof`. No decide nada por su cuenta: arma los puertos reales
 * y delega. Toda la semántica de idempotencia, duplicados, claim y CAS vive en
 * el motor, y no debe reimplementarse aquí.
 *
 * ── La descarga reutiliza el resolutor endurecido ───────────────────────────
 *
 * `createKapsoMediaResolver` ya trae la política anti-SSRF del proyecto: lista
 * blanca de hosts, redirects seguidos a mano y revalidados salto a salto, tope
 * de bytes y fail-closed. Escribir un segundo descargador para comprobantes
 * significaría mantener dos veces esa defensa, y olvidarla en una de las dos.
 *
 * Devuelve un data URL, así que se decodifica a bytes. Es un coste pequeño a
 * cambio de no duplicar la superficie de ataque.
 */

/**
 * ¿Esta encendida la captura de comprobantes?
 *
 * Solo la cadena exacta 'true'. Vive aqui —y no en los routes— para que las
 * tres vias compartan la MISMA respuesta: un interruptor que hay que recordar
 * consultar en tres sitios acaba consultandose en dos.
 */
export function isProofCaptureEnabled(): boolean {
  try {
    return getServerEnv().PAYMENT_PROOF_CAPTURE_ENABLED === 'true';
  } catch {
    // Sin entorno valido no se captura nada (fail-closed).
    return false;
  }
}

/** Convierte `data:<mime>;base64,<...>` en bytes. `null` si no es utilizable. */
function bytesFromDataUrl(dataUrl: string): Uint8Array | null {
  const coma = dataUrl.indexOf(',');
  if (coma < 0) return null;
  try {
    return new Uint8Array(Buffer.from(dataUrl.slice(coma + 1), 'base64'));
  } catch {
    return null;
  }
}

export interface ProofIntakeInput {
  /** WAMID del mensaje entrante. */
  sourceMessageId: string;
  /** Teléfono normalizado del cliente. */
  customerPhone: string;
  /** Adjunto ya parseado por el canal. */
  attachment: ImageAttachment;
  providerPhoneNumberId: string | null;
  receivedAtMs: number;
}

/**
 * Captura un comprobante recibido por WhatsApp.
 *
 * Nunca lanza: un comprobante problemático no puede tumbar el webhook que
 * atiende a todos los clientes. Los fallos se registran y se devuelven como
 * resultado.
 */
export async function intakePaymentProof(input: ProofIntakeInput): Promise<IntakeOutcome> {
  // Interruptor primero: apagada, ni se consulta la base.
  if (!isProofCaptureEnabled()) return { result: 'failed', reason: 'capture_disabled' };

  // Sin bucket configurado no se empieza siquiera: guardar una fila que jamás
  // podrá tener archivo solo genera ruido en el panel.
  if (!isProofStorageConfigured()) {
    return { result: 'failed', reason: 'storage_not_configured' };
  }

  const source = createSupabaseIntakeDataSource();
  const resolver = createKapsoMediaResolver();

  try {
    const candidates = await source.candidatesForPhone(input.customerPhone);

    return await capturePaymentProof(
      {
        sourceMessageId: input.sourceMessageId,
        declaredMimeType: input.attachment.facts.mimeType,
        receivedAtMs: input.receivedAtMs,
        association: {
          // El payload observado de Kapso NO trae contexto de respuesta, así
          // que no se puede afirmar a qué mensaje responde el cliente. Se deja
          // en null a propósito en vez de inventar el campo: `single_open_qr_order`
          // resuelve el caso común, y lo ambiguo queda marcado para una persona.
          replyToOrderId: null,
          candidates,
          nowMs: input.receivedAtMs,
        },
      },
      {
        findBySourceMessageId: (id) => source.findBySourceMessageId(id),
        insertClaimed: (row, token) => source.insertClaimed(row, token),
        reclaim: (id, token, stale) => source.reclaim(id, token, stale),
        findByContentHash: (sha, exclude) => source.findByContentHash(sha, exclude),
        updateContent: (id, update) => source.updateContent(id, update),
        markStored: (id, token, key, name, at) => source.markStored(id, token, key, name, at),
        markFailed: (id, token) => source.markFailed(id, token),
        attachToAttempt: (id, orderId) => source.attachToAttempt(id, orderId),
        newClaimToken,

        async downloadBytes() {
          const res = await resolver.resolveImage(input.attachment, input.providerPhoneNumberId);
          if (!res.ok) return null;
          return bytesFromDataUrl(res.dataUrl);
        },

        async hashBytes(bytes) {
          const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource);
          return Buffer.from(digest).toString('hex');
        },

        async storeObject(key, bytes, mime) {
          const res = await putProofObject(key, bytes, mime);
          return res.ok;
        },
      },
    );
  } catch (error) {
    // Solo el nombre del fallo: nunca bytes, URLs de media ni el teléfono.
    log.error('payment_proof_intake_failed', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
    return { result: 'failed', reason: 'intake_error' };
  }
}
