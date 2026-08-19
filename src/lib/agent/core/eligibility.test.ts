import { describe, it, expect } from 'vitest';
import {
  evaluateAgentEligibility,
  parseAccessMode,
  parseTestPhones,
  type AgentEligibilityConfig,
} from './eligibility';

/**
 * Puerta de elegibilidad (Fase 6D.2F.3).
 *
 * El despliegue está limitado a una lista CERRADA de teléfonos. Estos tests
 * existen para que ampliarla sea una decisión explícita y no un accidente:
 * cualquier relajación de la coincidencia exacta rompe algo aquí.
 */

const TEST_PHONE = '59162139119';
/** Segundo teléfono de prueba (17-08-2026). */
const SEGUNDO_PHONE = '59172654203';

function config(over: Partial<AgentEligibilityConfig> = {}): AgentEligibilityConfig {
  return { enabled: true, accessMode: 'allowlist', testPhones: [TEST_PHONE], hasApiKey: true, ...over };
}

describe('eligibility — interruptores', () => {
  it('AI_ENABLED apagado => disabled, aunque el teléfono coincida', () => {
    expect(evaluateAgentEligibility(TEST_PHONE, config({ enabled: false }))).toBe('disabled');
  });

  it('sin clave de OpenAI => not_configured, nunca se intenta llamar', () => {
    expect(evaluateAgentEligibility(TEST_PHONE, config({ hasApiKey: false }))).toBe(
      'not_configured',
    );
  });

  it('el interruptor manda sobre todo lo demás', () => {
    const apagado = config({ enabled: false, hasApiKey: false, testPhones: [] });
    expect(evaluateAgentEligibility(TEST_PHONE, apagado)).toBe('disabled');
  });
});

describe('eligibility — teléfonos de prueba', () => {
  it('coincidencia exacta => eligible', () => {
    expect(evaluateAgentEligibility(TEST_PHONE, config())).toBe('eligible');
  });

  it('cualquier otro teléfono => phone_not_allowed', () => {
    for (const otro of ['59170000001', '59162139118', '']) {
      expect(evaluateAgentEligibility(otro, config()), otro).toBe('phone_not_allowed');
    }
  });

  it('no hay coincidencia por prefijo ni por sufijo', () => {
    // Un `startsWith` o un `includes` dejarían pasar a clientes reales.
    for (const parecido of ['591621391', '5916213911900', '6213911', '159162139119']) {
      expect(evaluateAgentEligibility(parecido, config()), parecido).toBe('phone_not_allowed');
    }
  });

  it('sin teléfonos configurados no se atiende a nadie', () => {
    expect(evaluateAgentEligibility(TEST_PHONE, config({ testPhones: [] }))).toBe(
      'phone_not_allowed',
    );
  });

  // ── Allowlist de dos números (17-08-2026) ────────────────────────────────

  it('el PRIMER teléfono de la lista es elegible', () => {
    const dos = config({ testPhones: [TEST_PHONE, SEGUNDO_PHONE] });
    expect(evaluateAgentEligibility(TEST_PHONE, dos)).toBe('eligible');
  });

  it('el SEGUNDO teléfono de la lista es elegible', () => {
    const dos = config({ testPhones: [TEST_PHONE, SEGUNDO_PHONE] });
    expect(evaluateAgentEligibility(SEGUNDO_PHONE, dos)).toBe('eligible');
  });

  it('un tercer teléfono sigue rechazado aunque la lista tenga dos', () => {
    // Lo que la lista NO hace: abrirse. Sigue siendo un conjunto cerrado.
    const dos = config({ testPhones: [TEST_PHONE, SEGUNDO_PHONE] });
    expect(evaluateAgentEligibility('59170000001', dos)).toBe('phone_not_allowed');
  });
});

// ── Lectura de la allowlist desde el entorno ────────────────────────────────

describe('parseTestPhones — la forma CSV del entorno', () => {
  it('dos números separados por coma', () => {
    expect(parseTestPhones('59162139119,59172654203')).toEqual([TEST_PHONE, SEGUNDO_PHONE]);
  });

  it('los espacios alrededor de cada número no cuentan', () => {
    expect(parseTestPhones('  59162139119 ,  59172654203  ')).toEqual([
      TEST_PHONE,
      SEGUNDO_PHONE,
    ]);
  });

  it('las entradas vacías se ignoran: comas sueltas, finales o dobles', () => {
    expect(parseTestPhones('59162139119,,59172654203,')).toEqual([TEST_PHONE, SEGUNDO_PHONE]);
    expect(parseTestPhones(' , , ')).toEqual([]);
    expect(parseTestPhones(',')).toEqual([]);
  });

  it('normaliza al MISMO formato con el que llega el teléfono del cliente', () => {
    // Tal como se pega desde WhatsApp: con +, espacios y guiones.
    const permitidos = parseTestPhones('+591 62139119, +591 726-54203');

    expect(permitidos).toEqual([TEST_PHONE, SEGUNDO_PHONE]);
    // Y por tanto compara de verdad contra el entrante ya normalizado.
    const cfg = config({ testPhones: permitidos });
    expect(evaluateAgentEligibility(SEGUNDO_PHONE, cfg)).toBe('eligible');
  });

  it('lo que no deja dígitos se descarta, sin colarse como cadena vacía', () => {
    // Si `'abc'` sobreviviera como `''`, empataría con un teléfono ilegible.
    const permitidos = parseTestPhones('abc, 59162139119');

    expect(permitidos).toEqual([TEST_PHONE]);
    expect(evaluateAgentEligibility('', config({ testPhones: permitidos }))).toBe(
      'phone_not_allowed',
    );
  });

  it('no repite un número que venga dos veces', () => {
    expect(parseTestPhones('59162139119, +591 62139119')).toEqual([TEST_PHONE]);
  });

  it('un solo número sigue funcionando: es la forma de AI_TEST_PHONE', () => {
    // El respaldo de compatibilidad. `service.ts` pasa `AI_TEST_PHONE` por aquí
    // cuando `AI_TEST_PHONES` no está definida.
    expect(parseTestPhones('59162139119')).toEqual([TEST_PHONE]);
  });

  it('sin variables no se habilita a NADIE', () => {
    for (const vacio of [undefined, null, '']) {
      expect(parseTestPhones(vacio), String(vacio)).toEqual([]);
    }
    // Y la lista vacía significa nadie, jamás todos.
    expect(evaluateAgentEligibility(TEST_PHONE, config({ testPhones: parseTestPhones(null) }))).toBe(
      'phone_not_allowed',
    );
  });
});

// ── MODO DE ACCESO — demo abierta controlada (18-08-2026) ──────────────────

/** Un teléfono real cualquiera: NO está en ninguna lista. */
const TERCERO = '59170000001';

describe('accessMode — allowlist sigue siendo un conjunto cerrado', () => {
  const dos = () => config({ accessMode: 'allowlist' as const, testPhones: [TEST_PHONE, SEGUNDO_PHONE] });

  it('permite el PRIMER teléfono', () => {
    expect(evaluateAgentEligibility(TEST_PHONE, dos())).toBe('eligible');
  });

  it('permite el SEGUNDO teléfono', () => {
    expect(evaluateAgentEligibility(SEGUNDO_PHONE, dos())).toBe('eligible');
  });

  it('RECHAZA un tercero', () => {
    expect(evaluateAgentEligibility(TERCERO, dos())).toBe('phone_not_allowed');
  });

  it('AI_TEST_PHONE legacy sigue funcionando: un solo número por parseTestPhones', () => {
    // Es lo que hace `service.ts` cuando AI_TEST_PHONES no está definida.
    const legacy = config({
      accessMode: 'allowlist',
      testPhones: parseTestPhones('59162139119'),
    });

    expect(evaluateAgentEligibility(TEST_PHONE, legacy)).toBe('eligible');
    expect(evaluateAgentEligibility(SEGUNDO_PHONE, legacy)).toBe('phone_not_allowed');
  });
});

describe('accessMode — all abre la demo', () => {
  const abierto = (over: Partial<AgentEligibilityConfig> = {}) =>
    config({ accessMode: 'all' as const, ...over });

  it('permite el primer teléfono de la lista', () => {
    expect(evaluateAgentEligibility(TEST_PHONE, abierto())).toBe('eligible');
  });

  it('permite el segundo teléfono de la lista', () => {
    expect(evaluateAgentEligibility(SEGUNDO_PHONE, abierto())).toBe('eligible');
  });

  it('permite un TERCER teléfono arbitrario que no está en ninguna lista', () => {
    expect(evaluateAgentEligibility(TERCERO, abierto())).toBe('eligible');
    for (const cualquiera of ['59171234567', '5491123456789', '12025550147']) {
      expect(evaluateAgentEligibility(cualquiera, abierto()), cualquiera).toBe('eligible');
    }
  });

  it('la lista deja de consultarse: vacía o llena, da igual', () => {
    // Es lo que permite el rollback sin recordar números: la lista sigue ahí,
    // simplemente no se mira.
    expect(evaluateAgentEligibility(TERCERO, abierto({ testPhones: [] }))).toBe('eligible');
    expect(
      evaluateAgentEligibility(TERCERO, abierto({ testPhones: [TEST_PHONE, SEGUNDO_PHONE] })),
    ).toBe('eligible');
  });

  it('un teléfono VACÍO sigue rechazado: sin identidad no hay a quién contestar', () => {
    // Ni siquiera la demo abierta atiende a un mensaje sin número: todo el
    // resto del turno —conversación, idempotencia, envío— cuelga de él.
    expect(evaluateAgentEligibility('', abierto())).toBe('phone_not_allowed');
  });
});

describe('accessMode — los interruptores mandan sobre el modo', () => {
  it('AI_ENABLED=false bloquea también en modo all', () => {
    expect(
      evaluateAgentEligibility(TERCERO, config({ accessMode: 'all', enabled: false })),
    ).toBe('disabled');
  });

  it('sin clave de OpenAI, modo all tampoco llama a nadie', () => {
    expect(
      evaluateAgentEligibility(TERCERO, config({ accessMode: 'all', hasApiKey: false })),
    ).toBe('not_configured');
  });
});

describe('parseAccessMode — abrir es explícito, cerrar es el default', () => {
  it('solo la cadena exacta "all" abre', () => {
    expect(parseAccessMode('all')).toBe('all');
  });

  it('AUSENTE => allowlist', () => {
    expect(parseAccessMode(undefined)).toBe('allowlist');
    expect(parseAccessMode(null)).toBe('allowlist');
  });

  it('VACÍO => allowlist', () => {
    expect(parseAccessMode('')).toBe('allowlist');
    expect(parseAccessMode('   ')).toBe('allowlist');
  });

  it('INVÁLIDO => allowlist, nunca se abre por accidente', () => {
    // Mayúsculas, sinónimos, valores de otra variable, typos: todos cierran.
    for (const raro of [
      'ALL',
      'All',
      ' all',
      'all ',
      'todos',
      'true',
      '1',
      'allowlist',
      'open',
      'public',
      'a',
      'null',
      'undefined',
    ]) {
      expect(parseAccessMode(raro), raro).toBe('allowlist');
    }
  });

  it('el modo por defecto atiende exactamente a la lista, ni más ni menos', () => {
    const porDefecto = config({
      accessMode: parseAccessMode(undefined),
      testPhones: parseTestPhones('59162139119,59172654203'),
    });

    expect(evaluateAgentEligibility(TEST_PHONE, porDefecto)).toBe('eligible');
    expect(evaluateAgentEligibility(SEGUNDO_PHONE, porDefecto)).toBe('eligible');
    expect(evaluateAgentEligibility(TERCERO, porDefecto)).toBe('phone_not_allowed');
  });

  it('ninguna combinación de listas vacías abre el agente', () => {
    // El accidente que este diseño existe para impedir: borrar AI_TEST_PHONES
    // y que "sin lista" pasara a significar "todos".
    for (const raw of [undefined, null, '', ' , , ']) {
      const cfg = config({
        accessMode: parseAccessMode(undefined),
        testPhones: parseTestPhones(raw),
      });
      expect(evaluateAgentEligibility(TERCERO, cfg), String(raw)).toBe('phone_not_allowed');
    }
  });
});
