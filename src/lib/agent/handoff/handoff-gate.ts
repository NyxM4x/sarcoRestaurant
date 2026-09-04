/**
 * Qué hace falta para que el modelo pueda derivar — PURO.
 *
 * ── La puerta se invirtió el 04-09-2026 ─────────────────────────────────────
 *
 * Hasta esa noche esto contaba conversación: con cuatro mensajes del cliente en
 * seis horas, el modelo podía derivar. El umbral existía porque `request_human`
 * se disparaba en el primer "hola", y cortó ese caso — pero no el de fondo.
 *
 * Las últimas 29 derivaciones reales salieron de "😓", "?", "Okay", "Efectivo",
 * "Estoy viendo su live" y frases por el estilo (la lista entera está en
 * `problem-signal.ts`). Ninguna pedía una persona; varias eran clientes
 * intentando pedir o pagar. Todas pasaron el umbral, porque para entonces ya
 * llevaban cuatro mensajes escritos. Contar mensajes mide cuánto lleva
 * escribiendo alguien, no si le pasa algo.
 *
 * Así que el umbral se retira y en su lugar va una condición sobre el MENSAJE:
 * o pide una persona con todas las letras, o dice algo que solo una persona
 * puede arreglar. Sin ninguna de las dos, el modelo contesta y no deriva.
 *
 * ── Lo que se gana además de las alarmas ────────────────────────────────────
 *
 * El umbral tenía un coste que estaba anotado y asumido: "una queja legítima en
 * el primer mensaje —'me llegó frío'— ya no deriva al instante". Con la puerta
 * invertida, esa queja deriva en el primer mensaje, que es cuando había que
 * atenderla. La regla nueva es a la vez más estrecha y más rápida.
 *
 * ── Lo que cuesta, dicho claro ──────────────────────────────────────────────
 *
 * Un cliente con un problema real que lo escriba de una forma que no
 * reconozcamos deja de derivar al instante: recibe la respuesta del modelo y, si
 * insiste con "quiero hablar con alguien", entonces sí. Se acepta porque el daño
 * no es simétrico —callar dos horas a quien preguntaba un precio cuesta el
 * cliente— y porque la lista de señales se corrige mirando conversaciones
 * reales, que es como se escribió.
 */

export interface HandoffGateInput {
  /** ¿Pidió una persona con todas las letras? Ver `explicit-request.ts`. */
  explicitRequest: boolean;
  /**
   * ¿El mensaje trae un problema que solo una persona resuelve? Ver
   * `problem-signal.ts`: dinero mal cobrado, pedido en mal estado, queja.
   */
  problemSignal: boolean;
}

/**
 * ¿Puede derivar el modelo en este turno?
 *
 * No consulta nada: se decide con el mensaje delante. Que ya no haga falta
 * contar mensajes en la base es un efecto secundario, no el motivo — pero
 * significa que esta puerta no puede fallar por una consulta caída.
 */
export function canHandOff(input: HandoffGateInput): boolean {
  return input.explicitRequest || input.problemSignal;
}
