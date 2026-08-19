import { describe, expect, it } from 'vitest';
import type { MenuItem } from '@/types';
import {
  CATEGORY_TABS,
  categoryLabel,
  filterMenuItems,
  groupByCategory,
  normalizeText,
  productDescription,
  productImage,
} from './catalog';

function item(
  code: string,
  name: string,
  category: MenuItem['category'],
  price: number,
  sort_order: number,
): MenuItem {
  return {
    id: `id-${code}`,
    code,
    name,
    category,
    price,
    is_active: true,
    sort_order,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

/** Mismo catálogo que `supabase/seed.sql`. */
const MENU: MenuItem[] = [
  item('la_fija', 'La Fija', 'plato', 22, 10),
  item('doble_o_nada', 'Doble o Nada', 'plato', 32, 20),
  item('hat_trick', 'Hat Trick', 'plato', 42, 30),
  item('lomito_jackpot', 'Lomito Jackpot', 'plato', 25, 40),
  item('gaseosa_2l', 'Gaseosa 2 L', 'bebida', 18, 50),
  item('gaseosa_personal', 'Gaseosa personal', 'bebida', 8, 60),
  item('gaseosa_pequena', 'Gaseosa pequeña', 'bebida', 5, 70),
  item('tocino', 'Tocino', 'extra', 5, 80),
  item('porcion_papas', 'Porción de papas', 'extra', 10, 90),
];

describe('categorías', () => {
  it('expone las 4 pestañas en orden', () => {
    expect(CATEGORY_TABS.map((t) => t.id)).toEqual(['all', 'plato', 'bebida', 'extra']);
    expect(CATEGORY_TABS.map((t) => t.label)).toEqual([
      'Todo',
      'Hamburguesas',
      'Bebidas',
      'Extras',
    ]);
  });

  it('traduce las categorías del esquema a etiquetas visibles', () => {
    expect(categoryLabel('plato')).toBe('Hamburguesas');
    expect(categoryLabel('bebida')).toBe('Bebidas');
    expect(categoryLabel('extra')).toBe('Extras');
  });

  it('no expone categorías ficticias (Combos, Papas, Promos…)', () => {
    // Solo existen 3 categorías reales en el esquema + la pestaña "all".
    const realIds = CATEGORY_TABS.map((t) => t.id);
    expect(realIds).toEqual(['all', 'plato', 'bebida', 'extra']);
    expect(realIds).toHaveLength(4);

    const labels = CATEGORY_TABS.map((t) => t.label.toLowerCase());
    for (const fake of ['combos', 'combo', 'papas', 'promos', 'promociones', 'menús']) {
      expect(labels, fake).not.toContain(fake);
    }
  });
});

describe('filterMenuItems — filtrado por categoría', () => {
  it('"all" devuelve todo el catálogo sin reordenar', () => {
    expect(filterMenuItems(MENU, 'all', '')).toEqual(MENU);
  });

  it('filtra hamburguesas', () => {
    const result = filterMenuItems(MENU, 'plato', '');
    expect(result.map((i) => i.code)).toEqual([
      'la_fija',
      'doble_o_nada',
      'hat_trick',
      'lomito_jackpot',
    ]);
  });

  it('filtra bebidas y extras', () => {
    expect(filterMenuItems(MENU, 'bebida', '').map((i) => i.code)).toEqual([
      'gaseosa_2l',
      'gaseosa_personal',
      'gaseosa_pequena',
    ]);
    expect(filterMenuItems(MENU, 'extra', '').map((i) => i.code)).toEqual([
      'tocino',
      'porcion_papas',
    ]);
  });
});

describe('filterMenuItems — búsqueda', () => {
  it('encuentra por nombre, sin distinguir mayúsculas', () => {
    expect(filterMenuItems(MENU, 'all', 'hat').map((i) => i.code)).toEqual(['hat_trick']);
    expect(filterMenuItems(MENU, 'all', 'LOMITO').map((i) => i.code)).toEqual([
      'lomito_jackpot',
    ]);
  });

  it('ignora acentos en ambos sentidos', () => {
    expect(filterMenuItems(MENU, 'all', 'pequena').map((i) => i.code)).toEqual([
      'gaseosa_pequena',
    ]);
    // "Porción" aparece en el nombre de las papas y en la descripción del
    // tocino ("Porción extra de tocino crocante"): ambos son coincidencias.
    expect(filterMenuItems(MENU, 'all', 'porción').map((i) => i.code)).toEqual([
      'tocino',
      'porcion_papas',
    ]);
    expect(filterMenuItems(MENU, 'extra', 'porcion de papas').map((i) => i.code)).toEqual([
      'porcion_papas',
    ]);
  });

  it('encuentra por descripción', () => {
    expect(filterMenuItems(MENU, 'all', 'triple carne').map((i) => i.code)).toEqual([
      'hat_trick',
    ]);
    expect(filterMenuItems(MENU, 'all', 'crocante').map((i) => i.code)).toEqual(['tocino']);
  });

  it('combina búsqueda con la categoría activa', () => {
    expect(filterMenuItems(MENU, 'bebida', 'gaseosa')).toHaveLength(3);
    expect(filterMenuItems(MENU, 'extra', 'gaseosa')).toEqual([]);
  });

  it('ignora espacios sobrantes y devuelve vacío si no hay coincidencias', () => {
    expect(filterMenuItems(MENU, 'all', '   ')).toEqual(MENU);
    expect(filterMenuItems(MENU, 'all', 'sushi')).toEqual([]);
  });

  it('normalizeText baja a minúsculas y quita acentos', () => {
    expect(normalizeText('  Porción DE Papas ')).toBe('porcion de papas');
  });
});

describe('descripciones e imágenes', () => {
  it('los 9 productos del seed tienen descripción', () => {
    for (const menuItem of MENU) {
      expect(productDescription(menuItem.code), menuItem.code).toBeTruthy();
    }
  });

  it('un código desconocido no tiene descripción', () => {
    expect(productDescription('producto_inexistente')).toBeNull();
  });

  it('los 9 productos conocidos tienen foto real en /menu/*.webp', () => {
    for (const menuItem of MENU) {
      const image = productImage(menuItem);
      expect(image.src, menuItem.code).toMatch(/^\/menu\/[a-z0-9-]+\.webp$/);
      // El src apunta al mismo archivo declarado en `file` (coherencia).
      expect(image.src, menuItem.code).toBe(`/menu/${image.file}`);
      // El emoji se conserva como fallback defensivo (onError → placeholder).
      expect(image.emoji, menuItem.code).not.toBe('');
    }
  });

  it('un producto nuevo (código no mapeado) cae al placeholder de su categoría', () => {
    const image = productImage({ code: 'combo_nuevo', category: 'bebida' });
    expect(image.src).toBeNull();
    expect(image.file).toBe('combo-nuevo.webp');
    expect(image.emoji).toBe('🥤');
  });
});

describe('groupByCategory', () => {
  it('agrupa conservando el orden de llegada', () => {
    const groups = groupByCategory(MENU);
    expect(groups.map((g) => g.category)).toEqual(['plato', 'bebida', 'extra']);
    expect(groups.map((g) => g.label)).toEqual(['Hamburguesas', 'Bebidas', 'Extras']);
    expect(groups[0].items).toHaveLength(4);
    expect(groups[1].items).toHaveLength(3);
    expect(groups[2].items).toHaveLength(2);
  });

  it('con lista vacía devuelve ningún grupo', () => {
    expect(groupByCategory([])).toEqual([]);
  });
});
