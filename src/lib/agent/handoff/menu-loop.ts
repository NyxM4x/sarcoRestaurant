/**
 * El cliente al que le mandamos el menú y no consigue pedir — módulo PURO.
 *
 * ── Qué problema resuelve, y por qué no se le pregunta al modelo ────────────
 *
 * Un cliente que se queja se detecta leyéndolo. Un cliente que se ATASCA, no:
 * no dice nada, recibe el botón una y otra vez, y se va. Es el fallo más caro
 * de esta migración justamente porque es silencioso — nadie reclama, solo deja
 * de pedir.
 *
 * Pero deja una huella perfectamente contable: **varios menús enviados y ni un
 * pedido creado**. Eso no hay que interpretarlo, se cuenta. Cero tokens, cero
 * llamadas a OpenAI, y el mismo resultado cada vez.
 *
 * ── Por qué el cruce va por WAMID y no por teléfono ─────────────────────────
 *
 * Lo natural sería buscar los pedidos de ese teléfono. No sirve:
 * `orders.customer_phone` NO está normalizado —el propio código aplica
 * `normalizePhone` cada vez que lo compara—, así que una consulta directa
 * fallaría en silencio y este detector diría "no ha pedido nunca" de un cliente
 * que pidió tres veces.
 *
 * `menu_send_deliveries.source_message_id` y `orders.source_message_id` son en
 * cambio el MISMO espacio de identificadores: el WAMID del mensaje del cliente.
 * El cruce por ahí es exacto.
 *
 * ── Por qué esto NO es un cooldown ──────────────────────────────────────────
 *
 * El menú sale igual, siempre. A quien lo pide nunca se le niega. Lo que hace
 * este detector es avisar a una persona DESPUÉS de mandarlo, porque a la
 * tercera vez el problema ya no lo va a resolver un cuarto botón.
 */

/** Cuántos menús sin pedido hacen falta para avisar a una persona. */
export const MENU_LOOP_THRESHOLD = 3;

/** Cuánto atrás se mira. Cubre una conversación, no una jornada entera. */
export const MENU_LOOP_WINDOW_MINUTES = 45;

export interface MenuLoopInput {
  /** Menús ENVIADOS a este cliente dentro de la ventana. */
  sends: number;
  /** ¿Alguno de esos mensajes acabó en un pedido creado? */
  hasOrder: boolean;
}

/**
 * ¿Este cliente lleva rato sin conseguir pedir?
 *
 * Un solo pedido creado en la ventana lo descarta entero: quien ya pidió una
 * vez sabe usar el menú, y si vuelve a pedirlo es porque quiere pedir otra
 * cosa. Confundir eso con un atasco despertaría a alguien por un buen cliente.
 */
export function isMenuLoop(input: MenuLoopInput): boolean {
  if (input.hasOrder) return false;
  return input.sends >= MENU_LOOP_THRESHOLD;
}
