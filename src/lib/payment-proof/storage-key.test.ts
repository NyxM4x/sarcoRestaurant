import { describe, it, expect } from 'vitest';
import {
  PROOF_NAMESPACE,
  buildProofStorageKey,
  isValidProofStorageKey,
} from './storage-key';

const ID = '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b';

describe('key de almacenamiento', () => {
  it('particiona por ano y mes en UTC', () => {
    const enero = Date.parse('2026-01-09T23:30:00.000Z');
    expect(buildProofStorageKey(ID, 'image/jpeg', enero)).toBe(
      `${PROOF_NAMESPACE}/2026/01/${ID}.jpg`,
    );
    const diciembre = Date.parse('2026-12-31T23:59:59.000Z');
    expect(buildProofStorageKey(ID, 'application/pdf', diciembre)).toBe(
      `${PROOF_NAMESPACE}/2026/12/${ID}.pdf`,
    );
  });

  it('usa la extension del tipo REAL', () => {
    expect(buildProofStorageKey(ID, 'image/webp', Date.now()).endsWith('.webp')).toBe(true);
    expect(buildProofStorageKey(ID, 'image/png', Date.now()).endsWith('.png')).toBe(true);
  });

  it('la key NO lleva datos del cliente', () => {
    const key = buildProofStorageKey(ID, 'image/jpeg', Date.now());
    // Solo namespace, fecha, id y extension. Nada mas.
    expect(key.split('/')).toHaveLength(4);
    expect(key).not.toMatch(/[0-9]{8,}/); // ningun telefono
  });
});

describe('validacion de la key antes de tocar el bucket', () => {
  it('acepta la forma que producimos', () => {
    expect(isValidProofStorageKey(buildProofStorageKey(ID, 'image/jpeg', Date.now()))).toBe(true);
  });

  it('rechaza recorridos de directorio y rutas absolutas', () => {
    expect(isValidProofStorageKey(`${PROOF_NAMESPACE}/2026/../../secret.txt`)).toBe(false);
    expect(isValidProofStorageKey(`/${PROOF_NAMESPACE}/2026/01/${ID}.jpg`)).toBe(false);
    expect(isValidProofStorageKey('../../../etc/passwd')).toBe(false);
  });

  it('rechaza formas que no produjimos nosotros', () => {
    expect(isValidProofStorageKey('')).toBe(false);
    expect(isValidProofStorageKey(null)).toBe(false);
    expect(isValidProofStorageKey(undefined)).toBe(false);
    expect(isValidProofStorageKey('payment-proofs/2026/01/no-es-uuid.jpg')).toBe(false);
    expect(isValidProofStorageKey(`payment-proofs/26/1/${ID}.jpg`)).toBe(false);
    expect(isValidProofStorageKey(`payment-proofs/2026/01/${ID}`)).toBe(false);
  });

  it('rechaza keys absurdamente largas', () => {
    expect(isValidProofStorageKey('a'.repeat(300))).toBe(false);
  });
});
