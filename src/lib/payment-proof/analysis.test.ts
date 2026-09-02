import { describe, it, expect } from 'vitest';
import { judgeProof, parseBolivianLocalTime, type ProofFacts } from './analysis';
import type { ExpectedAccount } from './expected-account';

const CUENTA: ExpectedAccount = {
  bankNames: ['Banco Unión', 'BUN'],
  accountNumbers: ['1234567890'],
  holderNames: ['DON ZARCO', 'DON ZARCO SRL'],
};

/** Llegó a las 20:30 hora de Bolivia. */
const LLEGADA = Date.parse('2026-08-28T00:30:00.000Z');

/** Un comprobante bueno: la cuenta, el titular y el monto del pedido. */
function bueno(over: Partial<ProofFacts> = {}): ProofFacts {
  return {
    looksLikeReceipt: true,
    legible: true,
    bank: 'Banco Unión',
    destinationBank: 'Banco Unión',
    destinationAccount: '1234567890',
    destinationHolder: 'DON ZARCO SRL',
    amount: 48,
    currency: 'BOB',
    transactionRef: '987654321',
    paidAtLocal: '2026-08-27T20:28',
    ...over,
  };
}

const ctx = (over: Partial<Parameters<typeof judgeProof>[1]> = {}) => ({
  expected: CUENTA,
  receivedAtMs: LLEGADA,
  referenceReused: false,
  ...over,
});

describe('veredicto — el comprobante que cuadra', () => {
  it('cuenta, titular y monto correctos: `ok` y sin motivos', () => {
    const j = judgeProof(bueno(), ctx());
    expect(j.verdict).toBe('ok');
    expect(j.reasons).toEqual([]);
    expect(j.checks).toEqual({ account: 'match', holder: 'match', bank: 'match' });
  });

  it('la cuenta enmascarada del banco también cuadra', () => {
    const j = judgeProof(bueno({ destinationAccount: '****7890' }), ctx());
    expect(j.verdict).toBe('ok');
  });
});

describe('veredicto — lo que delata un retoque', () => {
  it('la cuenta destino cambiada', () => {
    const j = judgeProof(bueno({ destinationAccount: '9999999999' }), ctx());
    expect(j.verdict).toBe('suspicious');
    expect(j.reasons).toContain('account_mismatch');
  });

  it('el titular cambiado', () => {
    const j = judgeProof(bueno({ destinationHolder: 'MARIA LOPEZ' }), ctx());
    expect(j.verdict).toBe('suspicious');
    expect(j.reasons).toContain('holder_mismatch');
  });

  it('el banco destino cambiado', () => {
    const j = judgeProof(bueno({ destinationBank: 'Banco Mercantil Santa Cruz' }), ctx());
    expect(j.verdict).toBe('suspicious');
    expect(j.reasons).toContain('bank_mismatch');
  });

  it('la sigla configurada como alias es el mismo banco', () => {
    expect(judgeProof(bueno({ destinationBank: 'BUN' }), ctx()).reasons).toEqual([]);
  });

  it('la palabra `banco` sola no acusa a nadie', () => {
    // La llevan todos. Acusar con eso sería acusar por lo único que no distingue.
    const j = judgeProof(bueno({ destinationBank: 'Banco' }), ctx());
    expect(j.checks.bank).toBe('unknown');
    expect(j.reasons).toEqual([]);
  });

  it('el número de transacción ya usado en otro pedido', () => {
    // El hash reconoce el MISMO archivo; esto reconoce el mismo PAGO en una
    // captura nueva, que es el reenvío que de verdad se intenta.
    const j = judgeProof(bueno(), ctx({ referenceReused: true }));
    expect(j.verdict).toBe('suspicious');
    expect(j.reasons).toEqual(['reference_reused']);
  });

  it('el comprobante es de anteayer', () => {
    const j = judgeProof(bueno({ paidAtLocal: '2026-08-25T13:00' }), ctx());
    expect(j.verdict).toBe('suspicious');
    expect(j.reasons).toEqual(['stale_receipt']);
  });

  it('acumula TODOS los motivos: la pantalla dice qué mirar, no solo que mire', () => {
    const j = judgeProof(
      bueno({
        destinationAccount: '9999999999',
        destinationHolder: 'MARIA LOPEZ',
        destinationBank: 'Banco Mercantil',
      }),
      ctx({ referenceReused: true }),
    );
    expect(j.reasons).toEqual([
      'account_mismatch',
      'holder_mismatch',
      'bank_mismatch',
      'reference_reused',
    ]);
  });
});

describe('veredicto — lo que NO es una acusación', () => {
  it('una imagen ilegible es `unreadable`, no sospechosa', () => {
    // Una foto borrosa no es un ladrón. Llamarla sospechosa enseñaría a cocina a
    // ignorar la palabra justo cuando aparezca de verdad.
    const j = judgeProof(bueno({ legible: false }), ctx());
    expect(j.verdict).toBe('unreadable');
    expect(j.reasons).toEqual(['unreadable']);
  });

  it('lo que no es un comprobante se dice tal cual', () => {
    const j = judgeProof(bueno({ looksLikeReceipt: false }), ctx());
    expect(j.verdict).toBe('suspicious');
    expect(j.reasons).toEqual(['not_a_receipt']);
  });

  it('un dato que no se leyó nunca acusa', () => {
    const j = judgeProof(bueno({ destinationAccount: null, destinationHolder: null }), ctx());
    expect(j.verdict).toBe('ok');
    expect(j.checks.account).toBe('unknown');
    expect(j.checks.holder).toBe('unknown');
  });

  it('sin NADA que contrastar no se aprueba: eso es `unreadable`', () => {
    // Decir "ok" ahí sería un aprobado que nadie ha dado, y la pantalla lo
    // pintaría como comprobante verificado.
    const j = judgeProof(
      bueno({ destinationAccount: null, destinationHolder: null, destinationBank: null }),
      ctx(),
    );
    expect(j.verdict).toBe('unreadable');
  });

  it('el monto NO se juzga: pagó de menos y sigue siendo `ok`', () => {
    // No se sabe de antemano cuánto va a transferir alguien por WhatsApp: hay
    // quien adelanta, quien paga dos pedidos juntos y quien abona una parte.
    for (const amount of [20, 500, null]) {
      const j = judgeProof(bueno({ amount }), ctx());
      expect(j.verdict, String(amount)).toBe('ok');
      expect(j.reasons, String(amount)).toEqual([]);
    }
  });

  it('una hora ilegible no inventa un desfase', () => {
    for (const fecha of [null, '27/08/2026', '2026-08-27', 'ayer']) {
      expect(judgeProof(bueno({ paidAtLocal: fecha }), ctx()).reasons, String(fecha)).toEqual([]);
    }
  });

  it('un reloj algo desajustado no dispara la alerta', () => {
    // Seis horas de margen: el caso normal son minutos, y lo que se busca es el
    // comprobante de anteayer reenviado, no un teléfono mal puesto en hora.
    expect(judgeProof(bueno({ paidAtLocal: '2026-08-27T17:00' }), ctx()).reasons).toEqual([]);
    expect(judgeProof(bueno({ paidAtLocal: '2026-08-27T23:00' }), ctx()).reasons).toEqual([]);
  });
});

describe('hora local boliviana', () => {
  it('interpreta la hora escrita como UTC−4', () => {
    // 20:28 en Bolivia son las 00:28 UTC del día siguiente.
    expect(parseBolivianLocalTime('2026-08-27T20:28')).toBe(
      Date.parse('2026-08-28T00:28:00.000Z'),
    );
  });

  it('acepta el espacio en vez de la T', () => {
    expect(parseBolivianLocalTime('2026-08-27 20:28')).toBe(
      Date.parse('2026-08-28T00:28:00.000Z'),
    );
  });

  it('lo que no tiene esa forma exacta es `null`: adivinar produce sospechas falsas', () => {
    for (const v of [null, '', '27-08-2026 20:28', '2026-08-27', '20:28']) {
      expect(parseBolivianLocalTime(v), String(v)).toBeNull();
    }
  });
});

// ── La etiqueta del monto (0028) ────────────────────────────────────────────
//
// Dos pagos son legítimos en delivery: la comida sola —el envío se cobra al
// entregar— y la comida con el envío. La etiqueta dice cuál hizo el cliente,
// porque es la pregunta que el repartidor hace al llegar y que hasta ahora se
// contestaba llamando a cocina.

/** Pedido de Bs 48 de comida y Bs 6 de envío. */
const IMPORTES = { subtotal: 48, total: 54 };

describe('etiqueta del monto — los dos pagos válidos', () => {
  it('el subtotal exacto es PAGO PRODUCTOS: falta cobrar el envío', () => {
    const j = judgeProof(bueno({ amount: 48 }), ctx({ amounts: IMPORTES }));
    expect(j.amountLabel).toBe('pago_productos');
    expect(j.verdict).toBe('ok');
    expect(j.reasons).toEqual([]);
  });

  it('el total exacto es PAGO TOTAL: el repartidor no cobra nada', () => {
    const j = judgeProof(bueno({ amount: 54 }), ctx({ amounts: IMPORTES }));
    expect(j.amountLabel).toBe('pago_total');
    expect(j.verdict).toBe('ok');
    expect(j.reasons).toEqual([]);
  });

  it('en recojo las dos cifras coinciden y sale PAGO TOTAL', () => {
    // Sin envío que cobrar aparte, "pagó todo" es la lectura correcta. No es un
    // caso especial: es la misma regla con el envío en cero.
    const j = judgeProof(bueno({ amount: 48 }), ctx({ amounts: { subtotal: 48, total: 48 } }));
    expect(j.amountLabel).toBe('pago_total');
  });
});

describe('etiqueta del monto — lo que no cuadra', () => {
  it('pagar de MENOS acusa: es el retoque que esto viene a detectar', () => {
    const j = judgeProof(bueno({ amount: 7 }), ctx({ amounts: IMPORTES }));
    expect(j.amountLabel).toBe('revisar_monto');
    expect(j.reasons).toContain('amount_mismatch');
    expect(j.verdict).toBe('suspicious');
  });

  it('pagar de MÁS también pide una mirada, y eso es deliberado', () => {
    // Redondear la propina o adelantar son pagos buenos, pero ninguna regla
    // automática los distingue de un pago corto. El cocinero sí, en dos
    // segundos, con el comprobante delante.
    const j = judgeProof(bueno({ amount: 100 }), ctx({ amounts: IMPORTES }));
    expect(j.amountLabel).toBe('revisar_monto');
    expect(j.reasons).toContain('amount_mismatch');
  });

  it('no hay margen de tolerancia: un boliviano de diferencia es una rendija', () => {
    for (const amount of [47, 47.99, 48.01, 49, 53, 55]) {
      expect(judgeProof(bueno({ amount }), ctx({ amounts: IMPORTES })).amountLabel, String(amount))
        .toBe('revisar_monto');
    }
  });

  it('un monto ilegible es un monto inválido', () => {
    const j = judgeProof(bueno({ amount: null }), ctx({ amounts: IMPORTES }));
    expect(j.amountLabel).toBe('revisar_monto');
    expect(j.reasons).toContain('amount_mismatch');
  });
});

describe('etiqueta del monto — cuándo NO se pronuncia', () => {
  it('sin importes no hay etiqueta: `null` no se parece a `pago_total`', () => {
    const j = judgeProof(bueno(), ctx());
    expect(j.amountLabel).toBeNull();
    expect(j.reasons).toEqual([]);
  });

  it('una foto borrosa se etiqueta REVISAR MONTO pero NO se vuelve sospechosa', () => {
    // El cocinero tiene que mirarla —de ahí la etiqueta— pero `unreadable` no
    // es una acusación, y añadirle `amount_mismatch` la convertiría en una.
    const j = judgeProof(bueno({ legible: false }), ctx({ amounts: IMPORTES }));
    expect(j.verdict).toBe('unreadable');
    expect(j.reasons).toEqual(['unreadable']);
    expect(j.amountLabel).toBe('revisar_monto');
  });

  it('lo que no es un comprobante se etiqueta, sin un segundo motivo encima', () => {
    const j = judgeProof(bueno({ looksLikeReceipt: false }), ctx({ amounts: IMPORTES }));
    expect(j.verdict).toBe('suspicious');
    expect(j.reasons).toEqual(['not_a_receipt']);
    expect(j.amountLabel).toBe('revisar_monto');
  });
});
