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
  item('trancaburguer', 'Trancaburguer', 'plato', 30, 10),
  item('trancapecho', 'Trancapecho', 'plato', 18, 20),
  item('salchiburguer', 'Salchiburguer', 'plato', 18, 30),
  item('hamburguesa', 'Hamburguesa', 'plato', 15, 40),
  item('lomito', 'Lomito', 'plato', 18, 50),
  item('salchipapa', 'Salchipapa', 'plato', 18, 60),
  item('gaseosa_2l', 'Gaseosa 2 L', 'bebida', 18, 70),
  item('gaseosa_personal', 'Gaseosa personal', 'bebida', 8, 80),
  item('gaseosa_pequena', 'Gaseosa pequeña', 'bebida', 5, 90),
  item('porcion_papas', 'Porción de papa', 'extra', 7, 100),
];

describe('categorías', () => {
  it('expone las 4 pestañas en orden', () => {
    expect(CATEGORY_TABS.map((t) => t.id)).toEqual(['all', 'plato', 'bebida', 'extra']);
    expect(CATEGORY_TABS.map((t) => t.label)).toEqual([
      'Todo',
      'Platos',
      'Bebidas',
      'Extras',
    ]);
  });

  it('traduce las categorías del esquema a etiquetas visibles', () => {
    expect(categoryLabel('plato')).toBe('Platos');
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

  it('filtra platos', () => {
    const result = filterMenuItems(MENU, 'plato', '');
    expect(result.map((i) => i.code)).toEqual([
      'trancaburguer',
      'trancapecho',
      'salchiburguer',
      'hamburguesa',
      'lomito',
      'salchipapa',
    ]);
  });

  it('filtra bebidas y extras', () => {
    expect(filterMenuItems(MENU, 'bebida', '').map((i) => i.code)).toEqual([
      'gaseosa_2l',
      'gaseosa_personal',
      'gaseosa_pequena',
    ]);
    expect(filterMenuItems(MENU, 'extra', '').map((i) => i.code)).toEqual(['porcion_papas']);
  });
});

describe('filterMenuItems — búsqueda', () => {
  it('encuentra por nombre, sin distinguir mayúsculas', () => {
    expect(filterMenuItems(MENU, 'all', 'salchib').map((i) => i.code)).toEqual([
      'salchiburguer',
    ]);
    expect(filterMenuItems(MENU, 'all', 'LOMITO').map((i) => i.code)).toEqual(['lomito']);
  });

  it('ignora acentos en ambos sentidos', () => {
    expect(filterMenuItems(MENU, 'all', 'pequena').map((i) => i.code)).toEqual([
      'gaseosa_pequena',
    ]);
    expect(filterMenuItems(MENU, 'all', 'porción').map((i) => i.code)).toEqual([
      'porcion_papas',
    ]);
    expect(filterMenuItems(MENU, 'extra', 'porcion de papa').map((i) => i.code)).toEqual([
      'porcion_papas',
    ]);
  });

  it('encuentra por descripción', () => {
    expect(filterMenuItems(MENU, 'all', 'arroz y ensalada').map((i) => i.code)).toEqual([
      'trancapecho',
    ]);
    expect(filterMenuItems(MENU, 'all', 'milanesa').map((i) => i.code)).toEqual([
      'trancaburguer',
    ]);
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
    expect(normalizeText('  Porción DE Papa ')).toBe('porcion de papa');
  });
});

describe('descripciones e imágenes', () => {
  it('los 10 productos del seed tienen descripción', () => {
    for (const menuItem of MENU) {
      expect(productDescription(menuItem.code), menuItem.code).toBeTruthy();
    }
  });

  it('un código desconocido no tiene descripción', () => {
    expect(productDescription('producto_inexistente')).toBeNull();
  });

  it('los diez productos del seed tienen foto en /menu/*.webp', () => {
    for (const menuItem of MENU) {
      const image = productImage(menuItem);
      expect(image.src, menuItem.code).toMatch(/^\/menu\/[a-z0-9-]+\.webp$/);
      // El src apunta al mismo archivo declarado en `file` (coherencia).
      expect(image.src, menuItem.code).toBe(`/menu/${image.file}`);
    }
  });

  it('todo producto del seed declara emoji de fallback y nombre de archivo', () => {
    for (const menuItem of MENU) {
      const image = productImage(menuItem);
      expect(image.emoji, menuItem.code).not.toBe('');
      expect(image.file, menuItem.code).toMatch(/^[a-z0-9-]+\.webp$/);
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
    expect(groups.map((g) => g.label)).toEqual(['Platos', 'Bebidas', 'Extras']);
    expect(groups[0].items).toHaveLength(6);
    expect(groups[1].items).toHaveLength(3);
    expect(groups[2].items).toHaveLength(1);
  });

  it('con lista vacía devuelve ningún grupo', () => {
    expect(groupByCategory([])).toEqual([]);
  });
});
