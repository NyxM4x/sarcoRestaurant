import { describe, it, expect } from 'vitest';
import { judgeProof, parseBolivianLocalTime, type ProofFacts } from './analysis';
import type { ExpectedAccount } from './expected-account';

const CUENTA: ExpectedAccount = {
  bank: 'Banco Unión',
  accountNumber: '1234567890',
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
  amountDueByQr: 48,
  receivedAtMs: LLEGADA,
  referenceReused: false,
  ...over,
});

describe('veredicto — el comprobante que cuadra', () => {
  it('cuenta, titular y monto correctos: `ok` y sin motivos', () => {
    const j = judgeProof(bueno(), ctx());
    expect(j.verdict).toBe('ok');
    expect(j.reasons).toEqual([]);
    expect(j.checks).toEqual({ account: 'match', holder: 'match', amount: 'match' });
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

  it('pagó menos de lo que debía', () => {
    // El caso clásico: Bs 20 para un pedido de Bs 48, aceptado con prisa.
    const j = judgeProof(bueno({ amount: 20 }), ctx());
    expect(j.verdict).toBe('suspicious');
    expect(j.reasons).toEqual(['amount_short']);
  });

  it('el monto es de otro pedido, aunque sea mayor', () => {
    const j = judgeProof(bueno({ amount: 64 }), ctx());
    expect(j.verdict).toBe('suspicious');
    expect(j.reasons).toEqual(['amount_over']);
  });

  it('un céntimo de diferencia no dispara la alerta; un boliviano sí', () => {
    // La lectura es ÓPTICA: tolerar el céntimo absorbe un decimal mal leído sin
    // abrirle ninguna puerta a nadie. Nadie roba céntimos, y una alerta por un
    // céntimo es una alerta que se aprende a ignorar.
    expect(judgeProof(bueno({ amount: 47.99 }), ctx()).reasons).toEqual([]);
    expect(judgeProof(bueno({ amount: 48.01 }), ctx()).reasons).toEqual([]);
    expect(judgeProof(bueno({ amount: 47 }), ctx()).reasons).toEqual(['amount_short']);
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
      bueno({ destinationAccount: '9999999999', destinationHolder: 'MARIA LOPEZ', amount: 20 }),
      ctx({ referenceReused: true }),
    );
    expect(j.reasons).toEqual([
      'account_mismatch',
      'holder_mismatch',
      'amount_short',
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
      bueno({ destinationAccount: null, destinationHolder: null, amount: null }),
      ctx(),
    );
    expect(j.verdict).toBe('unreadable');
  });

  it('sin saber cuánto había que pagar, el monto no se juzga', () => {
    const j = judgeProof(bueno({ amount: 20 }), ctx({ amountDueByQr: null }));
    expect(j.verdict).toBe('ok');
    expect(j.checks.amount).toBe('unknown');
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
