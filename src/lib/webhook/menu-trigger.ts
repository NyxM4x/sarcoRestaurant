/**
 * Detección del mensaje que dispara el botón "Ver menú" — módulo puro.
 *
 * Fase 5.2A: sustituye por código el nodo *Send Interactive* del Workflow
 * temporal `TEST_MENU_LA_FIJA`. Solo reacciona a un texto exacto; cualquier
 * otro mensaje sigue el camino de siempre (nfm_reply, location, ignorado).
 */

/** Palabra clave temporal de prueba. Coincidencia exacta, sin distinguir caso. */
export const MENU_TRIGGER_TEXT = 'TESTMENU9842';

const NORMALIZED_TRIGGER = MENU_TRIGGER_TEXT.toLowerCase();

function rec(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined;
}

/**
 * Cuerpo de un mensaje de texto entrante, o `null` si el mensaje no es texto.
 *
 * Deliberadamente estricto: solo `type === 'text'` con `text.body` string. Ni
 * imágenes, ni audios, ni ubicaciones, ni botones, ni `nfm_reply` — esos tipos
 * no tienen `text.body` y devuelven `null` aunque traigan captions.
 */
export function extractTextBody(message: Record<string, unknown> | undefined): string | null {
  if (!message) return null;
  if (message.type !== 'text') return null;

  const text = rec(message.text);
  return typeof text?.body === 'string' ? text.body : null;
}

/**
 * ¿El mensaje viene del negocio (saliente) en vez del cliente?
 *
 * El webhook solo se suscribe a `whatsapp.message.received`, así que en la
 * práctica todo lo que llega es entrante. Aun así se comprueba un marcador
 * explícito de salida por si Kapso lo incluye: solo se bloquea cuando el
 * marcador está presente y dice "saliente"; ante su ausencia se asume entrante
 * (no se inventan campos del contrato).
 */
export function isOutboundMessage(message: Record<string, unknown> | undefined): boolean {
  if (!message) return false;
  if (message.direction === 'outbound') return true;
  if (message.from_me === true) return true;
  return false;
}

/**
 * `true` solo si el mensaje es un texto entrante cuyo contenido, tras `trim()`
 * y sin distinguir mayúsculas, es EXACTAMENTE la palabra clave.
 *
 * No se activa con "hola TESTMENU9842" ni "TESTMENU9842 hola": la comparación
 * es sobre el texto completo, no una búsqueda de subcadena.
 */
export function isMenuTriggerMessage(message: Record<string, unknown> | undefined): boolean {
  if (isOutboundMessage(message)) return false;

  const body = extractTextBody(message);
  if (body === null) return false;

  return body.trim().toLowerCase() === NORMALIZED_TRIGGER;
}
