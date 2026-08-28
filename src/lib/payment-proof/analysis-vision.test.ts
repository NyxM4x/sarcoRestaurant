import { describe, it, expect } from 'vitest';
import {
  buildProofReadInput,
  parseProofFacts,
  PROOF_READER_PROMPT,
  readProofFacts,
} from './analysis-vision';
import type { AgentModel, AgentModelResult } from '@/lib/agent/core/model';

const DATA_URL = 'data:image/jpeg;base64,AAAA';

/** Modelo falso: devuelve lo que se le diga, sin red. */
function modeloQueResponde(res: AgentModelResult): AgentModel {
  return { model: 'fake-model', complete: async () => res };
}

const RESPUESTA_COMPLETA = JSON.stringify({
  looksLikeReceipt: true,
  legible: true,
  bank: 'Banco Unión',
  destinationAccount: '****7890',
  destinationHolder: 'DON ZARCO SRL',
  amount: 48,
  currency: 'BOB',
  transactionRef: '987654321',
  paidAtLocal: '2026-08-27T20:28',
});

describe('la instrucción del lector', () => {
  it('manda la imagen junto a la instrucción, en alta definición', () => {
    const input = buildProofReadInput(DATA_URL);
    expect(input).toHaveLength(2);
    expect(input[1]).toEqual({
      role: 'user',
      content: [
        { type: 'input_text', text: 'Lee este comprobante.' },
        // El número de cuenta y el monto son texto pequeño, y de ese texto
        // depende todo lo demás.
        { type: 'input_image', image_url: DATA_URL, detail: 'high' },
      ],
    });
  });

  it('NO le dice al modelo qué cuenta ni qué monto esperamos', () => {
    // Un modelo al que se le enseña la respuesta correcta tiende a verla: dile
    // que la cuenta acaba en 4471 y leerá 4471 donde pone 4477, que es justo el
    // dígito que cambia el retoque.
    const texto = JSON.stringify(buildProofReadInput(DATA_URL));
    for (const filtrado of ['ZARCO', 'esperad', 'debería decir', 'correcto si']) {
      expect(texto.toLowerCase(), filtrado).not.toContain(filtrado.toLowerCase());
    }
  });

  it('el prompt insiste en que `null` es una respuesta válida', () => {
    // Un modelo que siente que debe rellenar todos los huecos inventa un número
    // de cuenta, y una cuenta inventada acusa a un cliente real.
    expect(PROOF_READER_PROMPT).toContain('NO adivines');
    expect(PROOF_READER_PROMPT).toContain('null');
  });
});

describe('lectura de la respuesta', () => {
  it('acepta el JSON limpio', () => {
    expect(parseProofFacts(RESPUESTA_COMPLETA)).toMatchObject({
      looksLikeReceipt: true,
      destinationAccount: '****7890',
      amount: 48,
    });
  });

  it('acepta el JSON envuelto en una valla de código o en una frase', () => {
    // Descartar una lectura correcta por un detalle de presentación sería tirar
    // el trabajo —y el coste— a la basura.
    const conValla = '```json\n' + RESPUESTA_COMPLETA + '\n```';
    expect(parseProofFacts(conValla)?.amount).toBe(48);
    expect(parseProofFacts('Claro, aquí tienes: ' + RESPUESTA_COMPLETA)?.amount).toBe(48);
  });

  it('normaliza a `null` lo vacío y lo ausente', () => {
    const facts = parseProofFacts(
      JSON.stringify({
        looksLikeReceipt: true,
        legible: true,
        destinationAccount: '   ',
        destinationHolder: null,
      }),
    );
    expect(facts).toEqual({
      looksLikeReceipt: true,
      legible: true,
      bank: null,
      destinationAccount: null,
      destinationHolder: null,
      amount: null,
      currency: null,
      transactionRef: null,
      paidAtLocal: null,
    });
  });

  it('entiende un monto que llegó como texto pese al prompt', () => {
    const conTexto = (amount: unknown) =>
      parseProofFacts(JSON.stringify({ looksLikeReceipt: true, legible: true, amount }))?.amount;
    expect(conTexto('48,00')).toBe(48);
    expect(conTexto('Bs 48.00')).toBe(48);
    // Lo que no es inequívocamente un número no se interpreta.
    expect(conTexto('no se ve')).toBeNull();
  });

  it('una respuesta sin la forma pedida se descarta ENTERA', () => {
    // Media lectura produce media sospecha, que es peor que ninguna.
    expect(parseProofFacts('lo siento, no puedo ayudarte con eso')).toBeNull();
    expect(parseProofFacts('{"legible": true}')).toBeNull(); // falta looksLikeReceipt
    expect(parseProofFacts('{roto')).toBeNull();
    expect(parseProofFacts('')).toBeNull();
  });
});

describe('lectura completa', () => {
  it('devuelve los hechos y el modelo que los leyó', async () => {
    const res = await readProofFacts(
      modeloQueResponde({ ok: true, text: RESPUESTA_COMPLETA, model: 'gpt-4o-mini' }),
      DATA_URL,
    );
    expect(res).toEqual({
      ok: true,
      facts: expect.objectContaining({ amount: 48 }),
      model: 'gpt-4o-mini',
    });
  });

  it('un fallo del modelo NO se propaga: sale como resultado', async () => {
    const res = await readProofFacts(
      modeloQueResponde({ ok: false, error: 'timeout' }),
      DATA_URL,
    );
    expect(res).toEqual({ ok: false, error: 'model_error' });
  });

  it('una excepción del transporte tampoco escapa', async () => {
    const explota: AgentModel = {
      model: 'fake-model',
      complete: async () => {
        throw new Error('red caída');
      },
    };
    await expect(readProofFacts(explota, DATA_URL)).resolves.toEqual({
      ok: false,
      error: 'model_error',
    });
  });

  it('una respuesta ilegible se distingue de un fallo del modelo', async () => {
    const res = await readProofFacts(
      modeloQueResponde({ ok: true, text: 'no puedo', model: 'gpt-4o-mini' }),
      DATA_URL,
    );
    expect(res).toEqual({ ok: false, error: 'invalid_response' });
  });
});
