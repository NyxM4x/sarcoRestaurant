/**
 * El chat de WhatsApp del NEGOCIO, como enlace `wa.me` — módulo PURO
 * (19-09-2026).
 *
 * ── Para qué ────────────────────────────────────────────────────────────────
 *
 * Es el único botón de la pantalla de "Pedido registrado". Antes era "Volver al
 * menú", y volver al menú dejaba el carrito vacío y listo para armar otro: quien
 * no veía llegar el mensaje del QR —notificaciones silenciadas, "no molestar"—
 * leía eso como que el pedido no había salido, pedía otro enlace por WhatsApp y
 * lo mandaba de nuevo. Dos pedidos iguales la misma noche.
 *
 * Lo que falta después de confirmar (ubicación, QR, comprobante) pasa en el
 * chat, así que el botón lleva ahí.
 *
 * ── Sin texto precargado, a propósito ───────────────────────────────────────
 *
 * `wa.me` admite `?text=` para dejar un mensaje escrito, y aquí no se usa: el
 * bot contesta a cualquier mensaje con el botón del menú, que es justo la
 * invitación a pedir otra vez que este cambio quiere quitar. El enlace solo
 * abre la conversación; ahí ya está esperando el mensaje que pide la ubicación.
 */

/** Número boliviano sin código de país: 8 dígitos (`7xxxxxxx`, `6xxxxxxx`). */
const DIGITOS_NACIONALES = 8;
const CODIGO_BOLIVIA = '591';

/**
 * `https://wa.me/591…` a partir del número tal como se pegó en la variable de
 * entorno, o `null` si no hay número con el que armarlo.
 *
 * Acepta lo que alguien escribiría a mano: `+591 7xxx-xxxx`, `591 7xxxxxxx` o
 * solo los 8 dígitos. `wa.me` exige el código de país, y el número local sin él
 * abriría un chat con nadie; como el negocio está en Bolivia, se le antepone.
 *
 * `null` y no un enlace a medias: un botón que abre WhatsApp en ninguna parte es
 * peor que no tener botón, y la pantalla ya dice en texto que hay que volver al
 * chat.
 */
export function businessChatUrl(raw: string | null | undefined): string | null {
  const digitos = (raw ?? '').replace(/\D+/g, '');
  if (digitos.length < DIGITOS_NACIONALES) return null;

  const completo = digitos.length === DIGITOS_NACIONALES ? `${CODIGO_BOLIVIA}${digitos}` : digitos;
  return `https://wa.me/${completo}`;
}
