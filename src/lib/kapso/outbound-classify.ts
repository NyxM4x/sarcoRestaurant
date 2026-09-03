/**
 * Clasificador ÚNICO de mensajes salientes por su forma/contenido (Fase 6D.2C).
 *
 * Reemplaza la heurística anterior "text → confirmation", que colisionaba con el
 * nuevo mensaje `order_received` (también texto). Es la fuente compartida por la
 * reconciliación por HISTORIAL (`message-history.ts`) y por WEBHOOK
 * (`outbound-event.ts`), de modo que ambas rutas clasifican EXACTAMENTE igual:
 * sin dos regex que puedan divergir.
 *
 * Módulo hoja: no importa Kapso, Supabase ni notify-text (evita ciclos). Las
 * marcas canónicas del copy viven aquí y `notify-text.ts` las CONSUME para
 * construir los mensajes, garantizando paridad builder ↔ clasificador.
 */

export type OutboundMessageType = 'order_received' | 'confirmation' | 'location_request' | 'unknown';

// ── Marcas canónicas del copy (fuente única; los builders las reutilizan) ─────

/** Prefijo EXACTO del mensaje de recepción (6D.2C). Sigue de `ORD-XXXXXX`. */
export const ORDER_RECEIVED_PREFIX = '📦 Recibimos tu pedido ';

/** Prefijo del encabezado de la confirmación de delivery DINÁMICO (6D.2C). */
export const DYNAMIC_CONFIRMATION_PREFIX = '📦 Pedido ';

/** Etiquetas obligatorias de la confirmación dinámica (comida/envío/total). */
export const CONFIRMATION_FOOD_LABEL = 'Comida:';
export const CONFIRMATION_DELIVERY_LABEL = 'Delivery:';
export const CONFIRMATION_TOTAL_LABEL = 'Total:';

/**
 * Marca de las confirmaciones LEGACY (`buildConfirmationText`: pickup y delivery
 * legacy empiezan con «📦 ¡Recibí tu pedido …»). Se reconoce para no romper la
 * reconciliación de los pedidos que no son dynamic.
 */
export const LEGACY_CONFIRMATION_MARKER = '¡Recibí tu pedido';

/**
 * Tipo de interactivo nativo de la solicitud de ubicación.
 *
 * Se conserva aunque ya no se envíe así: el historial de Kapso sigue teniendo
 * los mensajes de antes del 03-09-2026, y una reconciliación que mire hacia
 * atrás tiene que seguir reconociéndolos.
 */
export const LOCATION_REQUEST_INTERACTIVE_TYPE = 'location_request_message';

/**
 * Instrucción de la petición de ubicación — y, desde que dejó de ser un botón,
 * también su MARCA.
 *
 * Vive aquí con el resto de marcas canónicas y el builder la consume, que es lo
 * que garantiza la paridad: si alguien reescribe la instrucción, el clasificador
 * la sigue reconociendo porque es literalmente la misma constante.
 *
 * Sin esto, la petición en texto plano se clasificaba `unknown` y la
 * reconciliación dejaba de emparejarla: un envío ambiguo se habría reintentado
 * y el cliente habría recibido la petición dos veces.
 */
export const LOCATION_HOW_TO_TEXT =
  'Toca el clip 📎 → Ubicación → ENVIAR UBICACIÓN ACTUAL';

/** Entrada normalizada para clasificar, común a historial y webhook. */
export interface OutboundClassifyInput {
  /** Tipo del mensaje de WhatsApp: 'text' | 'image' | 'interactive' | otro. */
  messageKind: string | null;
  /** `interactive.type` cuando aplica (p. ej. 'location_request_message'). */
  interactiveType: string | null;
  /** Texto relevante: body del texto, body del interactivo o caption de la imagen. */
  bodyText: string | null;
  /** Número de pedido extraído del cuerpo/caption (token de emparejamiento). */
  orderNumber: string | null;
}

/** `true` si el cuerpo es una confirmación dinámica (encabezado + 3 etiquetas). */
function isDynamicConfirmationBody(body: string): boolean {
  return (
    body.includes(DYNAMIC_CONFIRMATION_PREFIX) &&
    body.includes(CONFIRMATION_FOOD_LABEL) &&
    body.includes(CONFIRMATION_DELIVERY_LABEL) &&
    body.includes(CONFIRMATION_TOTAL_LABEL)
  );
}

/**
 * Clasifica de forma DETERMINISTA un saliente. Orden de reglas:
 *   1. interactivo `location_request_message`, o cuerpo con la instrucción de
 *      cómo mandar la ubicación → location_request;
 *   2. cuerpo que empieza por la marca de recepción → order_received;
 *   3. texto/imagen con `ORD-XXXXXX` y forma de confirmación (dinámica o legacy)
 *      → confirmation;
 *   4. cualquier otra cosa → unknown (NUNCA se inventa un tipo).
 *
 * Un texto genérico SIN forma reconocible NO es confirmation (a diferencia de la
 * heurística anterior). El mensaje best-effort de fuera de cobertura (sin
 * `ORD-`) queda `unknown` y por tanto nunca contamina una reconciliación.
 */
export function classifyOutboundType(input: OutboundClassifyInput): OutboundMessageType {
  // 1. Solicitud de ubicación: por su tipo interactivo nativo (los de antes del
  //    03-09-2026) o por su instrucción (los de ahora, que van en texto plano).
  if (input.interactiveType === LOCATION_REQUEST_INTERACTIVE_TYPE) {
    return 'location_request';
  }

  const body = input.bodyText ?? '';

  // Va ANTES que las demás: la petición web lleva `ORD-XXXXXX` en el cuerpo, y
  // dejarla caer hasta la regla de confirmación sería jugarse el emparejamiento
  // a que ninguna otra forma coincida antes.
  if (body.includes(LOCATION_HOW_TO_TEXT)) {
    return 'location_request';
  }

  // 2. Recepción: prefijo canónico explícito (se evalúa ANTES de confirmation).
  if (body.startsWith(ORDER_RECEIVED_PREFIX) || body.includes(ORDER_RECEIVED_PREFIX)) {
    return 'order_received';
  }

  // 3. Confirmación final: exige número de pedido y forma (dinámica o legacy).
  const isTextOrImage = input.messageKind === 'text' || input.messageKind === 'image';
  if (isTextOrImage && input.orderNumber !== null) {
    if (isDynamicConfirmationBody(body) || body.includes(LEGACY_CONFIRMATION_MARKER)) {
      return 'confirmation';
    }
  }

  // 4. Nada reconocible.
  return 'unknown';
}
