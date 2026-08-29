/**
 * El cliente que no consigue pedir — módulo PURO.
 *
 * ── Qué problema resuelve, y por qué no se le pregunta al modelo ────────────
 *
 * Un cliente que se queja se detecta leyéndolo. Un cliente que se ATASCA, no:
 * no dice nada, escribe una y otra vez, y se va. Es el fallo más caro de esta
 * migración justamente porque es silencioso — nadie reclama, solo deja de
 * pedir.
 *
 * Pero deja una huella perfectamente contable: **muchos mensajes suyos y ni un
 * pedido creado**. Eso no hay que interpretarlo, se cuenta. Cero tokens, cero
 * llamadas a OpenAI, y el mismo resultado cada vez.
 *
 * ── Antes se contaban MENÚS, y era demasiado estrecho ──────────────────────
 *
 * La primera versión disparaba con tres menús enviados en 45 minutos sin
 * pedido. Sonaba razonable y no cubría la realidad: el 29-08-2026 se probaron
 * tres conversaciones en las que el cliente se trababa —preguntando el precio
 * del envío, mandando un link de Google Maps en vez del pin— y en ninguna
 * llegó a pedir el menú tres veces. El detector no habría saltado ni una vez.
 *
 * El menú era un proxy del esfuerzo del cliente, y un proxy pobre: alguien
 * puede pelearse veinte mensajes con el bot sin volver a pedirlo. Lo que mide
 * el atasco de verdad es cuánto escribió sin conseguir nada.
 *
 * Contar mensajes además SUBSUME el caso viejo —tres menús implican al menos
 * tres mensajes suyos— así que no se pierde cobertura, se gana. Y desaparece
 * el segundo umbral, que era la garantía de que los dos acabaran divergiendo.
 *
 * ── Por qué el cruce con pedidos va por WAMID y no por teléfono ────────────
 *
 * Lo natural sería buscar los pedidos de ese teléfono. No sirve:
 * `orders.customer_phone` NO está normalizado —el propio código aplica
 * `normalizePhone` cada vez que lo compara—, así que una consulta directa
 * fallaría en silencio y este detector diría "no ha pedido nunca" de un
 * cliente que pidió tres veces.
 *
 * ── Por qué esto NO es un castigo ──────────────────────────────────────────
 *
 * No se le niega nada a nadie ni se le deja de contestar. Lo que hace este
 * detector es avisar a una persona mientras la conversación sigue, porque a
 * los seis mensajes sin pedido el problema ya no lo va a resolver el séptimo.
 */

/** Mensajes del cliente que hacen falta para avisar a una persona. */
export const STUCK_CUSTOMER_MESSAGES = 6;

/** Cuánto atrás se mira. Cubre una conversación, no una jornada entera. */
export const STUCK_WINDOW_MINUTES = 30;

export interface StuckCustomerInput {
  /** Mensajes que escribió el cliente dentro de la ventana. */
  messages: number;
  /** ¿Alguno de esos mensajes acabó en un pedido creado? */
  hasOrder: boolean;
}

/**
 * ¿Este cliente lleva rato sin conseguir pedir?
 *
 * Un solo pedido creado en la ventana lo descarta entero: quien ya pidió una
 * vez sabe usar el sistema, y si sigue escribiendo es por otra cosa.
 * Confundir eso con un atasco despertaría a alguien por un buen cliente.
 */
export function isStuckCustomer(input: StuckCustomerInput): boolean {
  if (input.hasOrder) return false;
  return input.messages >= STUCK_CUSTOMER_MESSAGES;
}
