import { normalizeIntentText } from './menu-intent';

/**
 * "CONFIRMO" o "CANCELAR" — módulo PURO (05-09-2026).
 *
 * ── Los dos pedidos que lo motivan ──────────────────────────────────────────
 *
 * En efectivo el aviso al grupo de reparto sale al COTIZAR, porque no hay pago
 * que esperar. Pero el cliente ve el precio del envío en ese mismo instante, y
 * a veces no le gusta:
 *
 *   #40  "Delivery: Bs. 27"  →  "Muy caro su moto"  →  no volvió a escribir
 *   #39  "Delivery: Bs. 30"  →  "Cancelar pedido"   →  acabó pidiendo una persona
 *
 * Los dos ya estaban en el teléfono de quien reparte. Ahora el pedido en
 * efectivo espera un "CONFIRMO" antes de agendarse, y esto lee esa respuesta.
 *
 * ── Por qué una PALABRA y no un número ──────────────────────────────────────
 *
 * Aquí sí se le pide que escriba "CONFIRMO" o "CANCELAR" con todas las letras,
 * a diferencia de la otra pregunta del flujo (`order-review-reply`, que usa 1 y
 * 2). La diferencia es lo que está en juego: allí el error manda un botón de
 * más, y aquí agenda —o tira— un pedido. Una palabra entera no se teclea por
 * accidente, y un "1" suelto sí.
 *
 * Aun así se aceptan las formas naturales de decir lo mismo, porque la gente no
 * copia instrucciones: "confirmado", "si confirmo", "ya está", "cancelalo".
 */

/** Lo que decidió, o `null` si el mensaje no era una respuesta a esto. */
export type CashConfirmReply = 'confirm' | 'cancel' | null;

/**
 * Agendarlo. Sale al reparto y entra a cocina.
 *
 * `si` a secas entra porque la pregunta se hace en positivo —"¿confirmás tu
 * pedido?"— y porque quien contesta eso ya vio su total: no hay ambigüedad
 * sobre a qué dice que sí.
 */
const CONFIRMA =
  /^(confirmo|confirmar|confirmado|confirmada|lo confirmo|si confirmo|confirmo mi pedido|confirmo el pedido|si|sii+|sip|dale|ok|oka|okey|listo|ya|ya esta|de acuerdo|esta bien|acepto|adelante|correcto|perfecto|mandalo|enviamelo|si porfa)$/;

/**
 * Tirarlo. El pedido se cancela y no se cocina nada.
 *
 * Se aceptan menos formas que para confirmar, y a propósito: cancelar es la que
 * no tiene vuelta atrás. Lo dudoso cae en `null` y sigue su camino, donde
 * todavía puede aclararse.
 */
const CANCELA =
  /^(cancelar|cancela|cancelo|cancelalo|cancelar pedido|cancelar el pedido|cancela mi pedido|cancelo mi pedido|anular|anulalo|ya no|ya no quiero|no quiero|dejalo|olvidalo|mejor no|no gracias)$/;

/**
 * Lee la decisión del cliente. Ver `CashConfirmReply`.
 *
 * Se compara la frase ENTERA (`^...$`), con la cortesía del final recortada.
 * Buscar dentro convertiría "no quiero locoto" en una cancelación y "ya me
 * llegó el QR" en una confirmación: dos frases normales que costarían un pedido
 * cada una.
 */
export function readCashConfirmReply(text: string | null | undefined): CashConfirmReply {
  if (typeof text !== 'string') return null;

  const norm = normalizeIntentText(text)
    .replace(/[.,!¡?¿]+$/g, '')
    .replace(/(\s+(porfa|porfis|porfavor|por favor|please|gracias|grax|xfa|amigo|amiga|jefe))+$/g, '')
    .trim();

  if (norm === '') return null;
  // Cancelar se mira ANTES: "no quiero" empieza por una palabra que no está en
  // la otra lista, pero el orden deja escrito qué manda si algún día se cruzan.
  if (CANCELA.test(norm)) return 'cancel';
  if (CONFIRMA.test(norm)) return 'confirm';
  return null;
}
