import { describe, it, expect } from 'vitest';
import { canHandOff, HANDOFF_MIN_CUSTOMER_MESSAGES } from './handoff-gate';

/**
 * La puerta que le costó cuatro falsos positivos al sistema.
 *
 * Todos ocurrieron entre el mensaje 1 y el 3 de la conversación, y ninguno
 * traía queja: "hola", "cuanto me saldria delivery aqui", "Aquí cuánto cobra".
 * El umbral no sale de una intuición sobre paciencia — sale de dónde
 * ocurrieron los errores.
 */

describe('canHandOff — el umbral', () => {
  it('justo por debajo no deriva', () => {
    expect(
      canHandOff({ customerMessages: HANDOFF_MIN_CUSTOMER_MESSAGES - 1, explicitRequest: false }),
    ).toBe(false);
  });

  it('en el umbral, deriva', () => {
    expect(
      canHandOff({ customerMessages: HANDOFF_MIN_CUSTOMER_MESSAGES, explicitRequest: false }),
    ).toBe(true);
  });

  it('el primer mensaje de una conversación NUNCA deriva por sí solo', () => {
    // Es la forma exacta de tres de los cuatro fallos.
    expect(canHandOff({ customerMessages: 1, explicitRequest: false })).toBe(false);
  });

  it('el umbral deja fuera los cuatro fallos observados', () => {
    // Tres ocurrieron en el mensaje 1 y uno en el 3. Si alguien baja este
    // número a 3, este test lo dice antes que un cliente.
    for (const mensajes of [1, 2, 3]) {
      expect(canHandOff({ customerMessages: mensajes, explicitRequest: false }), `${mensajes}`).toBe(
        false,
      );
    }
  });
});

describe('canHandOff — pedir una persona no espera turno', () => {
  it('con petición explícita deriva desde el primer mensaje', () => {
    expect(canHandOff({ customerMessages: 1, explicitRequest: true })).toBe(true);
  });

  it('y deriva aunque el conteo no se haya podido hacer', () => {
    // La petición explícita no depende de contar nada: por eso el llamador ni
    // siquiera consulta la base cuando la detecta.
    expect(canHandOff({ customerMessages: null, explicitRequest: true })).toBe(true);
  });
});

describe('canHandOff — fail closed', () => {
  it('sin conteo NO se deriva', () => {
    // Un contador ciego que deja pasar todo no es una puerta, es una puerta
    // pintada. Y el coste de equivocarse aquí no es simétrico: si Supabase no
    // responde se pierde una derivación, pero el turno sigue y el cliente
    // recibe su respuesta igual.
    expect(canHandOff({ customerMessages: null, explicitRequest: false })).toBe(false);
  });

  it('cero mensajes y "no se pudo contar" se tratan igual, pero NO son lo mismo', () => {
    // Los dos frenan la derivación. La diferencia está en el log: uno es una
    // conversación que empieza y el otro es no saber, y quien mire mañana
    // tiene que poder distinguirlos.
    expect(canHandOff({ customerMessages: 0, explicitRequest: false })).toBe(false);
    expect(canHandOff({ customerMessages: null, explicitRequest: false })).toBe(false);
  });
});
