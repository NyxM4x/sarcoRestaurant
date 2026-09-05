import { normalizeIntentText } from './menu-intent';

/**
 * QUÉ CONTESTÓ A "¿QUERÉS AGREGAR ALGO MÁS?" — módulo PURO (05-09-2026).
 *
 * Antes de mandarle el botón que reabre su pedido, al cliente se le pregunta y
 * se le enseña lo que armó. Esto lee su respuesta.
 *
 * ── Por qué la pregunta se redacta EN ESE SENTIDO ───────────────────────────
 *
 * "¿Querés agregar algo más?" y no "¿está bien tu pedido?". La diferencia es
 * todo lo que hace legible un "no".
 *
 * En castellano un "no" suelto contesta a la forma de la pregunta, no al fondo.
 * Con "¿está bien tu pedido?", el "no" significa "quiero cambiarlo"; con
 * "¿querés agregar algo?", significa "así está bien". Son opuestos, y el
 * cliente del pedido #26 escribía exactamente así: "No", "??", "Xfa".
 *
 * Preguntado en este sentido, `no` es inequívoco. Por eso la pregunta no se
 * puede reescribir sin volver aquí.
 *
 * ── Y por qué hay números ───────────────────────────────────────────────────
 *
 * "Respondé 1 / Respondé 2" no es bonito, pero es lo único que no depende de
 * adivinar. El canal no ayuda: hoy el sistema NO lee las respuestas de botón de
 * WhatsApp —`extractTextBody` descarta todo lo que no sea `type: 'text'`— y el
 * único botón interactivo que hubo se quitó el 03-09-2026 porque la gente se
 * quedaba mirándolo. Un dígito llega como texto y no se presta a interpretación.
 *
 * Los sinónimos existen porque casi nadie contestará con el número.
 */

/**
 * Lo que quiso decir, o `null` si no contestó a esto.
 *
 * `null` NO es "está mal": es "esto no era una respuesta a la pregunta". El
 * mensaje sigue su camino como cualquier otro, y sobre todo NO se le vuelve a
 * preguntar. Insistir con la misma pregunta es lo que convierte una duda en una
 * conversación con una persona.
 */
export type OrderReviewReply = 'add' | 'keep' | null;

/**
 * "Sí, me falta algo." Abre el botón de modificar.
 *
 * Incluye los verbos con los que la gente dice que sí sin decir qué —"quiero
 * agregar", "me falta"—: aquí no hace falta que lo diga, porque lo va a elegir
 * en el menú.
 */
const QUIERE_AGREGAR =
  /^(1|1\.|si|sii+|sip|claro|dale|obvio|agregar|quiero agregar|quiero aumentar|aumentar|anadir|quiero anadir|modificar|quiero modificar|cambiar|quiero cambiar|me falta|me faltaba|falta|si por favor|si porfa|si quiero)$/;

/**
 * "Así está bien." Cierra: se le confirma y no se toca nada.
 *
 * `no` entra por lo que explica la cabecera: contestando a "¿querés agregar
 * algo más?", significa que no quiere agregar nada.
 */
const ASI_ESTA_BIEN =
  /^(2|2\.|no|nop|nel|nada|nada mas|ya|ya esta|listo|esta bien|asi esta bien|asi nomas|asi esta|esta ok|ok|oka|okey|todo bien|ninguno|nada menos|dejalo asi|dejalo|confirmo|confirmado|correcto)$/;

/**
 * Lee la respuesta del cliente. Ver `OrderReviewReply`.
 *
 * ── Por qué se compara la frase ENTERA ──────────────────────────────────────
 *
 * Con `^...$` y no buscando dentro. "No me llegó el QR" empieza por "no" y no
 * está contestando que su pedido esté bien; "sí, pero cuánto tarda" tampoco es
 * un "quiero agregar". Buscar dentro de la frase convertiría cualquier mensaje
 * en una respuesta, y la respuesta equivocada aquí toca el pedido.
 *
 * Lo único que se recorta antes es la cortesía del final —"porfa", "gracias",
 * "por favor"—, que no cambia el sentido de nada.
 */
export function readOrderReviewReply(text: string | null | undefined): OrderReviewReply {
  if (typeof text !== 'string') return null;

  const norm = normalizeIntentText(text)
    .replace(/[.,!¡?¿]+$/g, '')
    .replace(/(\s+(porfa|porfis|porfavor|por favor|please|gracias|grax|xfa|amigo|amiga|jefe))+$/g, '')
    .trim();

  if (norm === '') return null;
  if (QUIERE_AGREGAR.test(norm)) return 'add';
  if (ASI_ESTA_BIEN.test(norm)) return 'keep';
  return null;
}
