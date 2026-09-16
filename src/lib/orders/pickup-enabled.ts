/**
 * ¿El local entrega pedidos en mano? NO (15-09-2026).
 *
 * Decisión del negocio: todos los pedidos salen con delivery. Este archivo es
 * el ÚNICO sitio donde eso está escrito; de aquí lo toma `promo-mode` y de
 * `promo-mode` lo toman las cinco puertas por las que un cliente podía llegar
 * al recojo:
 *
 *   · el checkout del menú web (el botón "Recojo" ya no se pinta)
 *   · el checkout del servidor (`orders/web-checkout`, que es quien manda)
 *   · "paso yo a recogerlo" por WhatsApp (`orders/pickup-switch-service`)
 *   · "¿dónde están?" (`kapso/send-local-address`, que lo aclara al dar la dirección)
 *   · el agente (`agent/business/prompt`, que ya no lo ofrece)
 *
 * ── Por qué una constante y no una columna en la base ───────────────────────
 *
 * Porque no es un horario ni una promoción: no se apaga solo a las 00:00 ni
 * depende de la cocina de esta noche. Un interruptor en el panel invita a
 * tocarlo, y cada vez que alguien lo toca hay que volver a responder las
 * preguntas caras — qué pasa con los pedidos de recojo ya confirmados, qué le
 * dice el agente a quien preguntó hace diez minutos. Mientras la respuesta sea
 * "no hacemos recojo", esto es una línea de código y un deploy.
 *
 * Para volver a encenderlo: `true` y desplegar. El camino de vuelta está
 * entero —nada se borró— salvo el texto del prompt, que vuelve a hacer falta.
 *
 * ── Lo que esto NO toca ─────────────────────────────────────────────────────
 *
 * Los pedidos que YA son de recojo. Siguen leyéndose, cobrándose y saliendo
 * como siempre: el panel, la comanda y los avisos no preguntan por esto. Esto
 * solo decide si se puede crear uno nuevo.
 */
export const PICKUP_ENABLED = false;
