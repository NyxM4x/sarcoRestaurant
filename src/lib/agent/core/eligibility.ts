import { normalizePhone } from '@/lib/phone';

/**
 * Puerta de elegibilidad del agente — módulo puro (Fase 6D.2F.3).
 *
 * Se evalúa ANTES de tocar la base y mucho antes de OpenAI. Es la primera de
 * las dos barreras: aquí se decide si este cliente concreto entra siquiera en
 * el circuito del agente.
 *
 * Hasta la demo abierta el despliegue era deliberadamente diminuto: una lista
 * CERRADA de teléfonos, por coincidencia EXACTA sobre dígitos normalizados.
 * Nada de prefijos ni comodines — un error de configuración no puede acabar
 * respondiendo a clientes reales por accidente.
 *
 * ── Abrir el agente es una DECISIÓN, no una omisión (18-08-2026) ────────────
 *
 * Para hacer demos con clientes hace falta que conteste a cualquiera que
 * escriba. La forma peligrosa de conseguirlo sería borrar `AI_TEST_PHONES` y que
 * "sin lista" pasara a significar "todos": entonces una variable perdida en un
 * despliegue, un typo o un rollback a medias abriría el agente al mundo sin que
 * nadie lo hubiera pedido.
 *
 * Por eso hay un modo EXPLÍCITO y separado. Ninguna combinación de listas
 * vacías, variables ausentes o valores raros abre nada: solo lo abre alguien
 * escribiendo `AI_ACCESS_MODE=all`. Y la lista sigue leyéndose aunque el modo la
 * ignore, para que volver atrás sea cambiar una palabra.
 */

/**
 * A quién atiende el agente.
 *
 *   allowlist  solo los teléfonos de la lista. Es el valor por omisión y el
 *              único al que se llega sin decirlo.
 *   all        cualquier teléfono de cliente. Demo abierta controlada: las
 *              demás barreras (pausa, takeover, rutas determinísticas,
 *              idempotencia) siguen intactas.
 */
export type AgentAccessMode = 'allowlist' | 'all';

export interface AgentEligibilityConfig {
  /** Interruptor general. Solo `true` enciende el agente. */
  enabled: boolean;
  /**
   * A quién se atiende. OBLIGATORIO a propósito: un campo opcional con valor
   * por defecto es un campo que alguien puede olvidar, y el olvido tendría que
   * leerse en el código de otro módulo para saber qué hace.
   */
  accessMode: AgentAccessMode;
  /**
   * Teléfonos admitidos, ya normalizados a dígitos. Lista VACÍA = nadie.
   *
   * Es una lista y no un `string | null` desde que hacen falta dos números de
   * prueba. Que el caso "nadie" sea la lista vacía —y no un `null` que hay que
   * acordarse de comprobar— es lo que mantiene el fail-closed por construcción.
   *
   * En modo `all` se IGNORA, pero se sigue leyendo: es lo que hace que volver a
   * `allowlist` no necesite recordar ningún número.
   */
  testPhones: readonly string[];
  /** ¿Hay clave de OpenAI configurada? Sin ella no se intenta llamar. */
  hasApiKey: boolean;
}

export type AgentEligibility =
  | 'eligible'
  /** `AI_ENABLED` apagado: cero llamadas a OpenAI, cero runs. */
  | 'disabled'
  /** Falta la clave: se trata como apagado, no como error. */
  | 'not_configured'
  /** Encendido, pero este teléfono no está en la lista de prueba. */
  | 'phone_not_allowed';

/**
 * Lee la allowlist de teléfonos desde su forma de entorno: números separados
 * por coma.
 *
 * Reglas, todas en la dirección de no habilitar de más:
 *
 *   · se recortan los espacios de cada entrada — `"a, b"` y `"a,b"` son iguales
 *   · las entradas vacías se ignoran, así que una coma suelta o final no cuenta
 *   · cada número pasa por `normalizePhone`, el MISMO formato con el que llega
 *     el teléfono del cliente; comparar formatos distintos sería no comparar
 *   · lo que tras normalizar no deja dígitos se descarta: una entrada basura no
 *     puede convertirse en `''` y empatar con un teléfono ilegible
 *   · sin valor, lista vacía — y lista vacía es NADIE, nunca "todos"
 */
export function parseTestPhones(raw: string | null | undefined): string[] {
  if (!raw) return [];

  const permitidos: string[] = [];
  for (const entrada of raw.split(',')) {
    const digitos = normalizePhone(entrada.trim());
    if (digitos !== '' && !permitidos.includes(digitos)) permitidos.push(digitos);
  }
  return permitidos;
}

/**
 * Lee el modo de acceso desde su forma de entorno.
 *
 * SOLO la cadena exacta `'all'` abre el agente. Todo lo demás —ausente, vacía,
 * `'ALL'`, `'true'`, `'todos'`, un typo— cae en `allowlist`.
 *
 * Es la misma disciplina que `AI_ENABLED === 'true'`, y por el mismo motivo: un
 * valor que no se entiende NO puede interpretarse como permiso. Aquí el error
 * caro es asimétrico —dejar entrar a quien no debía es peor que dejar fuera a
 * quien sí— así que la ambigüedad se resuelve siempre hacia el lado cerrado.
 */
export function parseAccessMode(raw: string | null | undefined): AgentAccessMode {
  return raw === 'all' ? 'all' : 'allowlist';
}

/**
 * Decide si un mensaje entrante puede llegar al agente.
 *
 * Un `no` NO crea `agent_runs`: la tabla mide ejecuciones del agente, y si se
 * anotara cada mensaje de cada cliente mientras el despliegue está limitado,
 * dejaría de significar nada.
 *
 * ── Lo que este `sí` NO concede ─────────────────────────────────────────────
 *
 * Es la PRIMERA barrera, no la única. Después vienen, en este orden: datos
 * mínimos, tipo de contenido, conversación existente, claim de idempotencia y
 * pausa por takeover humano. Abrir el modo mueve exactamente una de esas
 * puertas — las otras cinco siguen donde estaban.
 */
export function evaluateAgentEligibility(
  customerPhone: string,
  config: AgentEligibilityConfig,
): AgentEligibility {
  if (!config.enabled) return 'disabled';
  if (!config.hasApiKey) return 'not_configured';
  // Un teléfono vacío no es una identidad, y sin identidad no hay a quién
  // contestar. Va ANTES del modo: ni siquiera la demo abierta atiende a nadie
  // sin número, porque el resto del turno depende de él.
  if (customerPhone === '') return 'phone_not_allowed';

  // Demo abierta: cualquier cliente con número. La lista no se consulta.
  if (config.accessMode === 'all') return 'eligible';

  if (config.testPhones.length === 0) return 'phone_not_allowed';
  // Coincidencia exacta sobre dígitos: sin prefijos ni "empieza por".
  return config.testPhones.includes(customerPhone) ? 'eligible' : 'phone_not_allowed';
}
