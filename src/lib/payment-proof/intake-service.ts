import 'server-only';
import { log } from '@/lib/log';
import { getServerEnv } from '@/lib/env/env';
import { resolveProofFile } from '@/lib/kapso/media-resolver';
import type { ImageAttachment } from '@/lib/kapso/channel/image';
import { capturePaymentProof, type IntakeOutcome } from './capture';
import { decideAssociation } from './association';
import type { ProofAssociationMethod } from '@/types';
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

/**
 * ¿El enrutado dice que había un pedido esperando cobro?
 *
 * Los tres métodos que se admiten significan "hay pedidos vivos": uno señalado
 * por el cliente, uno solo por descarte, o varios sin poder elegir. `unresolved`
 * es el único que significa de verdad que NINGÚN pedido admite un pago ahora
 * —no hay ninguno, o el único que hay está vencido, cerrado o ya pagado—, y ahí
 * un archivo ilegible es ruido y no una alerta.
 */
function parecíaUnPago(method: ProofAssociationMethod): boolean {
  return method === 'single_open_qr_order' || method === 'ambiguous' || method === 'reply_to_qr';
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
  /**
   * Adjunto ya parseado por el canal, o `null` si llegó media que este canal
   * todavía no sabe leer (un audio, un vídeo, y hasta la fase 2 también un PDF).
   *
   * `null` NO significa "ignóralo": significa que hay un archivo del cliente que
   * no vamos a poder traernos. Se registra igual —ver `intakePaymentProof`— para
   * que el operador lo vea en el panel en vez de que desaparezca en silencio.
   */
  attachment: ImageAttachment | null;
  /**
   * Tipo declarado por el proveedor cuando no hay adjunto parseado. Es lo único
   * que se puede contar del archivo sin descargarlo, y sirve para que el panel
   * diga QUÉ llegó en vez de un "no disponible" mudo.
   */
  declaredMimeType?: string | null;
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

  try {
    const candidates = await source.candidatesForPhone(input.customerPhone);

    // ── Media que no sabemos leer: se registra, pero NO siempre ──────────────
    //
    // Un archivo que no podemos descargar solo merece una fila si de verdad
    // parecía un pago. Se pregunta al MISMO motor de enrutado que decide el
    // resto —no a una condición escrita aquí— y se sigue si había algún pedido
    // esperando cobro.
    //
    // Sin este filtro, cada audio de "¿ya salió mi pedido?" abriría un
    // comprobante fallido, y un panel lleno de ruido es un panel que se deja de
    // mirar: la alerta dejaría de significar nada justo cuando importa.
    //
    // ── Por qué AMBIGUOUS también se registra ────────────────────────────────
    //
    // La primera versión exigía `attemptEligible`, y eso dejaba fuera el caso
    // ambiguo con el argumento de que "no informa de nada". Es falso, y una
    // prueba real lo demostró en el primer intento: ambiguo significa que hay
    // VARIOS pedidos esperando cobro, no que no haya ninguno. El operador
    // desambigua mirando el monto; nosotros no podemos, pero él sí.
    //
    // Y el escenario no es raro: sale solo del flujo normal —se rechaza un pago,
    // el cliente pide otra vez, y quedan dos pedidos vivos a la vez—. Era
    // exactamente el caso en el que perder el archivo más duele.
    if (input.attachment === null) {
      const enrutado = decideAssociation({
        replyToOrderId: null,
        candidates,
        duplicateOfProofId: null,
        nowMs: input.receivedAtMs,
      });
      if (!parecíaUnPago(enrutado.method)) {
        return { result: 'failed', reason: 'unsupported_media_ignored' };
      }
    }

    return await capturePaymentProof(
      {
        sourceMessageId: input.sourceMessageId,
        declaredMimeType:
          input.attachment?.facts.mimeType ?? input.declaredMimeType ?? null,
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
          // Sin adjunto parseado no hay de dónde descargar. Devolver `null` no
          // es una excepción al flujo: es el mismo camino que sigue una descarga
          // que falla, así que el motor marca la fila `failed` y el panel la
          // muestra como archivo no disponible. Una sola semántica para
          // "llegó algo y no lo tenemos", en vez de dos.
          if (input.attachment === null) return null;

          // `resolveProofFile`, NO `resolveImage`: un comprobante puede ser un
          // PDF, y el resolutor del agente rechaza cualquier cosa que no sea
          // imagen porque lo que devuelve acaba en la entrada de Vision.
          // Comparten toda la política anti-SSRF; solo difieren en qué tipos
          // aceptan.
          const res = await resolveProofFile(input.attachment);
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
