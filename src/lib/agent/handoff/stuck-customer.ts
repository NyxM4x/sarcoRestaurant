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
 * Pero deja una huella contable, y contar no cuesta tokens.
 *
 * ── Volumen NO es atasco (29-08-2026) ──────────────────────────────────────
 *
 * La primera versión contaba menús enviados; la segunda, mensajes del cliente
 * a secas. Las dos estaban mal, y la segunda saltó en un pedido que terminó
 * PAGADO:
 *
 *   "Hola don Zarco quiero pedir" · "2 lomitos quería" · "Si envíeme 2
 *   lomitos" · ubicación · ubicación · comprobante  →  seis mensajes, alerta.
 *
 * Ese cliente hizo todo bien. Un pedido normal —saludo, intento, menú,
 * ubicación, comprobante— gasta seis o siete mensajes sin ningún problema, así
 * que un contador a secas dispara una alerta falsa por cada pedido que entra.
 * Cien pedidos, cien alertas, y a la tercera nadie mira el grupo.
 *
 * ── Las tres condiciones, y por qué las tres ───────────────────────────────
 *
 * Contar es lo ÚLTIMO que se hace, no lo primero:
 *
 *   1. HAY PROGRESO → no está atascado, se acabó. Un pedido creado o un
 *      comprobante enviado son pruebas de que el sistema le funcionó.
 *   2. NO RECIBIÓ EL MENÚ → no está atascado, está empezando. Sin la
 *      herramienta en la mano no se le puede reprochar no usarla, y avisar
 *      aquí sería avisar por cada conversación que arranca.
 *   3. Solo entonces, el VOLUMEN. Ocho mensajes con el menú delante y sin un
 *      solo avance es alguien peleándose con algo.
 *
 * El orden importa: son tres puertas, y las dos primeras son las que impiden
 * que un cliente productivo llegue nunca a la tercera.
 */

/**
 * Mensajes del cliente que hacen falta para avisar a una persona.
 *
 * Ocho y no seis: un pedido completo —saludo, dos intentos, ubicación,
 * ubicación corregida, comprobante— llega a seis o siete sin nada anómalo, y
 * ese margen es justo el que hay que dejar por encima.
 */
export const STUCK_CUSTOMER_MESSAGES = 8;

/** Cuánto atrás se mira. Cubre una conversación, no una jornada entera. */
export const STUCK_WINDOW_MINUTES = 30;

export interface StuckCustomerInput {
  /** Mensajes que escribió el cliente dentro de la ventana. */
  messages: number;
  /**
   * Menús que le llegaron. Cero significa que todavía no tiene la herramienta:
   * es una conversación empezando, no un atasco.
   */
  menusSent: number;
  /**
   * ¿Consta algún avance real? Un pedido creado o un comprobante recibido.
   *
   * Es la puerta que faltaba funcionando: se cruzaba por
   * `orders.source_message_id`, y el checkout web lo inserta NULL, así que
   * ningún pedido hecho desde el menú contaba jamás como progreso.
   */
  hasProgress: boolean;
}

/**
 * ¿Este cliente lleva rato sin conseguir pedir?
 *
 * Cualquier progreso lo descarta entero: quien pidió o pagó sabe usar el
 * sistema, y confundir eso con un atasco despierta a alguien por un buen
 * cliente — que es la forma más rápida de que dejen de mirar las alertas.
 */
export function isStuckCustomer(input: StuckCustomerInput): boolean {
  if (input.hasProgress) return false;
  if (input.menusSent < 1) return false;
  return input.messages >= STUCK_CUSTOMER_MESSAGES;
}
