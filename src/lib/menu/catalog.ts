/**
 * Catálogo visual del menú — lógica PURA (sin `server-only`, sin Supabase).
 *
 * Se usa desde componentes cliente (`/menu`) y desde tests. Los **nombres y
 * precios** siguen viniendo de Supabase (`menu_items`): aquí solo vive lo
 * presentacional (etiquetas de categoría, descripciones de vitrina, imagen).
 *
 * OJO: no importar este módulo desde `@/lib/menu` (ese índice es server-only).
 */
import type { MenuCategory, MenuItem } from '@/types';

// ── Categorías ──────────────────────────────────────────────────────────────

/** Pestaña "Todo" + las 3 categorías reales del esquema. */
export type CategoryFilter = 'all' | MenuCategory;

export const CATEGORY_TABS: ReadonlyArray<{ id: CategoryFilter; label: string }> = [
  { id: 'all', label: 'Todo' },
  { id: 'plato', label: 'Platos' },
  { id: 'bebida', label: 'Bebidas' },
  { id: 'extra', label: 'Extras' },
] as const;

const CATEGORY_LABELS: Record<MenuCategory, string> = {
  plato: 'Platos',
  bebida: 'Bebidas',
  extra: 'Extras',
};

/** Etiqueta visible de una categoría del esquema (`plato` → `Platos`). */
export function categoryLabel(category: MenuCategory): string {
  return CATEGORY_LABELS[category];
}

// ── Copy de vitrina ─────────────────────────────────────────────────────────

/**
 * Descripciones cortas por `code`. Son texto de UI, NO datos de negocio:
 * `menu_items` no tiene columna `description` y el esquema no se modifica en
 * esta fase. Si un producto nuevo no está aquí, la tarjeta simplemente no
 * muestra descripción (y la búsqueda solo lo encuentra por nombre).
 */
const PRODUCT_DESCRIPTIONS: Record<string, string> = {
  trancaburguer: 'Nuestro grande: hamburguesa con milanesa, huevo y salchicha.',
  trancapecho: 'El clásico cochabambino: carne, huevo, arroz y ensalada.',
  salchiburguer: 'Hamburguesa con salchicha, huevo y ensalada fresca.',
  hamburguesa: 'Hamburguesa de carne con ensalada y salsa de la casa.',
  lomito: 'Lomito jugoso en pan francés con verduras frescas.',
  salchipapa: 'Papas fritas con salchicha dorada al sartén.',
  gaseosa_2l: 'Botella de 2 litros para compartir.',
  gaseosa_personal: 'Botella personal bien helada.',
  porcion_papas: 'Papas fritas doradas con sal.',

  // Los cuatro vasos comparten copy porque comparten promesa: es lo que el
  // negocio quiere decir de ellos, y cuatro frases distintas inventadas aquí
  // dirían cosas que nadie ha prometido. Las sodas van sin descripción: una
  // Coca-Cola no necesita que se la presenten.
  vaso_maracuya: 'Refrescante y natural.',
  vaso_limonada: 'Refrescante y natural.',
  vaso_lima: 'Refrescante y natural.',
  vaso_pina: 'Refrescante y natural.',
};

/** Descripción de vitrina de un producto, o `null` si no hay copy definido. */
export function productDescription(code: string): string | null {
  return PRODUCT_DESCRIPTIONS[code] ?? null;
}

// ── Imágenes ────────────────────────────────────────────────────────────────

/**
 * Foto de cada producto, mapeada por `code`.
 *
 * Los diez productos del catálogo tienen su foto real en `public/menu/`
 * (WebP). El
 * `emoji` se conserva como fallback: si una foto falla al cargar, `ProductImage`
 * cae al placeholder (gradiente + emoji) vía `onError`.
 *
 * Para un producto nuevo sin foto, dejar `src: null`: se dibuja el placeholder
 * sin pedir ninguna imagen a la red (ver `public/menu/README.md`).
 *
 * No usar la imagen general del menú como foto de cada producto.
 */
export interface ProductImage {
  /** Ruta pública de la foto, o `null` si aún no existe (usar placeholder). */
  src: string | null;
  /** Nombre de archivo esperado en `public/menu/`. */
  file: string;
  /** Emoji del placeholder mientras no hay foto. */
  emoji: string;
}

const PRODUCT_IMAGES: Record<string, ProductImage> = {
  trancaburguer: { src: '/menu/trancaburguer.webp', file: 'trancaburguer.webp', emoji: '🍔' },
  trancapecho: { src: '/menu/trancapecho.webp', file: 'trancapecho.webp', emoji: '🥪' },
  salchiburguer: { src: '/menu/salchiburguer.webp', file: 'salchiburguer.webp', emoji: '🌭' },
  hamburguesa: { src: '/menu/hamburguesa.webp', file: 'hamburguesa.webp', emoji: '🍔' },
  lomito: { src: '/menu/lomito.webp', file: 'lomito.webp', emoji: '🥪' },
  salchipapa: { src: '/menu/salchipapa.webp', file: 'salchipapa.webp', emoji: '🍟' },
  gaseosa_2l: { src: '/menu/gaseosa-2l.webp', file: 'gaseosa-2l.webp', emoji: '🥤' },
  gaseosa_personal: { src: '/menu/gaseosa-personal.webp', file: 'gaseosa-personal.webp', emoji: '🥤' },
  porcion_papas: { src: '/menu/porcion-papas.webp', file: 'porcion-papas.webp', emoji: '🍟' },

  // Bebidas de 0030, con foto real del negocio (02-09-2026). El emoji sigue
  // siendo distinto por bebida: es el fallback si la foto no carga, y el de
  // categoría daría 🥤 a las seis — en la vitrina los jugos quedarían
  // indistinguibles de las sodas, que es lo que el cliente elige de un vistazo.
  soda_peque: { src: '/menu/soda-peque.webp', file: 'soda-peque.webp', emoji: '🥤' },
  soda_mini: { src: '/menu/soda-mini.webp', file: 'soda-mini.webp', emoji: '🥤' },
  vaso_maracuya: { src: '/menu/vaso-maracuya.webp', file: 'vaso-maracuya.webp', emoji: '🧃' },
  vaso_limonada: { src: '/menu/vaso-limonada.webp', file: 'vaso-limonada.webp', emoji: '🍋' },
  vaso_lima: { src: '/menu/vaso-lima.webp', file: 'vaso-lima.webp', emoji: '🍋' },
  vaso_pina: { src: '/menu/vaso-pina.webp', file: 'vaso-pina.webp', emoji: '🍍' },
};

const FALLBACK_EMOJI: Record<MenuCategory, string> = {
  plato: '🥪',
  bebida: '🥤',
  extra: '🍟',
};

/** Imagen (o placeholder) de un producto. Nunca devuelve `undefined`. */
export function productImage(item: Pick<MenuItem, 'code' | 'category'>): ProductImage {
  return (
    PRODUCT_IMAGES[item.code] ?? {
      src: null,
      file: `${item.code.replace(/_/g, '-')}.webp`,
      emoji: FALLBACK_EMOJI[item.category] ?? '🍽️',
    }
  );
}

// ── Filtrado y búsqueda ─────────────────────────────────────────────────────

/** Minúsculas sin acentos, para comparar "Porción de papa" con "porcion". */
export function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim();
}

/**
 * Filtra el catálogo por categoría y por texto (nombre + descripción).
 * Ambos filtros son locales: no hay ida y vuelta al servidor.
 */
export function filterMenuItems(
  items: MenuItem[],
  category: CategoryFilter,
  query: string,
): MenuItem[] {
  const needle = normalizeText(query);

  return items.filter((item) => {
    if (category !== 'all' && item.category !== category) return false;
    if (needle === '') return true;

    const haystack = normalizeText(
      `${item.name} ${productDescription(item.code) ?? ''}`,
    );
    return haystack.includes(needle);
  });
}

/** Agrupa los productos por categoría, respetando el orden recibido. */
export function groupByCategory(
  items: MenuItem[],
): Array<{ category: MenuCategory; label: string; items: MenuItem[] }> {
  const groups = new Map<MenuCategory, MenuItem[]>();

  for (const item of items) {
    const bucket = groups.get(item.category);
    if (bucket) bucket.push(item);
    else groups.set(item.category, [item]);
  }

  return [...groups.entries()].map(([category, groupItems]) => ({
    category,
    label: categoryLabel(category),
    items: groupItems,
  }));
}
