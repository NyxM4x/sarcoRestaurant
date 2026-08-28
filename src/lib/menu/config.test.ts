import { describe, it, expect } from 'vitest';
import { MENU_REQUIRED_VARS, parseMenuPipelineConfig, shapeOf } from './config';

/** Un entorno con todo lo que el menú necesita. */
const COMPLETO: Record<string, string> = Object.fromEntries(
  MENU_REQUIRED_VARS.map((v) => [v, `valor-de-${v}`]),
);

describe('diagnóstico del menú', () => {
  it('con todo puesto, el menú puede salir', () => {
    const r = parseMenuPipelineConfig(COMPLETO);
    expect(r.ok).toBe(true);
    expect(r.missing).toEqual([]);
  });

  it('nombra exactamente lo que falta', () => {
    const { KAPSO_API_KEY, MENU_SESSION_SECRET, ...resto } = COMPLETO;
    void KAPSO_API_KEY;
    void MENU_SESSION_SECRET;
    const r = parseMenuPipelineConfig(resto);
    expect(r.ok).toBe(false);
    expect(r.missing.sort()).toEqual(['KAPSO_API_KEY', 'MENU_SESSION_SECRET']);
  });

  it('una variable vacía cuenta como ausente', () => {
    // En los paneles de despliegue, "existe pero vacía" es tan común como "no
    // está", y rompe igual.
    expect(parseMenuPipelineConfig({ ...COMPLETO, APP_BASE_URL: '' }).missing).toEqual([
      'APP_BASE_URL',
    ]);
  });

  it('NUNCA devuelve el valor de una variable', () => {
    const r = parseMenuPipelineConfig({ ...COMPLETO, KAPSO_API_KEY: 'secreto-real-abc123' });
    expect(JSON.stringify(r)).not.toContain('secreto-real-abc123');
  });

  it('delata el secreto pegado con comillas o con espacios', () => {
    // Es EL error clásico del panel web: invisible al mirarlo, y rompe la firma
    // HMAC sin dar ningún síntoma que se pueda entender.
    expect(shapeOf('  abc  ').suspicious).toBe(true);
    expect(shapeOf('"abc"').suspicious).toBe(true);
    expect(shapeOf("'abc'").suspicious).toBe(true);
    expect(shapeOf('abc').suspicious).toBe(false);
    expect(shapeOf(undefined)).toEqual({ present: false });
    expect(shapeOf('abc').length).toBe(3);
  });
});

describe('diagnóstico del agente — por qué no contesta', () => {
  const conIa = (over: Record<string, string> = {}) =>
    parseMenuPipelineConfig({
      ...COMPLETO,
      AI_ENABLED: 'true',
      AI_ACCESS_MODE: 'all',
      OPENAI_API_KEY: 'sk-loquesea',
      ...over,
    });

  it('las tres condiciones a la vez: interruptor, clave y modo abierto', () => {
    expect(conIa().agent.wouldAnswerAnyone).toBe(true);
    expect(conIa({ AI_ENABLED: 'false' }).agent.wouldAnswerAnyone).toBe(false);
    expect(conIa({ AI_ACCESS_MODE: 'allowlist' }).agent.wouldAnswerAnyone).toBe(false);
    expect(conIa({ OPENAI_API_KEY: '' }).agent.wouldAnswerAnyone).toBe(false);
  });

  it('solo la cadena exacta enciende: un typo NO abre nada', () => {
    // Misma disciplina que en `eligibility.ts`, y por el mismo motivo: un valor
    // que no se entiende jamás puede interpretarse como permiso.
    for (const v of ['TRUE', 'True', '1', 'si', ' true']) {
      expect(conIa({ AI_ENABLED: v }).agent.enabled, v).toBe(false);
    }
    for (const v of ['ALL', 'todos', 'true', '']) {
      expect(conIa({ AI_ACCESS_MODE: v }).agent.accessMode, v).toBe('allowlist');
    }
  });

  it('cuenta los teléfonos de la lista pero NO los devuelve', () => {
    const r = conIa({ AI_TEST_PHONES: '59171234567, 59176543210, ' });
    expect(r.agent.allowlistCount).toBe(2);
    expect(JSON.stringify(r)).not.toContain('59171234567');
  });

  it('el menú NO depende de la IA: con el agente apagado sigue `ok`', () => {
    // Es la confusión más cara de este sistema, y por eso tiene un test.
    const r = parseMenuPipelineConfig(COMPLETO);
    expect(r.ok).toBe(true);
    expect(r.agent.enabled).toBe(false);
  });
});

describe('diagnóstico de comprobantes — por qué no se analiza nada', () => {
  const todo = {
    ...COMPLETO,
    PAYMENT_PROOF_CAPTURE_ENABLED: 'true',
    R2_ACCOUNT_ID: 'a',
    R2_ACCESS_KEY_ID: 'b',
    R2_SECRET_ACCESS_KEY: 'c',
    R2_BUCKET: 'd',
    PAYMENT_PROOF_ANALYSIS_ENABLED: 'true',
    PAYMENT_PROOF_ACCOUNT_NUMBER: '1234567890',
    OPENAI_API_KEY: 'sk-loquesea',
  };

  it('con todo puesto, analizaría', () => {
    expect(parseMenuPipelineConfig(todo).proofs.wouldAnalyze).toBe(true);
  });

  it('cada pieza que falte lo apaga, y se ve CUÁL', () => {
    const sin = (k: string) => parseMenuPipelineConfig({ ...todo, [k]: '' }).proofs;
    // Sin captura no llega ningún comprobante: no hay nada que analizar.
    expect(sin('PAYMENT_PROOF_CAPTURE_ENABLED').captureEnabled).toBe(false);
    expect(sin('PAYMENT_PROOF_CAPTURE_ENABLED').wouldAnalyze).toBe(false);
    // Sin bucket la captura ni arranca.
    expect(sin('R2_BUCKET').storageConfigured).toBe(false);
    // Sin clave no se puede leer la imagen.
    expect(sin('OPENAI_API_KEY').wouldAnalyze).toBe(false);
  });

  it('sin cuenta esperada NO analiza, aunque el interruptor esté en true', () => {
    // Un veredicto sin patrón contra el que comparar sería un aprobado que
    // nadie ha dado, y la pantalla lo pintaría como comprobante verificado.
    const r = parseMenuPipelineConfig({
      ...todo,
      PAYMENT_PROOF_ACCOUNT_NUMBER: '',
      PAYMENT_PROOF_ACCOUNT_HOLDER: '',
    }).proofs;
    expect(r.analysisEnabled).toBe(true);
    expect(r.expectedAccountConfigured).toBe(false);
    expect(r.wouldAnalyze).toBe(false);
  });

  it('el modelo del lector NO hereda el del agente', () => {
    // gpt-4o-mini es el más caro para imagen: ~48.000 tokens por foto.
    const r = parseMenuPipelineConfig({ ...todo, OPENAI_MODEL: 'gpt-4o-mini' }).proofs;
    expect(r.analysisModel).toBe('gpt-5-mini');
  });
});
