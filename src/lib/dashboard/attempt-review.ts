/**
 * Vista de los intentos de pago para el panel — modulo PURO.
 *
 * Convierte filas crudas en la estructura que pinta el operador, ya traducida a
 * lenguaje humano y SIN nada que el navegador no deba ver: aqui no entran
 * `storage_key`, ni `source_message_id`, ni el UUID del pedido.
 *
 * El historial se conserva ENTERO: un intento rechazado no desaparece porque
 * despues se acepte otro. Ambos son parte de lo que paso.
 */
import type { PaymentAttempt, PaymentReviewStatus } from '@/types';
import type { ProofUiRow } from './proofs-data-source';
import {
  associationMethodLabel,
  reviewStatusLabel,
  routingExceptionLabel,
  REVIEW_STATUS_TONES,
  type ReviewTone,
} from '@/lib/payment-proof/labels';
import { isImageMime } from '@/lib/payment-proof/mime';

/** Un archivo de comprobante tal como lo ve el panel. */
export interface ProofView {
  /** Id interno: SOLO sirve para pedir el archivo al endpoint autenticado. */
  id: string;
  receivedAt: string;
  /** Etiqueta humana del metodo de asociacion. `null` si no aplica. */
  associationLabel: string | null;
  /** Etiqueta humana de la excepcion de enrutamiento. `null` si no hubo. */
  exceptionLabel: string | null;
  isDuplicate: boolean;
  /** ¿Se puede pintar como miniatura? (lo decide el MIME REAL verificado) */
  isImage: boolean;
  /** ¿El archivo esta disponible para abrirse? */
  isAvailable: boolean;
  mimeType: string | null;
  filename: string | null;
  /**
   * Qué DIJO el proveedor que era, para los archivos que nunca llegaron a
   * descargarse. Sin esto, un comprobante fallido es un "no disponible" mudo y
   * el operador no puede distinguir un PDF que aún no sabemos leer de una imagen
   * cuya descarga se cayó — que son dos problemas distintos con dos respuestas
   * distintas.
   *
   * NUNCA se usa para decidir cómo se pinta el archivo ni qué se sirve: eso lo
   * decide `mimeType`, que sale de los bytes. Este es solo una afirmación de un
   * tercero, y aquí vale únicamente para contárselo a una persona.
   */
  declaredLabel: string | null;
}

/**
 * Nombre corto y humano del tipo declarado. `null` si no lo sabemos o si no
 * aporta nada.
 */
function declaredLabelOf(row: ProofUiRow): string | null {
  // Con el archivo disponible, la etiqueta sobra: ya se ve.
  if (row.capture_status === 'stored') return null;
  const declarado = row.declared_mime_type;
  if (!declarado) return null;
  if (declarado === 'application/pdf') return 'PDF';
  if (declarado.startsWith('image/')) return 'Imagen';
  if (declarado.startsWith('audio/')) return 'Audio';
  if (declarado.startsWith('video/')) return 'Video';
  return 'Archivo';
}

/** Un episodio de revision con todos sus comprobantes. */
export interface AttemptView {
  id: string;
  status: PaymentReviewStatus;
  statusLabel: string;
  tone: ReviewTone;
  openedAt: string;
  reviewedAt: string | null;
  proofCount: number;
  proofs: ProofView[];
  /** Solo un intento pendiente admite decision. */
  canDecide: boolean;
}

export interface PaymentView {
  attempts: AttemptView[];
  /** Comprobantes que no pertenecen a ningun intento (ambiguos, excepciones). */
  unlinkedProofs: ProofView[];
  /** ¿Hay algo esperando decision? Alimenta el indicador de la lista. */
  hasPendingReview: boolean;
}

function toProofView(row: ProofUiRow): ProofView {
  return {
    id: row.id,
    receivedAt: row.received_at,
    associationLabel: associationMethodLabel(row.association_method),
    exceptionLabel: routingExceptionLabel(row.routing_exception),
    isDuplicate: row.association_method === 'duplicate' || row.duplicate_of_id !== null,
    // El MIME REAL manda: un archivo renombrado no engana a la presentacion.
    isImage: isImageMime(row.verified_mime_type),
    isAvailable: row.capture_status === 'stored',
    mimeType: row.verified_mime_type,
    filename: row.safe_filename,
    declaredLabel: declaredLabelOf(row),
  };
}

/**
 * Arma la vista de pago de un pedido.
 *
 * Orden: el intento mas reciente primero, pero sin ocultar los anteriores.
 * Dentro de cada intento, los comprobantes en orden de llegada.
 */
export function toPaymentView(
  attempts: PaymentAttempt[],
  proofs: ProofUiRow[],
): PaymentView {
  const porIntento = new Map<string, ProofUiRow[]>();
  const sueltos: ProofUiRow[] = [];
  for (const p of proofs) {
    if (p.attempt_id === null) sueltos.push(p);
    else {
      const lista = porIntento.get(p.attempt_id);
      if (lista) lista.push(p);
      else porIntento.set(p.attempt_id, [p]);
    }
  }

  const ordenados = [...attempts].sort((a, b) => {
    const ta = Date.parse(a.opened_at);
    const tb = Date.parse(b.opened_at);
    return (Number.isNaN(tb) ? 0 : tb) - (Number.isNaN(ta) ? 0 : ta);
  });

  const vistas: AttemptView[] = ordenados.map((a) => {
    const suyos = (porIntento.get(a.id) ?? []).map(toProofView);
    return {
      id: a.id,
      status: a.review_status,
      statusLabel: reviewStatusLabel(a.review_status),
      tone: REVIEW_STATUS_TONES[a.review_status] ?? 'amber',
      openedAt: a.opened_at,
      reviewedAt: a.reviewed_at,
      proofCount: suyos.length,
      proofs: suyos,
      canDecide: a.review_status === 'pending_review',
    };
  });

  return {
    attempts: vistas,
    unlinkedProofs: sueltos.map(toProofView),
    hasPendingReview: vistas.some((v) => v.canDecide),
  };
}
