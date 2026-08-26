/**
 * Motor canónico de captura de comprobantes — módulo PURO con puertos INYECTADOS.
 *
 * Es el ÚNICO camino por el que un comprobante entra al sistema. Las vías del
 * webhook (inline, asíncrona y worker) terminan todas aquí; no debe existir una
 * segunda implementación del enrutado, la subida ni el cierre.
 *
 * ── El claim es lo que impide perder un comprobante ─────────────────────────
 *
 * La fila nace RECLAMADA (`capturing`) por un token, y solo se cierra con un CAS
 * sobre ese mismo token. Eso distingue tres situaciones que de otro modo se
 * confunden:
 *
 *   * ya almacenado          → `already_captured`, no se repite trabajo;
 *   * reclamado y FRESCO     → `in_progress`, otro worker está en ello;
 *   * reclamado y VENCIDO    → aquel worker murió: se re-reclama y se reintenta.
 *
 * Sin el tercer caso, un proceso que muriera entre insertar y subir dejaría la
 * fila bloqueada para siempre y el comprobante del cliente se perdería en
 * silencio, que es la peor forma de perderlo.
 *
 * ── El orden: enrutar y reclamar ANTES de descargar ─────────────────────────
 *
 * Se decide a qué pedido va y se reclama la fila antes de gastar red. Así dos
 * entregas del mismo mensaje no descargan ocho megas cada una para que luego
 * una tire su trabajo.
 *
 * ── El duplicado NO es un resultado ─────────────────────────────────────────
 *
 * Un archivo idéntico llegado en un mensaje nuevo es un hecho nuevo: se captura
 * con normalidad (`result: 'captured'`), pero su `matchMethod` pasa a
 * `duplicate` y guarda a quién duplica. Como el hash exige haber descargado, esa
 * marca se aplica DESPUÉS del enrutado, sobre la decisión ya tomada.
 */
import { validateProofBytes, safeFilenameFor, type ProofMimeType } from './mime';
import { buildProofStorageKey, PROOF_NAMESPACE, PROOF_STORAGE_PROVIDER } from './storage-key';
import {
  decideAssociation,
  overrideAsDuplicate,
  type AssociationDecision,
  type AssociationInput,
} from './association';
import type { ProofAssociationMethod } from '@/types';

/** Cuánto vale un claim antes de considerarse abandonado. */
export const PROOF_CLAIM_LEASE_MS = 90_000;

export type IntakeOutcome =
  /** Capturado de principio a fin. Solo se emite tras ganar el CAS de cierre. */
  | {
      result: 'captured';
      proofId: string;
      matchMethod: ProofAssociationMethod;
      duplicateOfProofId: string | null;
      attemptId: string | null;
    }
  /** Ya estaba almacenado: no se repite descarga, subida ni intento. */
  | { result: 'already_captured'; proofId: string }
  /** Otro worker lo tiene reclamado ahora mismo. No es una captura nueva. */
  | { result: 'in_progress'; proofId: string }
  /** El claim se perdió por el camino: otro terminó primero. */
  | { result: 'lost_claim'; proofId: string }
  /** No se pudo completar. `proofId` existe si llegó a haber fila. */
  | { result: 'failed'; reason: string; proofId?: string };

/** Estado de una fila ya existente para este WAMID. */
export interface ExistingProof {
  proofId: string;
  captureStatus: 'pending' | 'capturing' | 'stored' | 'failed';
  /** Instante del claim en ms; `null` si no hay claim. */
  claimedAtMs: number | null;
}

/** Fila que se inserta ya reclamada, antes de descargar nada. */
export interface ProofInsert {
  sourceMessageId: string;
  orderId: string | null;
  associationMethod: ProofAssociationMethod;
  routingException: AssociationDecision['routingException'];
  declaredMimeType: string | null;
  receivedAt: string;
}

/** Lo que se sabe del archivo solo después de descargarlo. */
export interface ProofContentUpdate {
  verifiedMimeType: ProofMimeType;
  contentSha256: string;
  associationMethod: ProofAssociationMethod;
  duplicateOfId: string | null;
}

export interface CapturePorts {
  /** Fila existente para este WAMID, con su estado de claim. */
  findBySourceMessageId(sourceMessageId: string): Promise<ExistingProof | null>;
  /** Inserta la fila YA reclamada. Debe fallar si el WAMID ya existe. */
  insertClaimed(row: ProofInsert, claimToken: string): Promise<string>;
  /** Re-reclama una fila abandonada. `false` si otro se adelantó. */
  reclaim(proofId: string, claimToken: string, staleBeforeMs: number): Promise<boolean>;
  /** Descarga los bytes del adjunto. `null` si no se pudo. */
  downloadBytes(): Promise<Uint8Array | null>;
  hashBytes(bytes: Uint8Array): Promise<string>;
  /** Comprobante anterior con el mismo contenido, si existe. */
  findByContentHash(sha256: string, excludeProofId: string): Promise<string | null>;
  /** Guarda lo aprendido tras descargar (tipo real, hash, duplicado). */
  updateContent(proofId: string, update: ProofContentUpdate): Promise<void>;
  storeObject(key: string, bytes: Uint8Array, mime: ProofMimeType): Promise<boolean>;
  /** CAS de cierre: solo gana quien todavía sostiene el claim. */
  markStored(
    proofId: string,
    claimToken: string,
    key: string,
    filename: string,
    storedAtIso: string,
  ): Promise<boolean>;
  markFailed(proofId: string, claimToken: string): Promise<void>;
  /** Abre o reutiliza el episodio de revisión del pedido. */
  attachToAttempt(proofId: string, orderId: string): Promise<string | null>;
  /** Token nuevo para este intento de captura. */
  newClaimToken(): string;
}

export interface CaptureInput {
  sourceMessageId: string;
  declaredMimeType: string | null;
  /** Contexto de enrutado. El duplicado NO entra aquí: se descubre al descargar. */
  association: Omit<AssociationInput, 'duplicateOfProofId'>;
  receivedAtMs: number;
  leaseMs?: number;
}

/**
 * Captura un comprobante entrante.
 *
 * Nunca lanza: cualquier fallo sale como `IntakeOutcome`, porque un comprobante
 * problemático no puede tumbar el webhook que atiende a todos los clientes.
 */
export async function capturePaymentProof(
  input: CaptureInput,
  ports: CapturePorts,
): Promise<IntakeOutcome> {
  const lease = input.leaseMs ?? PROOF_CLAIM_LEASE_MS;
  const staleBeforeMs = input.receivedAtMs - lease;
  const claimToken = ports.newClaimToken();

  // ── 1. ¿Ya conocemos este mensaje? ────────────────────────────────────────
  const existente = await ports.findBySourceMessageId(input.sourceMessageId);
  let proofId: string;

  if (existente) {
    if (existente.captureStatus === 'stored') {
      return { result: 'already_captured', proofId: existente.proofId };
    }
    // Reclamado y todavía vigente: hay alguien trabajando en ello.
    if (
      existente.captureStatus === 'capturing' &&
      existente.claimedAtMs !== null &&
      existente.claimedAtMs > staleBeforeMs
    ) {
      return { result: 'in_progress', proofId: existente.proofId };
    }
    // Abandonado o fallido: se reintenta, que es justo lo que evita perderlo.
    const reclamado = await ports.reclaim(existente.proofId, claimToken, staleBeforeMs);
    if (!reclamado) return { result: 'in_progress', proofId: existente.proofId };
    proofId = existente.proofId;
  } else {
    // ── 2. Enrutar y reclamar, ANTES de gastar red ──────────────────────────
    const enrutado = decideAssociation({ ...input.association, duplicateOfProofId: null });
    try {
      proofId = await ports.insertClaimed(
        {
          sourceMessageId: input.sourceMessageId,
          orderId: enrutado.orderId,
          associationMethod: enrutado.method,
          routingException: enrutado.routingException,
          declaredMimeType: input.declaredMimeType,
          receivedAt: new Date(input.receivedAtMs).toISOString(),
        },
        claimToken,
      );
    } catch {
      // Carrera perdida contra el índice único del WAMID: otro worker acaba de
      // insertarlo. No es un error: es que ya está en manos de alguien.
      const ganador = await ports.findBySourceMessageId(input.sourceMessageId);
      if (ganador) {
        return ganador.captureStatus === 'stored'
          ? { result: 'already_captured', proofId: ganador.proofId }
          : { result: 'in_progress', proofId: ganador.proofId };
      }
      return { result: 'failed', reason: 'insert_failed' };
    }
  }

  // ── 3. Descarga y validación por CONTENIDO real ───────────────────────────
  const bytes = await ports.downloadBytes();
  if (!bytes) {
    await ports.markFailed(proofId, claimToken);
    return { result: 'failed', reason: 'download_failed', proofId };
  }

  const validacion = validateProofBytes(bytes, input.declaredMimeType);
  if (!validacion.ok) {
    await ports.markFailed(proofId, claimToken);
    return { result: 'failed', reason: validacion.reason, proofId };
  }

  // ── 4. Hash: ¿es el mismo archivo que ya llegó antes? ─────────────────────
  const sha256 = await ports.hashBytes(bytes);
  const duplicateOfProofId = await ports.findByContentHash(sha256, proofId);

  // El enrutado ya decidió el pedido; el duplicado solo cambia el método y
  // corta la apertura de intento. Sigue siendo una captura normal.
  let decision = decideAssociation({ ...input.association, duplicateOfProofId: null });
  if (duplicateOfProofId) decision = overrideAsDuplicate(decision, duplicateOfProofId);

  await ports.updateContent(proofId, {
    verifiedMimeType: validacion.mimeType,
    contentSha256: sha256,
    associationMethod: decision.method,
    duplicateOfId: decision.duplicateOfProofId,
  });

  // ── 5. Subida al bucket privado ───────────────────────────────────────────
  const key = buildProofStorageKey(proofId, validacion.mimeType, input.receivedAtMs, PROOF_NAMESPACE);
  const subido = await ports.storeObject(key, bytes, validacion.mimeType);
  if (!subido) {
    await ports.markFailed(proofId, claimToken);
    return { result: 'failed', reason: 'storage_failed', proofId };
  }

  // ── 6. CAS de cierre: la captura solo está completa si GANAMOS ────────────
  const cerrado = await ports.markStored(
    proofId,
    claimToken,
    key,
    safeFilenameFor(proofId, validacion.mimeType),
    new Date(input.receivedAtMs).toISOString(),
  );
  if (!cerrado) return { result: 'lost_claim', proofId };

  // ── 7. Solo ahora se abre el episodio de revisión ─────────────────────────
  let attemptId: string | null = null;
  if (decision.attemptEligible && decision.orderId) {
    attemptId = await ports.attachToAttempt(proofId, decision.orderId);
  }

  return {
    result: 'captured',
    proofId,
    matchMethod: decision.method,
    duplicateOfProofId: decision.duplicateOfProofId,
    attemptId,
  };
}

export { PROOF_STORAGE_PROVIDER };
