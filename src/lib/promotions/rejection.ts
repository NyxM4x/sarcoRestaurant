/**
 * Cuando el servidor rechaza un combo — módulo PURO.
 *
 * `create_order_web_v4` levanta `P1004` con un mensaje de formato fijo:
 *
 *     promotion_rejected:<motivo>:<uuid>
 *
 * Aquí se lee ese mensaje y se traduce a algo que el cliente pueda entender y
 * el navegador pueda actuar.
 *
 * ── Por qué se parsea un mensaje, si la regla es mapear por código ──────────
 *
 * El resto de errores de la RPC se mapean por SQLSTATE y NUNCA por texto,
 * porque los mensajes de PostgreSQL cambian entre versiones y pueden arrastrar
 * detalles internos. Esta es la excepción, y se sostiene por dos motivos:
 *
 *   · el mensaje lo escribimos nosotros con un formato cerrado, no lo genera
 *     Postgres;
 *   · el patrón es estricto —motivo de una lista blanca y un UUID— así que
 *     cualquier texto que no encaje se descarta entero en vez de reenviarse.
 *
 * Un SQLSTATE por motivo habría sido la alternativa, pero son nueve y Postgres
 * solo tiene cinco caracteres para nombrarlos: acabaríamos con una tabla de
 * códigos crípticos que hay que consultar en otro archivo para entender el log.
 */

/** Motivos que puede emitir la RPC. Espeja `promotion_availability` más dos. */
export const PROMOTION_REJECTION_REASONS = [
  /** La promoción ya no existe. */
  'not_found',
  /** Cambió mientras el cliente la miraba. */
  'stale_revision',
  /** Se quedó con menos de dos unidades. */
  'incomplete',
  /** Algún producto del combo está retirado. */
  'component_unavailable',
  /** El encargado la apagó. */
  'disabled',
  /** Todavía no ha empezado. */
  'scheduled',
  /** Su ventana terminó. */
  'expired',
  /** El precio dejó de estar por debajo del normal. */
  'no_savings',
  /** Lo mismo, comprobado justo antes de cobrar. */
  'price_not_below_normal',
] as const;

export type PromotionRejectionReason = (typeof PROMOTION_REJECTION_REASONS)[number];

export interface PromotionRejection {
  reason: PromotionRejectionReason;
  promotionId: string;
}

const PATTERN =
  /^promotion_rejected:([a-z_]+):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/;

/**
 * Lee el mensaje de `P1004`. `null` si no encaja con el formato esperado.
 *
 * Devolver `null` ante lo inesperado es deliberado: quien llama responde
 * entonces con el error genérico, y así un mensaje que no reconocemos jamás
 * llega al navegador tal cual.
 */
export function parsePromotionRejection(message: string | null | undefined): PromotionRejection | null {
  if (typeof message !== 'string') return null;

  const match = PATTERN.exec(message.trim());
  if (match === null) return null;

  const reason = match[1] as PromotionRejectionReason;
  if (!PROMOTION_REJECTION_REASONS.includes(reason)) return null;

  return { reason, promotionId: match[2] };
}

/**
 * Qué se le dice al cliente.
 *
 * Ninguno de estos textos culpa al cliente ni le pide que "intente más tarde":
 * todos describen qué pasó con la promoción y qué puede hacer ahora. La causa
 * siempre es nuestra —la apagamos, se venció, se acabó un producto— y el cliente
 * solo llegó tarde por unos minutos.
 *
 * Tampoco se distingue entre motivos que al cliente le dan igual: que el combo
 * esté apagado, incompleto o sin ahorro son tres estados distintos para el
 * panel, pero para quien está pidiendo la cena son el mismo hecho — ya no está.
 */
const MESSAGES: Record<PromotionRejectionReason, string> = {
  not_found: 'Esa promoción ya no está disponible. Quítala del carrito y confirma de nuevo.',
  stale_revision:
    'La promoción cambió mientras armabas el pedido. Vuelve a abrir el menú para ver el precio actual.',
  incomplete: 'Esa promoción ya no está disponible. Quítala del carrito y confirma de nuevo.',
  component_unavailable:
    'Se nos acabó uno de los productos de la promoción. Quítala del carrito y confirma de nuevo.',
  disabled: 'Esa promoción ya no está disponible. Quítala del carrito y confirma de nuevo.',
  scheduled: 'Esa promoción todavía no empezó. Quítala del carrito y confirma de nuevo.',
  expired: 'La promoción terminó. Quítala del carrito y confirma de nuevo.',
  no_savings: 'Esa promoción ya no está disponible. Quítala del carrito y confirma de nuevo.',
  price_not_below_normal:
    'Esa promoción ya no está disponible. Quítala del carrito y confirma de nuevo.',
};

export function promotionRejectionMessage(reason: PromotionRejectionReason): string {
  return MESSAGES[reason];
}
