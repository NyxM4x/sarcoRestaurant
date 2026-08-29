/**
 * Cuánta conversación hace falta antes de que el modelo pueda derivar — PURO.
 *
 * ── Por qué existe esta puerta ──────────────────────────────────────────────
 *
 * En dos días, `request_human` derivó cuatro conversaciones que no lo
 * necesitaban, y las cuatro comparten la misma forma:
 *
 *   · "hola"                                        → mensaje 1
 *   · "hola como esta zarco cuanto me saldria..."   → mensaje 1
 *   · "cuanto sale el envio"                        → mensaje 1
 *   · "Aquí cuánto cobra"                           → mensaje 3
 *
 * Ninguna traía queja, enfado ni historial. Eran preguntas que el agente
 * debía contestar, y el modelo eligió la única casilla que le quedaba libre.
 * Se intentó cerrarlo dos veces por redacción —de la descripción y del
 * prompt— y se midió con el eval: la primera no cambió nada y la segunda lo
 * empeoró.
 *
 * Así que el freno deja de ser una instrucción y pasa a ser una condición.
 *
 * ── Por qué CUATRO ─────────────────────────────────────────────────────────
 *
 * Porque es el primer número que deja fuera los cuatro fallos observados, y
 * no uno más. No sale de una intuición sobre cuánta paciencia merece un
 * cliente: sale de dónde ocurrieron los errores.
 *
 * Lo que cuesta es real y hay que decirlo: una queja legítima en el primer
 * mensaje —"me llegó frío"— ya no deriva al instante. El cliente recibe una
 * respuesta del agente y la derivación llega dos o tres mensajes después. Se
 * acepta porque el daño no es simétrico: contestar de más a quien necesitaba
 * una persona cuesta unos minutos; callar dos horas a quien preguntaba un
 * precio cuesta el cliente.
 *
 * Y el caso que de verdad no admite espera —pedir una persona con todas las
 * letras— no pasa por aquí: lo atiende `explicit-request.ts`.
 *
 * ── Por qué SEIS HORAS ─────────────────────────────────────────────────────
 *
 * La ventana existe para que el umbral signifique "esta conversación", no
 * "este cliente". Sin ella, un habitual que escribió veinte veces la semana
 * pasada tendría derecho a derivar en su primer "hola" de hoy — que es
 * exactamente el fallo que esto viene a cerrar, con más pasos.
 *
 * Seis horas cubren de sobra una jornada de servicio (18:00 a 04:00) sin
 * arrastrar la de ayer.
 */

/** Mensajes del cliente que hacen falta antes de que el modelo pueda derivar. */
export const HANDOFF_MIN_CUSTOMER_MESSAGES = 4;

/** Cuánto atrás se cuentan esos mensajes. */
export const HANDOFF_COUNT_WINDOW_HOURS = 6;

export interface HandoffGateInput {
  /**
   * Mensajes del cliente en la ventana. `null` = no se pudo contar.
   *
   * Se distingue de `0` a propósito: cero es una conversación que empieza, y
   * `null` es no saber. Las dos impiden derivar, pero por razones distintas y
   * merecen logs distintos.
   */
  customerMessages: number | null;
  /** ¿Pidió una persona con todas las letras? Entonces la puerta no aplica. */
  explicitRequest: boolean;
}

/**
 * ¿Puede derivar el modelo en este turno?
 *
 * FAIL-CLOSED ante un conteo indisponible: un contador ciego que deja pasar
 * todo no es una puerta, es una puerta pintada. Si Supabase no responde, lo
 * que se pierde es una derivación —y el cliente recibe igual su respuesta del
 * agente, porque el turno sigue—; lo que se evitaría perdiendo la puerta es
 * mucho peor y ya se vio cuatro veces.
 */
export function canHandOff(input: HandoffGateInput): boolean {
  if (input.explicitRequest) return true;
  if (input.customerMessages === null) return false;
  return input.customerMessages >= HANDOFF_MIN_CUSTOMER_MESSAGES;
}
