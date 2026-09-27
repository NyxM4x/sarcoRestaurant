/**
 * ¿Se aceptan pedidos nuevos en efectivo? NO, por ahora (21-09-2026).
 *
 * Decisión del negocio, TEMPORAL: el pago es solo por QR hasta que el panel
 * tenga su propio botón para apagar y encender el efectivo. Ese botón necesita
 * una columna en la base, y los cambios de SQL esperan a que termine la
 * migración a la base nueva. Mientras tanto, esto.
 *
 * Este archivo es el ÚNICO sitio donde está escrito; de aquí lo toma
 * `promo-mode` (su `NORMAL_MODE`) y de `promo-mode` lo toman todas las puertas
 * por las que un cliente podía elegir efectivo:
 *
 *   · el checkout del menú web (el botón "Efectivo" se pinta deshabilitado)
 *   · el checkout del servidor (`orders/web-checkout`, que es quien manda)
 *   · "¿puedo pagar en efectivo?" por WhatsApp (`kapso/send-menu-cta`)
 *   · el agente (`agent/business/prompt`)
 *
 * La noche de promoción sigue exactamente igual: ya apagaba el efectivo por su
 * cuenta, y sus textos ("por la promoción") no cambian. Las noches SIN
 * promoción el agente y WhatsApp dicen "por ahora no", sin nombrar una
 * promoción que no existe: lo deciden mirando `active` del modo.
 *
 * Para volver a encenderlo: revertir el merge de la rama `efectivo-apagado`, o
 * `true` y desplegar. Nada se borró.
 *
 * ── Lo que esto NO toca ─────────────────────────────────────────────────────
 *
 * Los pedidos que YA son en efectivo. Siguen con su CONFIRMO, su cobro en la
 * puerta y sus avisos como siempre. Esto solo decide si se puede crear uno
 * nuevo.
 */
export const CASH_ENABLED = false;
