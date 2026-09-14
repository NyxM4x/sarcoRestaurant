import type { MenuCategory } from '@/types';
import { evaluatePromotion, isPurchasable, type Promotion } from './promotion';

/**
 * La noche de promoción — módulo PURO (14-09-2026).
 *
 * Mientras haya al menos un combo que se pueda comprar, el menú no se comporta
 * como el de siempre. La primera fue "2 Trancapechos por Bs 25": la cocina solo
 * hace trancapechos, el resto del catálogo queda agotado y lo que se le ofrece
 * al cliente junto al combo son las bebidas.
 *
 * Tres cosas cambian, y las tres se deciden AQUÍ para que el menú, el checkout
 * del servidor, el botón de WhatsApp y el agente no tengan cada uno su versión:
 *
 *   · Bebidas sube justo debajo de Promociones. Es lo que acompaña al combo.
 *   · El producto de un combo de UN solo producto no se vende suelto.
 *   · No se acepta efectivo.
 *
 * ── Por qué depende de la promoción y no de un interruptor ──────────────────
 *
 * Porque así se apaga sola. La promoción ya tiene su hora de fin y
 * `evaluatePromotion` ya la respeta; atar el modo a ella hace que a las 00:00
 * el menú vuelva a ser el de siempre sin un deploy, sin un revert y sin nadie
 * despierto para tocar nada. Un interruptor aparte es un segundo reloj que
 * alguien tiene que acordarse de parar.
 *
 * El precio de esa decisión: CUALQUIER promoción vendible activa el modo, y con
 * él se apaga el efectivo. Si algún día hay un combo que tiene que convivir con
 * el efectivo, esto se convierte en una columna de `promotions` — y no antes.
 *
 * ── Por qué el suelto se esconde solo en combos de un producto ──────────────
 *
 * "2× Trancapecho por Bs 25" es un precio por cantidad del MISMO producto:
 * venderlo suelto al lado es ofrecer lo mismo dos veces. En un combo de varios
 * productos —lomito, soda y papa— cada uno sigue siendo algo que se pide solo,
 * y esconderlos vaciaría el menú.
 *
 * El suelto NO se marca agotado en la base: un componente inactivo tumba el
 * combo entero (`component_unavailable`), que es justo lo contrario de lo que
 * se quiere.
 */

export interface PromoMode {
  /** ¿Hay al menos un combo que se pueda comprar ahora mismo? */
  active: boolean;
  /** ¿Se puede elegir efectivo? Solo fuera de la noche de promoción. */
  cashAllowed: boolean;
  /**
   * Códigos de producto que ahora solo se venden dentro de su combo. Vacío
   * cuando el modo no está activo.
   */
  comboOnlyCodes: ReadonlySet<string>;
}

/** El menú de siempre. Es también lo que se usa si las promociones no se pueden leer. */
export const NORMAL_MODE: PromoMode = {
  active: false,
  cashAllowed: true,
  comboOnlyCodes: new Set(),
};

/**
 * El modo del menú en un instante dado.
 *
 * `now` se recibe y no se lee del reloj, igual que en `evaluatePromotion`: hay
 * que poder afirmar qué pasa el segundo antes y el segundo después de las 00:00.
 */
export function promoModeAt(promotions: ReadonlyArray<Promotion>, now: number): PromoMode {
  const vendibles = promotions.filter((promotion) =>
    isPurchasable(evaluatePromotion(promotion, now)),
  );

  if (vendibles.length === 0) return NORMAL_MODE;

  const comboOnlyCodes = new Set<string>();
  for (const promotion of vendibles) {
    if (promotion.components.length === 1) comboOnlyCodes.add(promotion.components[0].code);
  }

  return { active: true, cashAllowed: false, comboOnlyCodes };
}

/** La categoría que acompaña al combo y sube debajo de Promociones. */
export const PROMO_COMPANION_CATEGORY: MenuCategory = 'bebida';

/**
 * Las secciones del menú en el orden de la noche de promoción.
 *
 * Solo MUEVE la sección de bebidas al principio; el resto queda en el orden
 * recibido, que es el del `sort_order` de siempre. Fuera del modo devuelve la
 * misma lista, sin copiarla.
 */
export function orderSectionsForMode<T extends { category: MenuCategory }>(
  sections: T[],
  mode: Pick<PromoMode, 'active'>,
): T[] {
  if (!mode.active) return sections;
  const primero = sections.filter((s) => s.category === PROMO_COMPANION_CATEGORY);
  const resto = sections.filter((s) => s.category !== PROMO_COMPANION_CATEGORY);
  return [...primero, ...resto];
}
