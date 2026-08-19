/**
 * Clasificación de fallos del checkout — módulo puro.
 *
 * Traduce la respuesta de `POST /api/store/orders` a algo que la UI pueda
 * mostrar y sobre lo que pueda decidir. Nunca expone cuerpos crudos, SQLSTATE,
 * stack traces ni datos de la sesión.
 *
 * La distinción clave es `ambiguous`: cuando la petición pudo haber creado el
 * pedido sin que lleguemos a saberlo (red caída, timeout, 500, respuesta
 * ilegible). En ese caso el único reintento seguro es el del pedido idéntico:
 * si ya se creó, el backend devuelve 200 con `created: false` gracias al
 * fingerprint. Reintentar con un carrito distinto daría 409.
 */

/** Qué puede hacer el usuario después del fallo. */
export type CheckoutRecovery =
  /** Terminal: el enlace ya no sirve. Solo volver a WhatsApp. */
  | 'none'
  /** Corregir campos y volver a enviar. */
  | 'fix_form'
  /** Ajustar el carrito y volver a enviar. */
  | 'fix_cart'
  /** Reintentar exactamente el mismo pedido (resultado ambiguo). */
  | 'retry_same';

export type CheckoutFailureKind =
  | 'invalid_json'
  | 'invalid_session'
  | 'session_already_used'
  | 'validation_error'
  | 'product_unavailable'
  | 'internal_error'
  | 'network_error'
  | 'timeout'
  | 'unreadable_response'
  | 'unknown_error';

export interface CheckoutFieldIssue {
  field: string;
  message: string;
}

export interface CheckoutFailure {
  kind: CheckoutFailureKind;
  /** Texto seguro para mostrar al usuario. */
  message: string;
  recovery: CheckoutRecovery;
  /**
   * `true` si el pedido pudo haberse creado pese al fallo. Obliga a reintentar
   * el pedido idéntico y a congelar el formulario y el carrito.
   */
  ambiguous: boolean;
  /** Errores por campo del 422 `validation_error`. */
  issues?: CheckoutFieldIssue[];
}

// ── Textos por defecto ──────────────────────────────────────────────────────

const GENERIC_MESSAGE = 'No pudimos registrar tu pedido. Intenta de nuevo en un momento.';
const NETWORK_MESSAGE = 'Revisa tu conexión e intenta de nuevo.';
const TIMEOUT_MESSAGE = 'La conexión tardó demasiado. Intenta de nuevo.';
const SESSION_INVALID_MESSAGE =
  'Este enlace ya no es válido. Vuelve a WhatsApp y solicita nuevamente el menú.';
const SESSION_USED_MESSAGE =
  'Este enlace ya fue utilizado. Vuelve a WhatsApp para solicitar un nuevo enlace.';
const PRODUCT_MESSAGE = 'Uno de los productos ya no está disponible. Revisa tu pedido.';
const VALIDATION_MESSAGE = 'Revisa los datos de tu pedido.';

// ── Saneamiento de texto ────────────────────────────────────────────────────

const MAX_MESSAGE_LENGTH = 200;

/** Caracteres propios de volcados técnicos, no de prosa para el usuario. */
const FORBIDDEN_CHARS = '{}<>\\';

/**
 * Marcadores inequívocos de detalle interno: prefijo SQLSTATE (`P0001:`),
 * marcos de stack y jerga de Postgres.
 */
const TECHNICAL_PATTERNS: RegExp[] = [
  /^[0-9A-Z]{5}:/,
  /\bat\s+\w+[.(<]/i,
  /\bError:/i,
  /\bSQLSTATE\b/i,
  /\brelation\s/i,
  /\bpublic\./i,
  /\bpg_/i,
];

/** `true` si hay controles, saltos de línea o caracteres de marcado. */
function hasTechnicalChars(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0);
    if (code !== undefined && code < 0x20) return true;
    if (FORBIDDEN_CHARS.includes(char)) return true;
  }
  return false;
}

/**
 * Acepta un texto del backend solo si parece dirigido al usuario final.
 *
 * Todos los mensajes que emite `web-checkout.ts` son constantes redactadas a
 * mano, así que en la práctica siempre pasan. El filtro es defensa en
 * profundidad: si un proxy, un intermediario o un cambio futuro devolviera un
 * volcado técnico, aquí se descarta y se muestra el texto genérico en vez de un
 * SQLSTATE o un stack trace.
 */
function safeText(candidate: unknown): string | null {
  if (typeof candidate !== 'string') return null;

  const trimmed = candidate.trim();
  if (trimmed === '' || trimmed.length > MAX_MESSAGE_LENGTH) return null;
  if (hasTechnicalChars(trimmed)) return null;
  if (TECHNICAL_PATTERNS.some((pattern) => pattern.test(trimmed))) return null;

  return trimmed;
}

function safeMessage(candidate: unknown, fallback: string): string {
  return safeText(candidate) ?? fallback;
}

/** Extrae `issues` con la forma `{field, message}`, saneando cada mensaje. */
function safeIssues(candidate: unknown): CheckoutFieldIssue[] | undefined {
  if (!Array.isArray(candidate)) return undefined;

  const issues = candidate.flatMap((raw): CheckoutFieldIssue[] => {
    if (typeof raw !== 'object' || raw === null) return [];
    const { field, message } = raw as Record<string, unknown>;
    if (typeof field !== 'string' || field === '' || field.length > 64) return [];

    const safe = safeText(message);
    if (safe === null) return [];

    return [{ field, message: safe }];
  });

  return issues.length > 0 ? issues : undefined;
}

// ── Constructores de fallos sin respuesta HTTP ──────────────────────────────

/** La petición no llegó o se cortó: el pedido pudo crearse igual. */
export function networkFailure(): CheckoutFailure {
  return {
    kind: 'network_error',
    message: NETWORK_MESSAGE,
    recovery: 'retry_same',
    ambiguous: true,
  };
}

/** Se agotó el tiempo de espera: mismo razonamiento que la red. */
export function timeoutFailure(): CheckoutFailure {
  return {
    kind: 'timeout',
    message: TIMEOUT_MESSAGE,
    recovery: 'retry_same',
    ambiguous: true,
  };
}

/** Hubo respuesta, pero no pudimos interpretarla. */
export function unreadableResponseFailure(): CheckoutFailure {
  return {
    kind: 'unreadable_response',
    message: GENERIC_MESSAGE,
    recovery: 'retry_same',
    ambiguous: true,
  };
}

/**
 * Clasifica una respuesta HTTP de error.
 *
 * El mapeo se hace por `status` + campo `error`, nunca por el texto del mensaje.
 * `body` es lo que se pudo parsear; puede ser `null` si no era JSON.
 */
export function mapCheckoutFailure(status: number, body: unknown): CheckoutFailure {
  const payload = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const code = typeof payload.error === 'string' ? payload.error : null;
  const message = payload.message;

  // 401 y 409 son terminales: el enlace se agotó, reintentar no puede ayudar.
  if (status === 401 || code === 'invalid_session') {
    return {
      kind: 'invalid_session',
      message: safeMessage(message, SESSION_INVALID_MESSAGE),
      recovery: 'none',
      ambiguous: false,
    };
  }

  if (status === 409 || code === 'session_already_used') {
    return {
      kind: 'session_already_used',
      message: safeMessage(message, SESSION_USED_MESSAGE),
      recovery: 'none',
      ambiguous: false,
    };
  }

  if (status === 400) {
    // No debería ocurrir: el cliente siempre serializa el body. Se trata como
    // ambiguo porque el servidor sí recibió la petición.
    return {
      kind: 'invalid_json',
      message: GENERIC_MESSAGE,
      recovery: 'retry_same',
      ambiguous: true,
    };
  }

  if (status === 422) {
    if (code === 'product_unavailable') {
      return {
        kind: 'product_unavailable',
        message: safeMessage(message, PRODUCT_MESSAGE),
        recovery: 'fix_cart',
        ambiguous: false,
      };
    }

    return {
      kind: 'validation_error',
      message: safeMessage(message, VALIDATION_MESSAGE),
      recovery: 'fix_form',
      ambiguous: false,
      issues: safeIssues(payload.issues),
    };
  }

  if (status >= 500) {
    // El servidor recibió la petición; la RPC pudo haber hecho COMMIT.
    return {
      kind: 'internal_error',
      message: safeMessage(message, GENERIC_MESSAGE),
      recovery: 'retry_same',
      ambiguous: true,
    };
  }

  // Cualquier otro status: desconocido y por tanto ambiguo.
  return {
    kind: 'unknown_error',
    message: GENERIC_MESSAGE,
    recovery: 'retry_same',
    ambiguous: true,
  };
}
