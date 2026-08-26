/**
 * Rutas del almacenamiento de comprobantes — módulo PURO.
 *
 * Separado del cliente de R2 a propósito: la forma de la key es una decisión de
 * negocio (particionar por mes para que listar un periodo no recorra el bucket
 * entero) y se puede probar sin credenciales ni red.
 *
 * La key NUNCA lleva datos del cliente: ni teléfono, ni nombre, ni el nombre
 * original del archivo. Solo el identificador interno del comprobante. Una key
 * filtrada no debe revelar de quién es el comprobante.
 */
import { extensionFor, type ProofMimeType } from './mime';

/** Namespace por defecto dentro del bucket. */
export const PROOF_NAMESPACE = 'payment-proofs';

/** Proveedor guardado en la base junto a la key. */
export const PROOF_STORAGE_PROVIDER = 'r2';

const pad2 = (n: number): string => String(n).padStart(2, '0');

/**
 * Construye `<namespace>/<yyyy>/<mm>/<proof_id>.<ext>`.
 *
 * El `proof_id` es un UUID generado por la base, así que la key es única sin
 * necesidad de comprobar colisiones: dos comprobantes distintos nunca comparten
 * destino, ni siquiera en el mismo milisegundo.
 */
export function buildProofStorageKey(
  proofId: string,
  mime: ProofMimeType,
  receivedAtMs: number,
  namespace: string = PROOF_NAMESPACE,
): string {
  const d = new Date(receivedAtMs);
  const yyyy = d.getUTCFullYear();
  const mm = pad2(d.getUTCMonth() + 1);
  return `${namespace}/${yyyy}/${mm}/${proofId}.${extensionFor(mime)}`;
}

/**
 * Valida que una key venida de la base tenga la forma esperada antes de pedirla
 * al bucket.
 *
 * Defensa en profundidad: la key sale de nuestra propia tabla, pero si alguna
 * vez un valor manipulado llegara ahí, esto impide que se convierta en un
 * recorrido de directorios o en una petición a otro prefijo del bucket.
 */
export function isValidProofStorageKey(key: string | null | undefined): boolean {
  if (!key || key.length > 200) return false;
  if (key.includes('..') || key.startsWith('/')) return false;
  return /^[a-z0-9-]+\/\d{4}\/\d{2}\/[a-f0-9-]{36}\.[a-z0-9]{2,5}$/.test(key);
}
