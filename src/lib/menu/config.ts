/**
 * Qué hace falta para que el menú llegue a un cliente — módulo PURO.
 *
 * ── Por qué existe ──────────────────────────────────────────────────────────
 *
 * "No me llegó el menú" tiene ocho causas posibles y ninguna se ve desde fuera:
 * una variable que no se pegó en el panel de despliegue, una migración sin
 * aplicar, un secreto con comillas de más, o simplemente que el cliente escribió
 * algo que no dispara nada. Sin poder mirar, se cambian variables al azar y se
 * vuelve a probar — que es exactamente lo que no se puede hacer con el WhatsApp
 * del negocio en producción.
 *
 * Esto no arregla nada: dice QUÉ falta. Es el mismo patrón —y el mismo motivo—
 * que `parseDeliveryConfig`.
 *
 * ── El agente va aparte, y es importante ────────────────────────────────────
 *
 * El envío del menú NO depende de la IA. La ruta determinística reconoce frases
 * como "menu" o "quiero pedir" y despacha el CTA sin llamar a OpenAI ni una vez.
 * Por eso el resultado separa los dos bloques: se puede tener el menú perfecto y
 * el agente apagado, y es el estado normal antes de encender la IA.
 */

/** Variables sin las que el menú NO puede salir. */
export const MENU_REQUIRED_VARS = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  /** Base de la URL del menú que se le manda al cliente. */
  'APP_BASE_URL',
  /** Firma del token de sesión del menú. */
  'MENU_SESSION_SECRET',
  /** Credencial para enviar por WhatsApp. */
  'KAPSO_API_KEY',
  /** Número por el que se envía cuando el evento no lo trae. */
  'KAPSO_PHONE_NUMBER_ID',
  /** Sin esto el webhook rechaza TODO lo que entra: ni siquiera llega el mensaje. */
  'KAPSO_WEBHOOK_SECRET',
] as const;

export type MenuRequiredVar = (typeof MENU_REQUIRED_VARS)[number];

/** Forma de una variable, sin revelar jamás su contenido. */
export interface VarShape {
  present: boolean;
  /** Longitud del valor. Delata el pegado a medias o con comillas. */
  length?: number;
  /**
   * ¿Tiene espacios al principio o al final, o comillas envolviéndolo?
   *
   * Es EL error clásico de pegar un secreto en un panel web, es invisible al
   * mirarlo, y rompe la comparación de firmas sin dar ningún síntoma útil.
   */
  suspicious?: boolean;
}

export interface MenuConfigReport {
  /** ¿Puede salir el menú con esta configuración? */
  ok: boolean;
  /** Variables que faltan, por nombre. */
  missing: MenuRequiredVar[];
  /** Forma de cada variable requerida. */
  vars: Record<MenuRequiredVar, VarShape>;
  agent: AgentConfigReport;
}

export interface AgentConfigReport {
  /**
   * ¿Contestaría el agente a un cliente cualquiera?
   *
   * Las tres condiciones a la vez: interruptor, clave y modo abierto. Es lo que
   * responde "¿por qué no me contesta?" de un vistazo.
   */
  wouldAnswerAnyone: boolean;
  /** `AI_ENABLED === 'true'`. Cualquier otro valor es apagado. */
  enabled: boolean;
  /** `'all'` o `'allowlist'`. Solo la cadena exacta `all` abre. */
  accessMode: 'all' | 'allowlist';
  /** Cuántos teléfonos hay en la lista (los números NO se devuelven). */
  allowlistCount: number;
  hasApiKey: boolean;
  /** Modelo configurado, o el que se usaría por defecto. */
  model: string | null;
}

/** Lee la forma de una variable sin exponer su valor. */
export function shapeOf(value: string | undefined): VarShape {
  if (value === undefined || value === '') return { present: false };
  const sospechoso =
    value !== value.trim() ||
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"));
  return { present: true, length: value.length, suspicious: sospechoso };
}

/** Cuenta las entradas útiles de una lista separada por comas. */
function contarLista(raw: string | undefined): number {
  if (!raw) return 0;
  return raw.split(',').filter((e) => e.trim() !== '').length;
}

/**
 * Evalúa la configuración TAL COMO LA VE EL SERVIDOR.
 *
 * Recibe el entorno como argumento —no lo lee de `process.env`— para poder
 * probar cada combinación sin tocar variables globales.
 */
export function parseMenuPipelineConfig(env: Record<string, string | undefined>): MenuConfigReport {
  const vars = {} as Record<MenuRequiredVar, VarShape>;
  const missing: MenuRequiredVar[] = [];
  for (const name of MENU_REQUIRED_VARS) {
    const shape = shapeOf(env[name]);
    vars[name] = shape;
    if (!shape.present) missing.push(name);
  }

  const enabled = env.AI_ENABLED === 'true';
  const accessMode = env.AI_ACCESS_MODE === 'all' ? 'all' : 'allowlist';
  const hasApiKey = Boolean(env.OPENAI_API_KEY);

  return {
    ok: missing.length === 0,
    missing,
    vars,
    agent: {
      // Con `allowlist` contesta solo a los de la lista, así que "a cualquiera"
      // es falso aunque todo lo demás esté bien. Es la pregunta que se hace
      // quien prueba con su propio teléfono y no recibe nada.
      wouldAnswerAnyone: enabled && hasApiKey && accessMode === 'all',
      enabled,
      accessMode,
      allowlistCount: contarLista(env.AI_TEST_PHONES),
      hasApiKey,
      model: env.OPENAI_MODEL || null,
    },
  };
}
