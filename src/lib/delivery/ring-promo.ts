/**
 * La promoción del envío a Bs 12 dentro del 4to anillo (21-09-2026) — PURO.
 *
 * ── Por qué es solo un aviso ────────────────────────────────────────────────
 *
 * El sistema no sabe en qué anillo cae un pin: haría falta el trazado del 4to
 * anillo y decidir qué pasa en cada borde. El negocio eligió avisarlo en vez de
 * calcularlo. La cotización sigue saliendo del tarifario (`./fee`) y es el
 * repartidor quien le cobra Bs 12 al que está dentro.
 *
 * ── Dónde sale, y por qué ahí ───────────────────────────────────────────────
 *
 * Al lado de cada cifra de envío que ve el cliente: el pie del QR y la
 * cotización suelta. El local queda hacia el 4to anillo, al suroeste, así que
 * alguien que vive dentro del anillo pero del otro lado de la ciudad cotiza 17,
 * 19, 21 Bs. Si lee esa cifra sin el aviso al lado, se va antes de enterarse de
 * que le sale 12 — el "muy caro su moto" del #40.
 *
 * En el botón del menú NO va: le llega a todo el que escribe, incluido el que
 * viene a recoger, y ahí no hay todavía ninguna cifra que aclarar.
 *
 * Sale SIEMPRE, también cuando el tarifario da 12 o menos: lo decidió el negocio.
 *
 * ── Para quitarla ───────────────────────────────────────────────────────────
 *
 * Entró con el merge de la rama `promo-envio-4to-anillo`. Revertir ese merge la
 * quita entera, igual que `efectivo-apagado`.
 */

/** Lo que cobra el repartidor dentro del 4to anillo. */
export const RING_PROMO_AMOUNT = 12;

/**
 * El aviso, con el importe ya escrito por quien lo usa.
 *
 * El pie del QR escribe "Bs. 12" y la cotización suelta "Bs 12": el aviso tiene
 * que hablar como el mensaje en el que va, y una cifra con dos formatos en el
 * mismo globo parece un error.
 *
 * "El monto de arriba" es la cifra del tarifario, que en los dos mensajes va
 * antes que el aviso.
 */
export function ringPromoText(amountLabel: string): string {
  return (
    `🎉 *PROMO ENVÍO ${amountLabel}:* si la entrega es *dentro del 4to anillo*, ` +
    `el repartidor te cobra ${amountLabel}. Fuera del 4to anillo se cobra el ` +
    'tarifario normal (el monto de arriba).'
  );
}
