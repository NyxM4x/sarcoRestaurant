import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { proofAlertOf } from './proof-alert';
import type { PaymentView, ProofView } from '@/lib/dashboard/attempt-review';

function proof(id: string, analysis: ProofView['analysis'] = null): ProofView {
  return {
    id,
    receivedAt: '2026-08-27T20:05:00.000Z',
    associationLabel: null,
    exceptionLabel: null,
    isDuplicate: false,
    isImage: true,
    isAvailable: true,
    mimeType: 'image/jpeg',
    filename: `comprobante-${id}.jpg`,
    declaredLabel: null,
    analysis,
    amountLabel: null,
  };
}

const SOSPECHOSO: ProofView['analysis'] = {
  verdict: 'suspicious',
  headline: 'Revisar este comprobante',
  reasons: ['Pagó menos de lo que debía'],
};

const ILEGIBLE: ProofView['analysis'] = {
  verdict: 'unreadable',
  headline: 'No se pudo leer el comprobante',
  reasons: ['No se pudo leer el comprobante'],
};

function pago(proofs: ProofView[], over: Partial<PaymentView['attempts'][0]> = {}): PaymentView {
  return {
    attempts: [
      {
        id: 'a1',
        status: 'pending_review',
        statusLabel: 'Pendiente de revisión',
        tone: 'amber',
        openedAt: '2026-08-27T20:05:00.000Z',
        reviewedAt: null,
        proofCount: proofs.length,
        proofs,
        canDecide: true,
        ...over,
      },
    ],
    unlinkedProofs: [],
    hasPendingReview: true,
  };
}

describe('aviso del análisis en el ticket', () => {
  it('sin pago o sin análisis no dice nada', () => {
    expect(proofAlertOf(null)).toBeNull();
    expect(proofAlertOf(pago([proof('p1')]))).toBeNull();
  });

  it('un comprobante sospechoso saca el aviso rojo con sus motivos', () => {
    expect(proofAlertOf(pago([proof('p1', SOSPECHOSO)]))).toEqual({
      headline: 'Revisar este comprobante',
      reasons: ['Pagó menos de lo que debía'],
      tone: 'red',
    });
  });

  it('uno ilegible avisa en ámbar: no es lo mismo que uno que no cuadra', () => {
    // Acusar a una foto borrosa de lo mismo que a un monto cambiado gastaría la
    // única alerta que de verdad importa.
    expect(proofAlertOf(pago([proof('p1', ILEGIBLE)]))?.tone).toBe('amber');
  });

  it('con varios, gana el peor', () => {
    const alerta = proofAlertOf(pago([proof('p1', ILEGIBLE), proof('p2', SOSPECHOSO)]));
    expect(alerta?.tone).toBe('red');
    // Y solo se cuentan los motivos del que manda: mezclar "no se pudo leer" con
    // "pagó de menos" haría dudar de las dos cosas.
    expect(alerta?.reasons).toEqual(['Pagó menos de lo que debía']);
  });

  it('no repite un motivo que aparece en dos comprobantes', () => {
    const alerta = proofAlertOf(pago([proof('p1', SOSPECHOSO), proof('p2', SOSPECHOSO)]));
    expect(alerta?.reasons).toEqual(['Pagó menos de lo que debía']);
  });

  it('se retira en cuanto el pago está decidido', () => {
    // El aviso existe para ayudar a decidir. Decidido, ya cumplió: dejarlo
    // puesto convierte la tarjeta en un cartel rojo que no pide nada, y en
    // cocina eso enseña a ignorar los avisos.
    for (const status of ['accepted', 'rejected'] as const) {
      const decidido = pago([proof('p1', SOSPECHOSO)], {
        status,
        canDecide: false,
        reviewedAt: '2026-08-27T20:10:00.000Z',
      });
      expect(proofAlertOf(decidido), status).toBeNull();
    }
  });

  it('un comprobante sin asociar avisa igual, aunque no haya intento', () => {
    // Llegó algo que nadie ha podido enlazar y que además no cuadra: es
    // exactamente lo que no puede pasar desapercibido.
    const suelto: PaymentView = {
      attempts: [],
      unlinkedProofs: [proof('p9', SOSPECHOSO)],
      hasPendingReview: false,
    };
    expect(proofAlertOf(suelto)?.tone).toBe('red');
  });
});

describe('el aviso necesita que la CONSULTA traiga sus datos', () => {
  /**
   * El fallo del 29-08-2026, y la razón de que este test mire un string.
   *
   * El análisis detectó un comprobante falso —cuenta, titular y banco distintos—
   * y lo escribió en la base. `proofAlertOf` sabía pintarlo. Y en el ticket no
   * apareció nada, porque la consulta de cocina pedía `analysis_status` pero no
   * el veredicto ni los motivos: `toAnalysisView` encontraba el 'done', se
   * quedaba sin veredicto y devolvía null.
   *
   * Ninguna prueba de lógica podía cazarlo: la lógica estaba bien. Lo que
   * faltaba era el dato, y eso solo se ve mirando la lista de columnas contra
   * lo que la vista lee de verdad.
   */
  const fuente = readFileSync(new URL('./data-source.ts', import.meta.url), 'utf8');

  /**
   * Solo la LISTA de columnas, no el archivo.
   *
   * La primera versión de este test miraba el fuente entero y se disparaba con
   * la frase de un comentario que precisamente explica qué NO se pide. Un test
   * que confunde una explicación con el código que explica no protege nada.
   */
  const columnas = (() => {
    const m = fuente.match(/const KITCHEN_PROOF_COLUMNS\s*=([\s\S]*?);/);
    if (!m) throw new Error('no se encontró KITCHEN_PROOF_COLUMNS');
    // Fuera comillas, `+` de la concatenación y espacios: queda la lista limpia.
    return m[1]
      .replace(/['+\s]/g, '')
      .split(',')
      .filter((c) => c !== '');
  })();

  it('la consulta de cocina pide todas las columnas del análisis', () => {
    for (const columna of [
      'analysis_status',
      'analysis_verdict',
      'analysis_reasons',
      // 03-09-2026: faltaba, y por eso `cobroEnLaPuerta` mandaba COBRAR ENVÍO
      // en todos los deliveries. Ver el comentario de `KITCHEN_PROOF_COLUMNS`.
      'analysis_amount_label',
    ]) {
      expect(columnas, columna).toContain(columna);
    }
  });

  /**
   * La lista de cocina no puede quedarse atrás de la del panel — otra vez.
   *
   * Los dos tests de arriba enumeran a mano lo que hay que pedir, y esa lista
   * es justo la que nadie amplió las dos veces que esto falló: el campo se
   * añade al análisis, se añade al panel del encargado, y aquí no. Desde el
   * panel todo se ve bien, así que nada lo delata.
   *
   * Esto lo compara contra la fuente en vez de contra una lista escrita: si el
   * panel pide un campo del análisis, cocina lo pide también. No hay ninguna
   * razón para que quien decide desde la plancha vea menos que quien decide
   * desde la oficina — es la misma decisión.
   */
  it('cocina pide TODO lo que pide el panel del encargado', () => {
    const panel = readFileSync(
      new URL('../dashboard/proofs-data-source.ts', import.meta.url),
      'utf8',
    );
    const m = panel.match(/const PROOF_UI_COLUMNS\s*=([\s\S]*?);/);
    if (!m) throw new Error('no se encontró PROOF_UI_COLUMNS');
    const delPanel = m[1]
      .replace(/['+\s]/g, '')
      .split(',')
      .filter((c) => c.startsWith('analysis_'));

    expect(delPanel.length).toBeGreaterThan(0);
    for (const columna of delPanel) {
      expect(columnas, `el panel pide ${columna} y cocina no`).toContain(columna);
    }
  });

  it('y sigue sin pedir dónde vive el archivo', () => {
    // Lo que nunca debe salir hacia el navegador. Añadir columnas no puede
    // convertirse en añadirlas todas.
    expect(columnas).not.toContain('storage_key');
    expect(columnas).not.toContain('storage_namespace');
  });
});
