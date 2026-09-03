import { describe, it, expect, vi } from 'vitest';
import { analyzeProofWith, PROOF_ANALYSIS_MAX_BYTES } from './analysis-service';
import type { AnalysisDataSource, AnalysisOutcome } from './analysis-data-source';
import type { AgentModel, AgentModelResult } from '@/lib/agent/core/model';
import type { ExpectedAccount } from './expected-account';

const CUENTA: ExpectedAccount = {
  bankNames: ['Banco Unión'],
  accountNumbers: ['1234567890'],
  holderNames: ['DON ZARCO'],
};

/** Cabecera JPEG real: `sniffMimeType` decide por los BYTES, no por el nombre. */
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
/** Cabecera PDF: llega al mismo sitio pero no entra en la visión. */
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);

const LECTURA = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    looksLikeReceipt: true,
    legible: true,
    bank: 'Banco Unión',
    destinationBank: 'Banco Unión',
    destinationAccount: '1234567890',
    destinationHolder: 'DON ZARCO',
    amount: 48,
    currency: 'BOB',
    transactionRef: 'TX-1',
    paidAtLocal: null,
    ...over,
  });

function modelo(res: AgentModelResult): AgentModel {
  return { model: 'fake', complete: async () => res };
}

function fuente(over: Partial<AnalysisDataSource> = {}) {
  const guardados: Array<{ proofId: string; outcome: AnalysisOutcome }> = [];
  const fallidos: string[] = [];
  const source: AnalysisDataSource = {
    // 48 la comida, 54 con envio: los dos importes del pedido de los fixtures.
    expectedAmounts: async () => ({ subtotal: 48, total: 54 }),
    isReferenceUsedElsewhere: async () => false,
    saveAnalysis: async (proofId, outcome) => {
      guardados.push({ proofId, outcome });
    },
    markAnalysisFailed: async (proofId) => {
      fallidos.push(proofId);
    },
    ...over,
  };
  return { source, guardados, fallidos };
}

const entrada = (bytes = JPEG) => ({
  proofId: 'proof-1',
  orderId: 'order-1',
  bytes,
  receivedAtMs: Date.parse('2026-08-28T00:30:00.000Z'),
});

describe('análisis — el recorrido completo', () => {
  it('lee, juzga y guarda el veredicto con lo leído', async () => {
    const { source, guardados } = fuente();
    await analyzeProofWith(entrada(), {
      model: modelo({ ok: true, text: LECTURA(), model: 'gpt-4o-mini' }),
      source,
      expected: CUENTA,
    });
    expect(guardados).toEqual([
      {
        proofId: 'proof-1',
        outcome: {
          verdict: 'ok',
          reasons: [],
          amount: 48,
          // 48 es el subtotal: pagó la comida y el envío se cobra al entregar.
          amountLabel: 'pago_productos',
          reference: 'TX-1',
          model: 'gpt-4o-mini',
          // Lo leído del destino se guarda aunque el veredicto sea `ok` (0034):
          // cuando cuadra sirve para comprobar que el filtro mira lo que debe, y
          // cuando no, es lo único con lo que se distingue un fallo de lectura
          // de un alias que falta.
          destinationAccount: '1234567890',
          destinationHolder: 'DON ZARCO',
          destinationBank: 'Banco Unión',
        },
      },
    ]);
  });

  it('el banco destino cambiado hace saltar la alerta', async () => {
    const { source, guardados } = fuente();
    await analyzeProofWith(entrada(), {
      model: modelo({
        ok: true,
        text: LECTURA({ destinationBank: 'Banco Mercantil Santa Cruz' }),
        model: 'gpt-4o-mini',
      }),
      source,
      expected: CUENTA,
    });
    expect(guardados[0].outcome.verdict).toBe('suspicious');
    expect(guardados[0].outcome.reasons).toEqual(['bank_mismatch']);
  });

  it('un monto que no es ninguno de los dos válidos acusa (0028)', async () => {
    // Antes de 0028 esto se guardaba con veredicto `ok`: el monto se leía y no
    // acusaba nunca. Un comprobante retocado de Bs 48 a Bs 7 pasaba el filtro.
    const { source, guardados } = fuente();
    await analyzeProofWith(entrada(), {
      model: modelo({ ok: true, text: LECTURA({ amount: 7 }), model: 'gpt-4o-mini' }),
      source,
      expected: CUENTA,
    });
    expect(guardados[0].outcome.verdict).toBe('suspicious');
    expect(guardados[0].outcome.reasons).toEqual(['amount_mismatch']);
    expect(guardados[0].outcome.amountLabel).toBe('revisar_monto');
    // La cifra leída se sigue guardando: la etiqueta no la reemplaza.
    expect(guardados[0].outcome.amount).toBe(7);
  });

  it('el pago completo —productos más envío— se etiqueta como tal', async () => {
    // El caso que motivó la etiqueta: el cliente pagó también la carrera, y el
    // repartidor no tenía forma de saberlo sin llamar a cocina.
    const { source, guardados } = fuente();
    await analyzeProofWith(entrada(), {
      model: modelo({ ok: true, text: LECTURA({ amount: 54 }), model: 'gpt-4o-mini' }),
      source,
      expected: CUENTA,
    });
    expect(guardados[0].outcome.verdict).toBe('ok');
    expect(guardados[0].outcome.reasons).toEqual([]);
    expect(guardados[0].outcome.amountLabel).toBe('pago_total');
  });

  it('sin pedido asociado no hay etiqueta: no había con qué comparar', async () => {
    const { source, guardados } = fuente();
    await analyzeProofWith(
      { ...entrada(), orderId: null },
      { model: modelo({ ok: true, text: LECTURA(), model: 'gpt-4o-mini' }), source, expected: CUENTA },
    );
    // `null` es ausencia de dato, y no se parece en nada a `pago_total`.
    expect(guardados[0].outcome.amountLabel).toBeNull();
    expect(guardados[0].outcome.reasons).toEqual([]);
  });

  it('un fallo leyendo los importes no acusa al cliente', async () => {
    // Si no podemos consultar el pedido, el problema es nuestro. Etiquetar
    // `revisar_monto` ahí convertiría una caída de la base en una sospecha.
    const { source, guardados } = fuente({ expectedAmounts: async () => null });
    await analyzeProofWith(entrada(), {
      model: modelo({ ok: true, text: LECTURA(), model: 'gpt-4o-mini' }),
      source,
      expected: CUENTA,
    });
    expect(guardados[0].outcome.amountLabel).toBeNull();
    expect(guardados[0].outcome.reasons).toEqual([]);
  });

  it('pregunta por el número de transacción repetido, y lo tiene en cuenta', async () => {
    const preguntas: string[] = [];
    const { source, guardados } = fuente({
      isReferenceUsedElsewhere: async (ref) => {
        preguntas.push(ref);
        return true;
      },
    });
    await analyzeProofWith(entrada(), {
      model: modelo({ ok: true, text: LECTURA(), model: 'gpt-4o-mini' }),
      source,
      expected: CUENTA,
    });
    expect(preguntas).toEqual(['TX-1']);
    expect(guardados[0].outcome.reasons).toEqual(['reference_reused']);
  });

  it('sin número de transacción leído, ni se pregunta', async () => {
    const espia = vi.fn(async () => true);
    const { source } = fuente({ isReferenceUsedElsewhere: espia });
    await analyzeProofWith(entrada(), {
      model: modelo({ ok: true, text: LECTURA({ transactionRef: null }), model: 'gpt' }),
      source,
      expected: CUENTA,
    });
    expect(espia).not.toHaveBeenCalled();
  });

  it('un comprobante sin pedido asociado se juzga igual', async () => {
    // Llegó algo que no se pudo enlazar: no tener pedido no es motivo para dejar
    // de mirar la cuenta, el titular y el banco.
    const { source, guardados } = fuente();
    await analyzeProofWith(
      { ...entrada(), orderId: null },
      { model: modelo({ ok: true, text: LECTURA(), model: 'gpt' }), source, expected: CUENTA },
    );
    expect(guardados[0].outcome.verdict).toBe('ok');
  });
});

describe('análisis — lo que NO hace', () => {
  it('un PDF no se analiza y no se marca como fallo', async () => {
    // La visión no lo lee. Se queda en `pending`, que significa "no analizado",
    // y no ha fallado nada que haya que contar como fallo.
    const { source, guardados, fallidos } = fuente();
    await analyzeProofWith(entrada(PDF), {
      model: modelo({ ok: true, text: LECTURA(), model: 'gpt' }),
      source,
      expected: CUENTA,
    });
    expect(guardados).toEqual([]);
    expect(fallidos).toEqual([]);
  });

  it('una imagen enorme se marca fallida en vez de mandarse entera', async () => {
    const gigante = new Uint8Array(PROOF_ANALYSIS_MAX_BYTES + 1);
    gigante.set(JPEG, 0);
    const espia = vi.fn(async () => ({ ok: true as const, text: LECTURA(), model: 'gpt' }));
    const { source, fallidos } = fuente();
    await analyzeProofWith(entrada(gigante), {
      model: { model: 'fake', complete: espia },
      source,
      expected: CUENTA,
    });
    expect(espia).not.toHaveBeenCalled();
    expect(fallidos).toEqual(['proof-1']);
  });

  it('si el modelo falla, se marca fallido y NO se inventa un veredicto', async () => {
    // `failed` significa "no se pudo leer", nunca "no cuadra". Confundirlos
    // convertiría cada caída de red en una acusación.
    const { source, guardados, fallidos } = fuente();
    await analyzeProofWith(entrada(), {
      model: modelo({ ok: false, error: 'timeout' }),
      source,
      expected: CUENTA,
    });
    expect(guardados).toEqual([]);
    expect(fallidos).toEqual(['proof-1']);
  });

  it('una respuesta que no se entiende tampoco produce veredicto', async () => {
    const { source, guardados, fallidos } = fuente();
    await analyzeProofWith(entrada(), {
      model: modelo({ ok: true, text: 'no puedo ayudarte', model: 'gpt' }),
      source,
      expected: CUENTA,
    });
    expect(guardados).toEqual([]);
    expect(fallidos).toEqual(['proof-1']);
  });
});
