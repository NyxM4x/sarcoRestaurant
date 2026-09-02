import type { MenuCategory, MenuItem } from '@/types';

/**
 * Promociones por combo — módulo PURO.
 *
 * Todo lo que decide si un combo se puede vender, cuánto ahorra y cómo se
 * enuncia. Sin red, sin Supabase y sin React: recibe datos ya leídos y devuelve
 * cifras y estados.
 *
 * ── La regla monetaria, en un solo sitio ────────────────────────────────────
 *
 * El precio normal NUNCA se guarda ni se acepta del navegador: se CALCULA
 * sumando los precios vigentes de los componentes. Un precio normal almacenado
 * es una copia que envejece — sube el lomito y el combo seguiría anunciando un
 * ahorro que ya no existe.
 *
 * Esta es la misma definición que implementa `promotion_normal_price` en la
 * migración 0031. Están duplicadas a propósito y hay que MANTENERLAS
 * SINCRONIZADAS: aquí se decide qué se pinta, y allí qué se cobra. El mismo
 * reparto que ya existe entre `delivery/fee.ts` y `delivery_tariff_for_meters`.
 *
 * ── Por qué el estado es un dato y no un booleano ───────────────────────────
 *
 * "¿Se puede comprar?" tiene una sola respuesta útil cuando es que sí, y seis
 * cuando es que no: apagada, programada, vencida, incompleta, sin componentes
 * disponibles o sin ahorro. El panel necesita distinguirlas para decir qué
 * arreglar, y el menú para decidir si esconde la tarjeta o la muestra
 * deshabilitada. Un booleano obligaría a cada pantalla a reconstruir el motivo.
 */

// ── Modelo ──────────────────────────────────────────────────────────────────

/** Un componente del combo, ya resuelto contra el catálogo. */
export interface PromotionComponent {
  menuItemId: string;
  code: string;
  name: string;
  category: MenuCategory;
  /** Precio VIGENTE del producto suelto, no un histórico. */
  unitPrice: number;
  quantity: number;
  /** ¿Sigue el producto a la venta? Un componente retirado tumba el combo. */
  isActive: boolean;
}

/** La promoción tal como la administra el panel. */
export interface Promotion {
  id: string;
  name: string;
  description: string | null;
  promoPrice: number;
  imageUrl: string | null;
  /** ISO 8601, o `null` si no tiene esa frontera. */
  startsAt: string | null;
  endsAt: string | null;
  isActive: boolean;
  /** Control optimista: sube en cada escritura (trigger de 0031). */
  revision: number;
  updatedAt: string;
  components: PromotionComponent[];
}

/**
 * Por qué un combo se puede vender, o por qué no.
 *
 * El orden de esta unión es el orden en que se comprueban las condiciones, y es
 * deliberado: primero si hay algo que vender, luego si el negocio quiere
 * venderlo, luego si toca, y por último si sale a cuenta. Espeja exactamente a
 * `promotion_availability` en 0031.
 */
export type PromotionStatus =
  /** Se puede comprar ahora mismo. */
  | 'available'
  /** Menos de dos unidades: todavía no es un combo. */
  | 'incomplete'
  /** Algún producto está retirado del catálogo. */
  | 'component_unavailable'
  /** El encargado no la ha encendido. */
  | 'disabled'
  /** Encendida, pero su ventana aún no empezó. */
  | 'scheduled'
  /** Su ventana ya terminó. */
  | 'expired'
  /** El precio del combo ya no está por debajo del normal. */
  | 'no_savings';

export interface PromotionPricing {
  /** Suma de los precios vigentes por cantidad. */
  normalPrice: number;
  promoPrice: number;
  /** Nunca negativo: sin ahorro es 0, y el estado lo explica. */
  savings: number;
  status: PromotionStatus;
}

/** Unidades mínimas para que un combo sea un combo. */
export const MIN_PROMOTION_UNITS = 2;

// ── Cálculo ─────────────────────────────────────────────────────────────────

/**
 * Precio del combo si se comprara suelto.
 *
 * Redondeado a dos decimales porque el resultado se compara con el precio
 * promocional y se pinta: sin redondeo, `0.1 + 0.2` haría fallar una comparación
 * que a la vista es exacta.
 */
export function normalPriceOf(components: PromotionComponent[]): number {
  const total = components.reduce((sum, c) => sum + c.unitPrice * c.quantity, 0);
  return Math.round(total * 100) / 100;
}

/** Total de unidades del combo, contando repeticiones del mismo producto. */
export function totalUnitsOf(components: PromotionComponent[]): number {
  return components.reduce((sum, c) => sum + c.quantity, 0);
}

/**
 * Estado y cifras de un combo en un instante dado.
 *
 * `now` se recibe y no se lee del reloj: una función que consulta la hora por su
 * cuenta no se puede probar, y aquí hay que poder afirmar qué pasa el segundo
 * antes y el segundo después de un vencimiento.
 */
export function evaluatePromotion(promotion: Promotion, now: number): PromotionPricing {
  const normalPrice = normalPriceOf(promotion.components);
  const promoPrice = promotion.promoPrice;
  // El ahorro no baja de cero NUNCA. Un "ahorras Bs -5" es peor que no decir
  // nada: parece un cobro extra y destruye la confianza en el resto de cifras.
  const savings = Math.max(Math.round((normalPrice - promoPrice) * 100) / 100, 0);

  const con = (status: PromotionStatus, sinAhorro = false): PromotionPricing => ({
    normalPrice,
    promoPrice,
    savings: sinAhorro ? 0 : savings,
    status,
  });

  if (totalUnitsOf(promotion.components) < MIN_PROMOTION_UNITS) return con('incomplete', true);
  if (promotion.components.some((c) => !c.isActive)) return con('component_unavailable');
  if (!promotion.isActive) return con('disabled');

  const inicio = parseInstant(promotion.startsAt);
  if (inicio !== null && now < inicio) return con('scheduled');

  const fin = parseInstant(promotion.endsAt);
  // `>=` y no `>`: a las 23:31 en punto la promoción de "hasta las 23:31" ya
  // terminó. El instante de fin es exclusivo, como en cualquier horario.
  if (fin !== null && now >= fin) return con('expired');

  if (promoPrice >= normalPrice) return con('no_savings', true);

  return con('available');
}

/** ¿Se puede añadir al carrito y confirmar? Solo un estado lo permite. */
export function isPurchasable(pricing: PromotionPricing): boolean {
  return pricing.status === 'available';
}

/** Epoch ms de un ISO, o `null` si falta o no se puede leer. */
function parseInstant(iso: string | null): number | null {
  if (iso === null) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

// ── Validación de lo que escribe el panel ───────────────────────────────────

/** Un componente tal como llega del formulario, antes de resolverlo. */
export interface PromotionDraftComponent {
  menuItemId: string;
  quantity: number;
}

export interface PromotionDraft {
  name: string;
  description: string | null;
  promoPrice: number;
  startsAt: string | null;
  endsAt: string | null;
  components: PromotionDraftComponent[];
}

export type PromotionDraftError =
  | 'name_required'
  | 'name_too_long'
  | 'description_too_long'
  | 'price_not_positive'
  | 'price_not_below_normal'
  | 'components_required'
  | 'quantity_not_integer'
  | 'quantity_out_of_range'
  | 'duplicate_component'
  | 'unknown_component'
  | 'component_unavailable'
  | 'window_out_of_order'
  | 'invalid_date';

export const MAX_PROMOTION_NAME_LENGTH = 80;
export const MAX_PROMOTION_DESCRIPTION_LENGTH = 300;
export const MAX_COMPONENT_QUANTITY = 20;

/**
 * Valida un borrador contra el catálogo REAL. Devuelve los errores, en orden.
 *
 * La comprobación monetaria NO depende de ninguna bandera opcional: se hace
 * siempre, al crear y al editar igual. Una validación que se puede saltar con un
 * parámetro acaba saltándose, y lo que entra por ahí es un combo que cobra de
 * más.
 *
 * Recibe el catálogo entero en vez de consultarlo: así el llamante decide con
 * qué instantánea se valida, y se puede probar sin base de datos.
 */
export function validatePromotionDraft(
  draft: PromotionDraft,
  catalog: MenuItem[],
): PromotionDraftError[] {
  const errores: PromotionDraftError[] = [];
  const porId = new Map(catalog.map((item) => [item.id, item]));

  const nombre = draft.name.trim();
  if (nombre === '') errores.push('name_required');
  else if (nombre.length > MAX_PROMOTION_NAME_LENGTH) errores.push('name_too_long');

  if (draft.description !== null && draft.description.length > MAX_PROMOTION_DESCRIPTION_LENGTH) {
    errores.push('description_too_long');
  }

  if (!Number.isFinite(draft.promoPrice) || draft.promoPrice <= 0) {
    errores.push('price_not_positive');
  }

  // ── Componentes ──────────────────────────────────────────────────────────
  const vistos = new Set<string>();
  const resueltos: PromotionComponent[] = [];

  for (const c of draft.components) {
    if (vistos.has(c.menuItemId)) {
      errores.push('duplicate_component');
      continue;
    }
    vistos.add(c.menuItemId);

    if (!Number.isInteger(c.quantity)) {
      errores.push('quantity_not_integer');
      continue;
    }
    if (c.quantity < 1 || c.quantity > MAX_COMPONENT_QUANTITY) {
      errores.push('quantity_out_of_range');
      continue;
    }

    const item = porId.get(c.menuItemId);
    if (item === undefined) {
      errores.push('unknown_component');
      continue;
    }
    if (!item.is_active) {
      errores.push('component_unavailable');
      continue;
    }

    resueltos.push({
      menuItemId: item.id,
      code: item.code,
      name: item.name,
      category: item.category,
      unitPrice: item.price,
      quantity: c.quantity,
      isActive: item.is_active,
    });
  }

  // Dos unidades mínimo, no dos productos: "2× lomito" es un combo válido.
  if (totalUnitsOf(resueltos) < MIN_PROMOTION_UNITS) errores.push('components_required');

  // ── Fechas ───────────────────────────────────────────────────────────────
  const inicio = draft.startsAt === null ? null : Date.parse(draft.startsAt);
  const fin = draft.endsAt === null ? null : Date.parse(draft.endsAt);
  if (inicio !== null && Number.isNaN(inicio)) errores.push('invalid_date');
  if (fin !== null && Number.isNaN(fin)) errores.push('invalid_date');
  if (inicio !== null && fin !== null && !Number.isNaN(inicio) && !Number.isNaN(fin) && fin <= inicio) {
    errores.push('window_out_of_order');
  }

  // ── Y la regla que no se puede saltar ────────────────────────────────────
  //
  // Va la última porque necesita los componentes ya resueltos, pero es la que
  // define si esto es una promoción: sin ahorro, no lo es. Solo se comprueba si
  // el precio en sí era válido; si no, ya hay un error más específico y añadir
  // este solo enterraría el que se puede arreglar.
  if (resueltos.length > 0 && Number.isFinite(draft.promoPrice) && draft.promoPrice > 0) {
    if (draft.promoPrice >= normalPriceOf(resueltos)) errores.push('price_not_below_normal');
  }

  return errores;
}
