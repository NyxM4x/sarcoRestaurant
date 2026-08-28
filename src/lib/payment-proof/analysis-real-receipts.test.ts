/**
 * Los comprobantes que de verdad llegan — banco por banco.
 *
 * Los otros tests prueban la regla con datos inventados; este prueba la regla
 * contra lo que imprimen los bancos bolivianos de verdad. Los hechos de aquí
 * abajo están transcritos, campo por campo, de cinco comprobantes reales de un
 * mismo día (28/08/2026, transferencias de Bs 1 a la cuenta del QR).
 *
 * Sirven para lo que ningún dato inventado sirve: cada banco ordena el nombre a
 * su manera, enmascara la cuenta a su manera y llama "solicitante", "destino" o
 * "a nombre de" a la misma persona. Si mañana alguien afina la comparación de
 * nombres o de cuentas, esto dice si acaba de romper los pagos de Mercantil.
 *
 * Lo que NO prueban es la lectura de la imagen: aquí ya entran leídos. Que el
 * modelo saque estos campos del PNG es otra cosa, y se mira con el ojo.
 */
import { describe, it, expect } from 'vitest';
import { judgeProof, type ProofFacts, type ProofJudgeContext } from './analysis';
import { parseExpectedAccount } from './expected-account';

/** La cuenta del QR, con los mismos valores que van en el entorno. */
const CUENTA = parseExpectedAccount({
  bank: 'Banco Nacional de Bolivia',
  bankAliases: 'BNB|BANCO NACIONAL DE BOLIVIA',
  accountNumber: '2505098350',
  holder: 'GRAGEDA ROJAS ADALID',
  holderAliases: 'ADALID GRAGEDA ROJAS',
})!;

/** El comprobante llega por WhatsApp a los pocos minutos: 13:20 en Bolivia. */
const LLEGADA = Date.parse('2026-08-28T17:20:00.000Z');

/**
 * Los cinco son transferencias de Bs 1 y ninguno corresponde al total de un
 * pedido real. Da igual: el monto no entra en el juicio.
 */
const ctx = (over: Partial<ProofJudgeContext> = {}): ProofJudgeContext => ({
  expected: CUENTA,
  receivedAtMs: LLEGADA,
  referenceReused: false,
  ...over,
});

const leido = (over: Partial<ProofFacts>): ProofFacts => ({
  looksLikeReceipt: true,
  legible: true,
  bank: null,
  destinationBank: null,
  destinationAccount: null,
  destinationHolder: null,
  amount: 1,
  currency: 'BOB',
  transactionRef: null,
  paidAtLocal: null,
  ...over,
});

/**
 * Los cuatro que sí fueron a la cuenta del QR. Cambia el banco de origen, la
 * forma del nombre y hasta el nombre del campo; el destino es el mismo.
 */
const AL_QR: Array<{ banco: string; facts: ProofFacts }> = [
  {
    // BCP Banca Móvil: "A la cuenta" / "A nombre de", apellido delante.
    banco: 'BCP',
    facts: leido({
      bank: 'Banco de Crédito de Bolivia S.A.',
      destinationBank: 'Banco Nacional de Bolivia',
      destinationAccount: '2505098350',
      destinationHolder: 'GRAGEDA ROJAS ADALID',
      transactionRef: '0726082800094640',
      paidAtLocal: '2026-08-28T13:14',
    }),
  },
  {
    // Mercantil Santa Cruz: bloque "CUENTA DESTINO" con CI del beneficiario.
    banco: 'Mercantil Santa Cruz',
    facts: leido({
      bank: 'Mercantil Santa Cruz',
      destinationBank: 'Banco Nacional de Bolivia',
      destinationAccount: '2505098350',
      destinationHolder: 'GRAGEDA ROJAS ADALID',
      transactionRef: '1003202608281832878',
      paidAtLocal: '2026-08-28T13:12',
    }),
  },
  {
    // Yape: no dice "destino" en ninguna parte. El nombre grande bajo el monto
    // es a quién se le yapeó, y "Realizado por" es el remitente.
    banco: 'Yape',
    facts: leido({
      bank: 'Yape',
      destinationBank: 'Banco Nacional De Bolivia',
      destinationAccount: '2505098350',
      destinationHolder: 'Grageda Rojas Adalid',
      transactionRef: '912725111',
      paidAtLocal: '2026-08-28T13:11',
    }),
  },
  {
    // Banco Económico, pago con QR: quien cobra sale como "Solicitante", y el
    // pagador como "Remitente" — al revés de lo que sugiere la palabra.
    banco: 'Banco Económico (QR)',
    facts: leido({
      bank: 'Banco Económico',
      destinationBank: 'Banco Nacional de Bolivia',
      destinationAccount: '2505098350',
      destinationHolder: 'GRAGEDA ROJAS ADALID',
      transactionRef: '378599238',
      paidAtLocal: '2026-08-28T13:15',
    }),
  },
];

describe('comprobantes reales — los que fueron a la cuenta del QR', () => {
  for (const { banco, facts } of AL_QR) {
    it(`${banco}: pasa sin alerta`, () => {
      const j = judgeProof(facts, ctx());
      expect(j.reasons).toEqual([]);
      expect(j.verdict).toBe('ok');
      expect(j.checks).toEqual({ account: 'match', holder: 'match', bank: 'match' });
    });
  }
});

describe('comprobantes reales — el que fue a otra cuenta', () => {
  /**
   * BNB, transferencia interbancaria entre dos cuentas propias. El comprobante
   * es auténtico, con su bancarización y todo; lo único que no es, es un pago a
   * Don Zarco: el dinero fue al Banco de Crédito, no a la cuenta del QR.
   *
   * Por eso vale como caso: la alerta NO depende de que el comprobante sea
   * falso, sino de a dónde fue el dinero. Un comprobante verdadero de OTRA
   * transferencia —reenviado de buena fe o no— tiene que verse igual.
   */
  const bnbAOtraCuenta = leido({
    // El membrete es del BNB; el dinero sale de él hacia otro banco.
    bank: 'BNB',
    destinationBank: 'Banco de Crédito',
    // El BNB enmascara así: tres dígitos, asteriscos y tres dígitos.
    destinationAccount: '756**881',
    destinationHolder: 'ADALID GRAGEDA ROJAS',
    transactionRef: '2P22947996',
    paidAtLocal: '2026-08-28T12:46',
  });

  it('BNB a otro banco: sospechoso por la cuenta Y por el banco', () => {
    const j = judgeProof(bnbAOtraCuenta, ctx());
    expect(j.verdict).toBe('suspicious');
    expect(j.reasons).toEqual(['account_mismatch', 'bank_mismatch']);
  });

  it('el titular NO acusa: es el mismo nombre en otro orden', () => {
    const j = judgeProof(bnbAOtraCuenta, ctx());
    expect(j.checks.holder).toBe('match');
    expect(j.reasons).not.toContain('holder_mismatch');
  });
});

describe('comprobantes reales — el mismo pago dos veces', () => {
  it('el número de transacción reaparece en otro pedido', () => {
    const j = judgeProof(AL_QR[0].facts, ctx({ referenceReused: true }));
    expect(j.verdict).toBe('suspicious');
    expect(j.reasons).toEqual(['reference_reused']);
  });
});

describe('comprobantes reales — el de ayer reenviado hoy', () => {
  it('la hora del comprobante queda lejos de su llegada', () => {
    const j = judgeProof(
      { ...AL_QR[1].facts, paidAtLocal: '2026-08-27T13:12' },
      ctx(),
    );
    expect(j.verdict).toBe('suspicious');
    expect(j.reasons).toContain('stale_receipt');
  });
});
