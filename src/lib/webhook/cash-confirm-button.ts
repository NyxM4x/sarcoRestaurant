import {
  CASH_CANCEL_BUTTON_PREFIX,
  CASH_CONFIRM_BUTTON_PREFIX,
} from '@/lib/kapso/messages';

/**
 * El botón que tocó el cliente en el pedido en efectivo — módulo PURO.
 *
 * ── Por qué existe este archivo ─────────────────────────────────────────────
 *
 * Hasta el 13-09-2026 el webhook no veía los botones. `extractTextBody` devuelve
 * `null` para todo lo que no sea `type: 'text'`, y de ahí cuelga la cascada
 * entera —menú, envío, ubicación, CONFIRMO—, así que un `button_reply` entraba
 * y no lo leía nadie: ni los detectores ni el modelo, porque un button_reply
 * tampoco trae `body.text`. Mandar los botones sin esto habría sido peor que no
 * mandarlos: el cliente toca y no pasa nada.
 *
 * ── Esto NO es un detector de lenguaje ──────────────────────────────────────
 *
 * Es lo contrario, y por eso es tan corto. Los otros módulos de esta carpeta
 * adivinan intención a partir de palabras que escribe una persona con prisa;
 * aquí se lee un identificador que ESCRIBIMOS NOSOTROS al mandar el mensaje.
 * No hay nada que interpretar: el id coincide o no coincide.
 *
 * ── El número de pedido viaja dentro del id ─────────────────────────────────
 *
 * `cash_confirm:ORD-260913-047`. En WhatsApp se puede subir el chat y tocar el
 * botón de un mensaje de anoche, así que "¿de qué pedido me habla?" tiene que
 * poder responderse con el mensaje delante. Quien llama comprueba que ese
 * número sea el del pedido que hoy espera confirmación; si no lo es, el toque
 * no decide nada.
 */

export type CashButtonDecision = 'confirm' | 'cancel';

export interface CashButtonPress {
  decision: CashButtonDecision;
  /** El pedido al que se refiere el botón, tal como se mandó. */
  orderNumber: string;
}

function rec(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/**
 * El id del botón pulsado, o `null` si este mensaje no es un botón.
 *
 * Se mira en los dos sitios en que puede venir —dentro de `interactive` y, por
 * si el proveedor lo aplana, en la raíz— igual que hace `flow/nfm.ts` con el
 * `nfm_reply`. Es tolerancia al transporte, no a los datos: el id, esté donde
 * esté, se compara igual de estricto.
 */
function buttonReplyId(message: Record<string, unknown> | undefined): string | null {
  if (!message) return null;

  const interactive = rec(message.interactive);
  const anidado = str(rec(interactive?.button_reply)?.id);
  if (anidado !== null) return anidado;

  return str(rec(message.button_reply)?.id);
}

/**
 * Qué decidió el cliente con el botón, o `null` si el mensaje no lleva ninguno
 * de los nuestros.
 *
 * `null` NO significa "no decidió": significa que esto no era un botón de este
 * flujo, y el mensaje sigue su camino por la cascada de siempre. Un botón de
 * otro flujo —o de otra versión del mensaje— cae aquí y no se inventa nada.
 */
export function readCashDecisionButton(
  message: Record<string, unknown> | undefined,
): CashButtonPress | null {
  const id = buttonReplyId(message);
  if (id === null) return null;

  if (id.startsWith(CASH_CONFIRM_BUTTON_PREFIX)) {
    const orderNumber = id.slice(CASH_CONFIRM_BUTTON_PREFIX.length).trim();
    return orderNumber === '' ? null : { decision: 'confirm', orderNumber };
  }

  if (id.startsWith(CASH_CANCEL_BUTTON_PREFIX)) {
    const orderNumber = id.slice(CASH_CANCEL_BUTTON_PREFIX.length).trim();
    return orderNumber === '' ? null : { decision: 'cancel', orderNumber };
  }

  return null;
}
