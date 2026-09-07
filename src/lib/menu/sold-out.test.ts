import { describe, it, expect } from 'vitest';
import type { MenuItem } from '@/types';
import { filterMenuItems, groupByCategory } from './catalog';
import { summarizeCart } from '@/lib/cart/cart';

/**
 * EL ESCENARIO QUE TUMBÓ EL MENÚ, DE PUNTA A PUNTA (07-09-2026).
 *
 * El panel marcó el trancapecho como agotado y el cliente que entraba por el
 * botón no podía cargar el menú. La causa estaba repartida entre tres piezas
 * —qué se lee, qué se pinta y qué se cobra— y ninguna la veía entera: los tests
 * de cada una pasaban.
 *
 * Esto recorre la cadena con los mismos datos que la produjeron. No renderiza
 * (el entorno es `node`), pero encadena exactamente lo que encadena `MenuStore`:
 *
 *   items       ← `listAll()`, TODOS, agotados incluidos
 *   parrilla    ← `groupByCategory(filterMenuItems(items, …))`
 *   carrito     ← `summarizeCart(guardado, items.filter(is_active))`
 */
const producto = (code: string, name: string, activo: boolean, orden: number): MenuItem => ({
  id: `id-${code}`,
  code,
  name,
  category: 'plato',
  price: 25,
  is_active: activo,
  sort_order: orden,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
});

/** Lo que devuelve `listAll()` con el trancapecho recién agotado. */
const CARTA: MenuItem[] = [
  producto('trancapecho', 'Trancapecho', false, 0),
  producto('hamburguesa', 'Hamburguesa', true, 1),
  producto('salchipapa', 'Salchipapa', true, 2),
];

/** La lista que ve el carrito. Es la línea que impide cobrar lo que no hay. */
const A_LA_VENTA = CARTA.filter((item) => item.is_active);

describe('agotar un producto: la vitrina', () => {
  it('el agotado SIGUE en el menú — en gris, pero está', () => {
    const grupos = groupByCategory(filterMenuItems(CARTA, 'all', ''));
    const codigos = grupos[0].items.map((i) => i.code);

    expect(codigos).toContain('trancapecho');
    // Y al final, aunque su sort_order sea el primero.
    expect(codigos).toEqual(['hamburguesa', 'salchipapa', 'trancapecho']);
  });

  it('se puede buscar por su nombre y se encuentra', () => {
    // Quien lo busca es justo quien necesita enterarse de que se agotó.
    const encontrados = filterMenuItems(CARTA, 'all', 'tranca');
    expect(encontrados.map((i) => i.code)).toEqual(['trancapecho']);
  });

  it('la tarjeta lo marca como no disponible: `is_active` viaja intacto', () => {
    const grupos = groupByCategory(filterMenuItems(CARTA, 'all', ''));
    const tarjeta = grupos[0].items.find((i) => i.code === 'trancapecho');
    expect(tarjeta?.is_active).toBe(false);
  });
});

describe('agotar un producto: el carrito guardado', () => {
  it('EL FALLO: el carrito con SOLO el agotado ya no tumba nada', () => {
    // Este `expect` es el bug de anoche. `calculateOrder` lanzaba aquí dentro,
    // en pleno render, y se llevaba la pantalla entera por delante.
    expect(() => summarizeCart({ trancapecho: 2 }, A_LA_VENTA)).not.toThrow();

    const resumen = summarizeCart({ trancapecho: 2 }, A_LA_VENTA);
    expect(resumen.lines).toEqual([]);
    expect(resumen.total).toBe(0);
    expect(resumen.units).toBe(0);
    expect(resumen.unavailableCodes).toEqual(['trancapecho']);
  });

  it('NO se cobra el agotado, ni cuando lo acompaña algo vivo', () => {
    const resumen = summarizeCart({ trancapecho: 2, hamburguesa: 1 }, A_LA_VENTA);

    expect(resumen.lines.map((l) => l.product_code)).toEqual(['hamburguesa']);
    expect(resumen.total).toBe(25);
    // Dos trancapechos a 25 son 50 que NO pueden aparecer en ningún sitio.
    expect(resumen.total).not.toBe(75);
    expect(resumen.unavailableCodes).toEqual(['trancapecho']);
  });

  it('y se puede decir QUÉ se agotó, con su nombre', () => {
    // Es lo que hace `CartPanel`: cruza los códigos caídos con la carta ENTERA,
    // que es la única lista donde el agotado todavía tiene nombre.
    const { unavailableCodes } = summarizeCart({ trancapecho: 1, hamburguesa: 1 }, A_LA_VENTA);
    const nombres = unavailableCodes.map((code) => CARTA.find((i) => i.code === code)?.name);
    expect(nombres).toEqual(['Trancapecho']);
  });

  it('con TODA la carta agotada el menú tampoco cae', () => {
    // El caso límite: el negocio cierra la cocina y agota todo.
    const todoAgotado = CARTA.map((i) => ({ ...i, is_active: false }));
    const grupos = groupByCategory(filterMenuItems(todoAgotado, 'all', ''));

    expect(grupos[0].items).toHaveLength(3);
    expect(() => summarizeCart({ trancapecho: 1, hamburguesa: 2 }, [])).not.toThrow();
    expect(summarizeCart({ trancapecho: 1 }, []).total).toBe(0);
  });

  it('un código viejo que ya no existe no rompe ni se nombra', () => {
    // Un carrito de hace meses con un producto borrado del catálogo.
    const resumen = summarizeCart({ producto_borrado_2024: 3, hamburguesa: 1 }, A_LA_VENTA);
    expect(resumen.total).toBe(25);
    expect(resumen.unavailableCodes).toEqual(['producto_borrado_2024']);
    // `CartPanel` no encuentra su nombre, así que no lo menciona.
    expect(CARTA.find((i) => i.code === 'producto_borrado_2024')).toBeUndefined();
  });
});
