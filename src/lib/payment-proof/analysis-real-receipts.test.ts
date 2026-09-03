/**
 * Los comprobantes que de verdad llegan — banco por banco.
 *
 * Los otros tests prueban la regla con datos inventados; este prueba la regla
 * contra lo que imprimen los bancos bolivianos de verdad.
 *
 * ── Qué de aquí abajo es real y qué es marcador ─────────────────────────────
 *
 * REAL, y es lo que da valor a este archivo: la FORMA de cada banco. Quién sale
 * como destino y con qué palabra lo llama, en qué orden pinta el nombre, cómo
 * enmascara la cuenta, qué largo tiene su número de operación. Eso está
 * transcrito de cinco comprobantes de un mismo día y no cambia porque cambie el
 * titular.
 *
 * MARCADOR, pendiente de sustituir: la identidad. Titular, número de cuenta y
 * números de operación son datos de una persona concreta y se retiraron de aquí
 * (02-09-2026). Los valores actuales son inventados y solo conservan el FORMATO.
 * Cuando lleguen los comprobantes reales del cliente se sustituyen por los
 * suyos, banco por banco, y este aviso se borra.
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

/**
 * La cuenta del QR. Los mismos CAMPOS que van en el entorno; los valores son
 * marcadores hasta que lleguen los del cliente (ver la cabecera).
 */
const CUENTA = parseExpectedAccount({
  bank: 'Banco Nacional de Bolivia',
  bankAliases: 'BNB|BANCO NACIONAL DE BOLIVIA',
  accountNumber: '4010775520',
  holder: 'MAMANI TERCEROS LUCIA',
  holderAliases: 'LUCIA MAMANI TERCEROS',
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
      destinationAccount: '4010775520',
      destinationHolder: 'MAMANI TERCEROS LUCIA',
      transactionRef: '0726082800047315',
      paidAtLocal: '2026-08-28T13:14',
    }),
  },
  {
    // Mercantil Santa Cruz: bloque "CUENTA DESTINO" con CI del beneficiario.
    banco: 'Mercantil Santa Cruz',
    facts: leido({
      bank: 'Mercantil Santa Cruz',
      destinationBank: 'Banco Nacional de Bolivia',
      destinationAccount: '4010775520',
      destinationHolder: 'MAMANI TERCEROS LUCIA',
      transactionRef: '1003202608281400273',
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
      destinationAccount: '4010775520',
      destinationHolder: 'Mamani Terceros Lucia',
      transactionRef: '904331782',
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
      destinationAccount: '4010775520',
      destinationHolder: 'MAMANI TERCEROS LUCIA',
      transactionRef: '351408967',
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
    destinationAccount: '318**402',
    destinationHolder: 'LUCIA MAMANI TERCEROS',
    transactionRef: '2P31586402',
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

/**
 * ── Los comprobantes de la noche del 02→03-09-2026 ──────────────────────────
 *
 * Estos SÍ son los de producción, y son los que explicaron por qué de 45
 * comprobantes salieron 24 sospechosos sin que ninguno lo fuera —se verificaron
 * uno a uno con la banca móvil—.
 *
 * El destino es real: es la cuenta del negocio, la que va impresa en el QR que
 * se le pasa a cada cliente. Los REMITENTES no: los nombres de los seis
 * clientes que pagaron esa noche están sustituidos por inventados, porque un
 * fixture no necesita saber quién paga y un repositorio no es sitio para eso.
 *
 * Es un QR ESTÁTICO de Yape, así que la "cuenta" destino es el número de
 * teléfono del cobro. De ahí que tres bancos distintos escriban ese mismo
 * número de tres maneras.
 *
 * Las dos causas que destaparon, y que estos casos fijan para siempre:
 *
 *   1. La MÁSCARA. Altoke imprime `78***705` y BNB `784**705`. Pegando los
 *      dígitos visibles sale `78705` y `784705`, cuyas colas de cuatro son
 *      `8705` y `4705` — la cuenta real termina en `6705`. Todos los pagos por
 *      esos dos bancos salían acusados de ir a otra cuenta.
 *
 *   2. El NOMBRE junto al bloque equivocado. BCP pinta "A la cuenta / Del
 *      banco" y justo debajo "De la cuenta / A nombre de", así que el nombre
 *      más cercano al destino es el del remitente.
 */
describe('comprobantes reales — la noche del 02→03-09-2026', () => {
  /** La cuenta del QR del negocio, tal como debe quedar configurada. */
  const QR_ZARCO = parseExpectedAccount({
    bank: 'Banco de Crédito de Bolivia',
    bankAliases: 'BCP|YAPE|BANCO DE CREDITO|BANCO DE CREDITO DE BOLIVIA',
    accountNumber: '78486705',
    holder: 'CRISTIAN MORALES CASTRO',
    holderAliases: 'MORALES CASTRO CRISTIAN',
  })!;

  const contexto = (paidAtLocal: string): ProofJudgeContext => ({
    expected: QR_ZARCO,
    // El comprobante llega por WhatsApp a los pocos minutos de pagarlo.
    receivedAtMs: Date.parse(`${paidAtLocal}:00.000Z`) + 4 * 60 * 60 * 1000 + 3 * 60_000,
    referenceReused: false,
  });

  const REALES: Array<{ banco: string; facts: ProofFacts; paidAtLocal: string }> = [
    {
      // Altoke (Banco Solidario) · Bs 79 · pedido ORD-260902-025.
      // "Para" + cuenta tapada por el medio: `78***705`.
      banco: 'Altoke / Banco Solidario',
      paidAtLocal: '2026-09-03T02:51',
      facts: leido({
        bank: 'Banco Solidario S.A.',
        destinationBank: 'Banco de Crédito de Bolivia',
        destinationAccount: '78***705',
        destinationHolder: 'CRISTIAN MORALES CASTRO',
        amount: 79,
        transactionRef: '03092026/295/398/001/1598',
      }),
    },
    {
      // Yape · Bs 48 · pedido ORD-260902-024. Cuenta entera y "Destino: Yape".
      banco: 'Yape (BCP)',
      paidAtLocal: '2026-09-03T02:45',
      facts: leido({
        bank: 'Yape',
        destinationBank: 'Yape',
        destinationAccount: '78486705',
        destinationHolder: 'Cristian Morales Castro',
        amount: 48,
        transactionRef: '925698701',
      }),
    },
    {
      // Altoke · Bs 48 · pedido ORD-260902-021. Misma forma que el primero.
      banco: 'Altoke / Banco Solidario',
      paidAtLocal: '2026-09-03T01:55',
      facts: leido({
        bank: 'Banco Solidario S.A.',
        destinationBank: 'Banco de Crédito de Bolivia',
        destinationAccount: '78***705',
        destinationHolder: 'CRISTIAN MORALES CASTRO',
        amount: 48,
        transactionRef: '02092026/295/398/101/8701',
      }),
    },
    {
      // BNB · Bs 18 · pedido ORD-260902-018. "Nombre del destinatario" y
      // "Se acreditó a la cuenta", con otra máscara: `784**705`.
      banco: 'BNB (transferencia interbancaria)',
      paidAtLocal: '2026-09-03T01:30',
      facts: leido({
        bank: 'BNB',
        destinationBank: 'BANCO DE CREDITO',
        destinationAccount: '784**705',
        destinationHolder: 'CRISTIAN MORALES CASTRO',
        amount: 18,
        transactionRef: '1P37400265',
      }),
    },
    {
      // Yape · Bs 18 · pedido ORD-260902-013.
      banco: 'Yape (BCP)',
      paidAtLocal: '2026-09-03T00:24',
      facts: leido({
        bank: 'Yape',
        destinationBank: 'Yape',
        destinationAccount: '78486705',
        destinationHolder: 'Cristian Morales Castro',
        amount: 18,
        transactionRef: '925671511',
      }),
    },
    {
      // BCP · Bs 33 · pedido ORD-260902-012. EL CASO DEL NOMBRE MAL SITUADO:
      // "A la cuenta: 78486705 / Del banco: yape" y debajo "De la cuenta: … /
      // A nombre de: <quien paga>". El nombre leído como destino es el del
      // REMITENTE, y aquí va a propósito el inventado que lo representa.
      banco: 'BCP (banca web)',
      paidAtLocal: '2026-09-02T23:42',
      facts: leido({
        bank: 'Banco de Crédito de Bolivia S.A.',
        destinationBank: 'yape',
        destinationAccount: '78486705',
        destinationHolder: 'ROSA QUISPE VARGAS',
        amount: 33,
        transactionRef: '20260902234223',
      }),
    },
  ];

  it.each(REALES)('$banco: pago legítimo, sin alerta', ({ facts, paidAtLocal }) => {
    const j = judgeProof(facts, contexto(paidAtLocal));
    expect(j.reasons).toEqual([]);
    expect(j.verdict).toBe('ok');
  });

  it('la máscara del medio no puede acusar a la cuenta propia', () => {
    // El fallo, aislado: los dígitos visibles de `78***705` no son contiguos.
    for (const enmascarada of ['78***705', '784**705', '78xx705', '****6705']) {
      const j = judgeProof(
        leido({ destinationAccount: enmascarada, destinationHolder: null, destinationBank: null }),
        contexto('2026-09-03T01:00'),
      );
      expect(j.reasons, enmascarada).not.toContain('account_mismatch');
    }
  });

  it('pero una máscara de OTRA cuenta sigue acusando', () => {
    // El arreglo no puede convertirse en un pase libre: los extremos visibles
    // tienen que ser los nuestros.
    const j = judgeProof(
      leido({ destinationAccount: '99***123', destinationHolder: null, destinationBank: null }),
      contexto('2026-09-03T01:00'),
    );
    expect(j.reasons).toContain('account_mismatch');
  });
});
