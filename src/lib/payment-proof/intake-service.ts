import 'server-only';
import { log } from '@/lib/log';
import { getServerEnv } from '@/lib/env/env';
import { resolveProofFile } from '@/lib/kapso/media-resolver';
import type { ImageAttachment } from '@/lib/kapso/channel/image';
import { capturePaymentProof, type IntakeOutcome } from './capture';
import { decideAssociation } from './association';
import { classifyForAgentGate, type ProofClassification } from './agent-gate';
import type { ProofAssociationMethod } from '@/types';
import {
  createSupabaseIntakeDataSource,
  newClaimToken,
  type IntakeDataSource,
} from './intake-data-source';
import { isProofStorageConfigured, putProofObject } from './storage';
import { analyzeCapturedProof } from './analysis-service';

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
 * Lo que la captura devuelve al canal.
 *
 * Además del desenlace de siempre, lleva el veredicto del motor determinístico
 * sobre si esto llegó COMO UN PAGO. Ese veredicto es lo que la puerta de
 * `agent-gate` usa para decidir si los bytes pueden viajar a OpenAI, y va aquí
 * —y no en una segunda consulta— porque se calcula con los MISMOS candidatos
 * que ya se leyeron para enrutar: preguntarlo dos veces sería arriesgarse a dos
 * respuestas distintas para el mismo archivo.
 *
 * Es INDEPENDIENTE del desenlace: un `already_captured` de un reintento sigue
 * clasificando como comprobante, que es justo lo que mantiene la puerta cerrada
 * cuando Kapso reentrega el mismo evento.
 */
export type ProofIntakeResult = IntakeOutcome & { proofClassification: ProofClassification };

/**
 * Captura un comprobante recibido por WhatsApp.
 *
 * Nunca lanza: un comprobante problemático no puede tumbar el webhook que
 * atiende a todos los clientes. Los fallos se registran y se devuelven como
 * resultado.
 */
/**
 * Deja constancia de un comprobante que no se pudo capturar. Nunca lanza.
 *
 * ── Por qué existe ──────────────────────────────────────────────────────────
 *
 * Tres desenlaces terminaban sin NINGUNA fila —`insert_failed`, `intake_error`
 * y `storage_not_configured`— y el evento del webhook se marcaba `processed`
 * igual, porque la captura no lanza por diseño. El resultado era el peor
 * posible: el cliente pagó, el archivo se perdió, y no quedaba rastro en
 * ninguna pantalla ni forma de saber que había existido.
 *
 * Esto no recupera el archivo: eso ya no se puede. Deja la fila para que el
 * pedido muestre "llegó un comprobante y no lo tenemos", que es lo que permite
 * a una persona pedirlo de nuevo en vez de descubrirlo al cuadrar la caja.
 *
 * ── Por qué no se reintenta el evento ───────────────────────────────────────
 *
 * Devolver el evento a la cola habría recuperado el archivo de verdad, pero
 * `askLocationForQuote` no tiene barrera de idempotencia: un mensaje con texto
 * Y foto reenviaría al cliente el "compárteme tu ubicación" en cada reintento.
 * Se prefiere una fila fiable a un archivo recuperado con efectos duplicados.
 */
async function dejarConstancia(
  source: Pick<IntakeDataSource, 'insertUncaptured'>,
  input: ProofIntakeInput,
  orderId: string | null,
): Promise<void> {
  try {
    const escrita = await source.insertUncaptured({
      sourceMessageId: input.sourceMessageId,
      orderId,
      declaredMimeType: input.attachment?.facts.mimeType ?? input.declaredMimeType ?? null,
      receivedAt: new Date(input.receivedAtMs).toISOString(),
    });
    if (!escrita) log.error('payment_proof_uncaptured_row_failed');
  } catch {
    // Si ni esto se puede escribir, la base no está disponible y no queda nada
    // que hacer desde aquí. Se registra y se sigue: el resto de la entrega —el
    // pedido, la ubicación, el agente— ya se atendió y no puede caerse por esto.
    log.error('payment_proof_uncaptured_row_error');
  }
}

export async function intakePaymentProof(input: ProofIntakeInput): Promise<ProofIntakeResult> {
  // Interruptor primero: apagada, ni se consulta la base.
  //
  // ── `unknown`, NUNCA `not_payment_proof` ─────────────────────────────────
  //
  // La primera versión devolvía aquí `not_payment_proof`, razonando que con la
  // captura apagada no hay flujo de comprobantes y por tanto no hay nada que
  // proteger. El razonamiento era falso y una auditoría lo demostró: los
  // comprobantes SIGUEN llegando por WhatsApp cuando el flag está apagado — lo
  // único que deja de pasar es que los guardemos. Autorizar Vision ahí mandaba
  // a OpenAI exactamente los archivos que el sistema había decidido no tocar.
  //
  // `PAYMENT_PROOF_CAPTURE_ENABLED` gobierna si CAPTURAMOS, no si es seguro
  // enseñar la imagen a un tercero. Sin motor no hay veredicto, y sin veredicto
  // no hay permiso: los adjuntos quedan retenidos y el turno responde por el
  // texto. Es una degradación segura y deliberada, documentada en
  // `docs/payment-proof-agent-gate.md`.
  if (!isProofCaptureEnabled()) {
    return { result: 'failed', reason: 'capture_disabled', proofClassification: 'unknown' };
  }

  const source = createSupabaseIntakeDataSource();

  // A qué pedido iba, si se llegó a saber. Vive FUERA del try porque el catch
  // también lo necesita: una fila de constancia sin `order_id` no aparece en
  // ninguna pantalla, y el pedido es lo único que la hace visible.
  let pedidoDestino: string | null = null;

  try {
    const candidates = await source.candidatesForPhone(input.customerPhone);

    // ── El enrutado, UNA sola vez ────────────────────────────────────────────
    //
    // Determinístico y sin tocar un solo byte del archivo: mira el estado de los
    // PEDIDOS de este teléfono, no la imagen. De aquí salen dos cosas —si un
    // archivo ilegible merece fila, y si los bytes pueden ir al modelo— y salen
    // de la MISMA decisión para que no puedan discrepar.
    //
    // `duplicateOfProofId` va en null porque el duplicado se descubre al
    // descargar. No afecta a la puerta: un reenvío del mismo comprobante enruta
    // igual que el original mientras el pedido siga vivo, y si ya no lo está lo
    // retiene la excepción de enrutado.
    const enrutado = decideAssociation({
      replyToOrderId: null,
      candidates,
      duplicateOfProofId: null,
      nowMs: input.receivedAtMs,
    });
    const proofClassification = classifyForAgentGate(enrutado);
    pedidoDestino = enrutado.orderId;

    // Sin bucket configurado no se captura: guardar una fila que jamás podrá
    // tener archivo solo genera ruido en el panel.
    //
    // Va DESPUÉS de clasificar, y no antes como hasta ahora, por una razón
    // concreta: con la captura ENCENDIDA y el bucket mal configurado, salir aquí
    // sin veredicto dejaba pasar el comprobante al modelo. El pago se pierde en
    // los dos casos —eso no lo arregla este orden— pero la imagen deja de
    // viajar. Cuesta una lectura de candidatos en un estado que ya está roto.
    if (!isProofStorageConfigured()) {
      // El pago se pierde igual —no hay dónde guardarlo— pero ahora deja fila:
      // el pedido enseña que llegó un comprobante que no tenemos, en vez de
      // parecer que el cliente nunca mandó nada.
      await dejarConstancia(source, input, enrutado.orderId);
      return { result: 'failed', reason: 'storage_not_configured', proofClassification };
    }

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
    //
    // Se pregunta por `parecíaUnPago` y NO por la clasificación de la puerta:
    // son dos preguntas distintas sobre el mismo enrutado. Aquella decide si
    // abrir una fila en el panel; esta, si unos bytes pueden salir hacia un
    // tercero. La segunda es a propósito más amplia, y confundirlas llenaría el
    // panel de ruido o dejaría escapar un comprobante.
    if (input.attachment === null) {
      if (!parecíaUnPago(enrutado.method)) {
        return {
          result: 'failed',
          reason: 'unsupported_media_ignored',
          proofClassification,
        };
      }
    }

    /**
     * Los bytes descargados, para el análisis posterior.
     *
     * Se guardan de paso en vez de volver a bajarlos del bucket: la descarga ya
     * se hizo, y repetirla añadiría una segunda ida a la red dentro del webhook
     * para conseguir exactamente los mismos bytes.
     */
    let descargados: Uint8Array | null = null;

    const outcome = await capturePaymentProof(
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
          descargados = bytesFromDataUrl(res.dataUrl);
          return descargados;
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

    // ── Análisis automático del comprobante (0025) ───────────────────────────
    //
    // Va DESPUÉS de la captura y solo si terminó: el comprobante ya está
    // guardado, asociado a su intento y visible en cocina antes de que esto
    // empiece. Se espera a propósito —nada de `void`— porque en modo asíncrono
    // esto corre dentro del `after()` de la ruta, y soltar la promesa dejaría el
    // análisis a merced de que la función serverless siga viva.
    //
    // `analyzeCapturedProof` no lanza nunca: lo peor que puede pasar es que este
    // comprobante se quede sin analizar, y sin análisis el flujo es exactamente
    // el de antes de que existiera — una persona lo abre y decide.
    //
    // ── Por qué esto NO lo gobierna la puerta del agente ─────────────────────
    //
    // `classifyForAgentGate` decide si los bytes entran en el TURNO del agente,
    // y su respuesta correcta para un comprobante es que no: allí la imagen
    // viajaría a OpenAI sin que nadie lo hubiera decidido y sin que el agente
    // tenga nada que hacer con ella.
    //
    // Este envío es el contrario en todo lo que importa: es deliberado, tiene un
    // destinatario concreto —leer la cuenta, el titular y el monto para detectar
    // un comprobante retocado—, tiene su propio interruptor
    // (`PAYMENT_PROOF_ANALYSIS_ENABLED`, apagado por defecto) y su propia cuenta
    // esperada configurada. Es la función que se pidió, no un efecto colateral.
    //
    // Aun así SON DOS CAMINOS distintos hacia el mismo tercero, y conviene que
    // se lea aquí: apagar la puerta del agente no apaga esto, y apagar esto no
    // abre aquella. Quien quiera que ninguna imagen de comprobante salga del
    // perímetro tiene que dejar `PAYMENT_PROOF_ANALYSIS_ENABLED` sin poner.
    if (outcome.result === 'captured' && descargados !== null) {
      await analyzeCapturedProof({
        proofId: outcome.proofId,
        orderId: outcome.orderId,
        bytes: descargados,
        receivedAtMs: input.receivedAtMs,
      });
    }

    // `insert_failed` es el único desenlace del motor que se va SIN fila: el
    // insert falló de verdad —no fue la carrera del WAMID, que ya se resuelve
    // arriba— así que no hay `proofId` al que volver. Los demás fallos
    // (`download_failed`, `storage_failed`) sí dejaron su fila y el panel ya
    // los enseña como archivo no disponible.
    if (outcome.result === 'failed' && outcome.reason === 'insert_failed') {
      await dejarConstancia(source, input, enrutado.orderId);
    }

    // El veredicto viaja con CUALQUIER desenlace del motor. `already_captured`,
    // `in_progress` y `lost_claim` son los caminos que recorren un reintento y
    // una carrera entre el `after()` y el worker de recovery: si perdieran la
    // clasificación, la puerta se abriría justo en el segundo intento.
    return { ...outcome, proofClassification };
  } catch (error) {
    // Solo el nombre del fallo: nunca bytes, URLs de media ni el teléfono.
    log.error('payment_proof_intake_failed', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
    // Constancia también aquí, y con la reserva de que este es el caso menos
    // recuperable de los tres: si la excepción vino de la propia base, escribir
    // la fila puede fallar igual. Se intenta porque una consulta puede caerse
    // sola —`candidatesForPhone` es la primera y la más pesada— y ahí el insert
    // sí entra.
    //
    // `pedidoDestino` será `null` si la excepción llegó antes de enrutar, y la
    // fila quedará huérfana: existe en la base y es auditable, pero no se ve en
    // el panel. Sigue siendo mejor que nada, y peor que las otras dos.
    await dejarConstancia(source, input, pedidoDestino);
    // FAIL CLOSED: si no se pudo decidir, los bytes no salen. Un fallo de la
    // base no puede convertirse en una imagen de más viajando a OpenAI.
    return { result: 'failed', reason: 'intake_error', proofClassification: 'unknown' };
  }
}
