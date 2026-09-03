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
import {
  amountLabelHint,
  amountLabelText,
  analysisReasonLabel,
  verdictHeadline,
} from '@/lib/payment-proof/labels';
import type { ProofAmountLabel, ProofVerdict } from '@/lib/payment-proof/analysis';

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
  /**
   * Lo que encontro el analisis automatico. `null` mientras no se haya
   * analizado —un PDF, el analisis apagado, una lectura fallida— y tambien
   * cuando el veredicto es `ok`: un comprobante que cuadra no merece un cartel,
   * y cada aviso que no dice nada le quita sitio a uno que si.
   */
  analysis: ProofAnalysisView | null;
  /**
   * Que pago: los productos solos o tambien el envio (0028).
   *
   * Va APARTE de `analysis` porque se muestra siempre, tambien cuando el
   * veredicto es `ok`. `analysis` solo aparece cuando hay algo que temer, y
   * "ya pago el envio" no es algo que temer — es justo lo que el repartidor
   * necesita saber cuando todo va bien.
   */
  amountLabel: ProofAmountLabelView | null;
}

/** La etiqueta del monto, ya traducida. La UI no ve codigos. */
export interface ProofAmountLabelView {
  code: ProofAmountLabel;
  /** Texto corto, en mayusculas: se lee de lejos. */
  text: string;
  /** Que hacer con esa informacion, en una linea. */
  hint: string;
}

/** Aviso del analisis, ya traducido: la UI no ve codigos. */
export interface ProofAnalysisView {
  verdict: Exclude<ProofVerdict, 'ok'>;
  /** Titulo corto del aviso. */
  headline: string;
  /** Motivos concretos, en el orden en que se detectaron. */
  reasons: string[];
  /**
   * A quien dice el comprobante que fue el dinero, tal como se leyo (0034).
   *
   * `null` salvo que la acusacion sea sobre el DESTINO —cuenta, titular o
   * banco— y se haya leido algo. Solo entonces aporta: junto a un aviso de
   * monto o de fecha seria ruido.
   *
   * Convierte una acusacion en un hecho comprobable. "La cuenta que recibe NO
   * es la nuestra" obliga a abrir la imagen para saber si es verdad; leer el
   * nombre que se leyo lo resuelve de un vistazo — y ensena cuando el
   * equivocado es el filtro y no el cliente.
   */
  destination: string | null;
}

/** Motivos que hablan del DESTINO del dinero, los unicos que piden ese dato. */
const MOTIVOS_DE_DESTINO = new Set(['account_mismatch', 'holder_mismatch', 'bank_mismatch']);

/**
 * Lo leido del destino, en una linea: `TITULAR · BANCO · CUENTA`.
 *
 * Se pinta lo que haya y en ese orden —el nombre es lo que un humano reconoce
 * de un vistazo, la cuenta lo que menos—. `null` si no se leyo nada: una linea
 * que dijera "fue a: —" solo ocuparia sitio.
 */
function destinoLeido(row: ProofUiRow): string | null {
  const partes = [
    row.analysis_destination_holder,
    row.analysis_destination_bank,
    row.analysis_destination_account,
  ].filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
  return partes.length === 0 ? null : partes.join(' · ');
}

/**
 * Traduce el analisis de la fila.
 *
 * Devuelve `null` salvo que haya algo que decir. La condicion es doble a
 * proposito: `analysis_status` tiene que ser `done` —un veredicto con el
 * analisis a medias seria una alerta sin procedencia— y el veredicto no puede
 * ser `ok`.
 */
function toAnalysisView(row: ProofUiRow): ProofAnalysisView | null {
  if (row.analysis_status !== 'done') return null;
  const verdict = row.analysis_verdict;
  if (verdict === null || verdict === 'ok') return null;
  const headline = verdictHeadline(verdict);
  if (headline === null) return null;
  const motivos = row.analysis_reasons ?? [];
  return {
    verdict,
    headline,
    reasons: motivos.map(analysisReasonLabel),
    destination: motivos.some((m) => MOTIVOS_DE_DESTINO.has(m)) ? destinoLeido(row) : null,
  };
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
    analysis: toAnalysisView(row),
    amountLabel: toAmountLabelView(row),
  };
}

/**
 * Traduce la etiqueta del monto.
 *
 * Exige `analysis_status === 'done'` por la misma razon que el aviso: una
 * etiqueta escrita a medio analisis afirmaria algo que nadie llego a comprobar.
 * `null` significa que no se pudo comparar, y se pinta como ausencia, nunca
 * como aprobado.
 */
function toAmountLabelView(row: ProofUiRow): ProofAmountLabelView | null {
  if (row.analysis_status !== 'done') return null;
  const code = row.analysis_amount_label;
  if (code === null) return null;
  const text = amountLabelText(code);
  const hint = amountLabelHint(code);
  if (text === null || hint === null) return null;
  return { code, text, hint };
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
