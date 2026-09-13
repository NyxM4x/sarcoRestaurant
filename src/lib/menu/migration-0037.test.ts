import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { MenuItem } from '@/types';
import { parseStoredCart, summarizeCart } from '@/lib/cart/cart';
import { filterMenuItems, groupByCategory } from './catalog';

/**
 * 0037 — BORRAR un producto del catálogo, no dejarlo agotado.
 *
 * Dos mitades que se sostienen entre sí:
 *
 *   1. El SQL borra de verdad, y NO borra si algo referencia la fila.
 *   2. El cliente que tenía esa fila en el carrito de su navegador —guardado
 *      desde antes del borrado— sigue pudiendo abrir el menú.
 *
 * La segunda es la que exige el test. En `58e077b` agotar un trancapecho dejó
 * sin menú a quien lo tenía guardado: `calculateOrder` lanzaba dentro del render
 * de `useCart` y se llevaba el árbol entero. Borrar una fila es el MISMO
 * escenario visto desde el otro lado —el código guardado deja de existir en la
 * carta— y la garantía tiene que valer también aquí.
 */

const M0037 = readFileSync(
  fileURLToPath(
    new URL('../../../supabase/migrations/0037_borra_gaseosa_pequena.sql', import.meta.url),
  ),
  'utf8',
);

describe('0037 — el SQL', () => {
  it('BORRA la fila; no vuelve a desactivarla', () => {
    // 0018 ya hizo `is_active = false`. Repetirlo es justo lo que no arregla
    // nada: el producto seguiría en la vitrina, en gris, prometiendo un
    // "Agotado" que nunca va a dejar de estarlo.
    expect(M0037).toContain('delete from public.menu_items where id = v_id');
    expect(M0037).not.toMatch(/set\s+is_active/);
  });

  it('cuenta las referencias contra el catálogo de Postgres, no contra una lista', () => {
    // `promotion_items` (0031) casi se escapa de la revisión a mano porque está
    // escrita `references public.menu_items` y se la buscaba sin el esquema.
    // Preguntándole a `pg_constraint`, una FK nueva entra sola.
    expect(M0037).toContain("con.confrelid = 'public.menu_items'::regclass");
    // Y por lo mismo, ninguna tabla aparece nombrada a mano en el recuento.
    expect(M0037).not.toMatch(/from public\.(order_items|promotion_items)/);
  });

  it('si algo la referencia, aborta y lo dice', () => {
    expect(M0037).toContain('raise exception');
    expect(M0037).toMatch(/if v_uso <> ''/);
  });

  it('es idempotente: aplicarla dos veces no falla', () => {
    expect(M0037).toMatch(/if v_id is null then/);
    expect(M0037).toContain('raise notice');
  });

  it('va en una transacción', () => {
    expect(M0037.split('\n').some((l) => l.trim() === 'begin;')).toBe(true);
    expect(M0037.trimEnd().endsWith('commit;')).toBe(true);
  });
});

// ── La carta tal como la devuelve `listAll()` DESPUÉS de aplicar 0037 ────────
//
// `gaseosa_pequena` no está: no es una fila inactiva, es una fila que no existe.
// Las otras dos gaseosas SÍ siguen: 0030 las desactivó y ahí quedaron, así que
// el menú las sigue enseñando en gris. Son el contraste que da sentido al
// escenario — retirar y borrar dejan la carta en dos estados distintos.
const producto = (
  code: string,
  name: string,
  category: MenuItem['category'],
  price: number,
  activo: boolean,
  orden: number,
): MenuItem => ({
  id: `id-${code}`,
  code,
  name,
  category,
  price,
  is_active: activo,
  sort_order: orden,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
});

const CARTA: MenuItem[] = [
  producto('trancapecho', 'Trancapecho', 'plato', 25, true, 10),
  producto('hamburguesa', 'Hamburguesa', 'plato', 20, true, 20),
  producto('soda_peque', 'Soda Peque', 'bebida', 5, true, 70),
  producto('soda_mini', 'Soda Mini', 'bebida', 4, true, 72),
  producto('gaseosa_2l', 'Gaseosa 2 L', 'bebida', 18, false, 74),
  producto('gaseosa_personal', 'Gaseosa personal', 'bebida', 8, false, 76),
];

/** La lista que ve el carrito: lo que se puede cobrar. */
const A_LA_VENTA = CARTA.filter((item) => item.is_active);

/** Lo que quedó guardado en el navegador de un cliente de agosto. */
const CARRITO_VIEJO = '{"gaseosa_pequena":2,"hamburguesa":1}';

describe('0037 — el cliente que la tenía en el carrito', () => {
  it('el carrito guardado SÍ la conserva: el riesgo es real', () => {
    // `parseStoredCart` solo valida la forma —código no vacío, cantidad entera
    // en rango—, no el catálogo. Así que el código borrado entra igual, y quien
    // tiene que absorberlo es `summarizeCart`. Si esto empezara a devolver
    // `{ hamburguesa: 1 }`, el resto de este bloque dejaría de probar nada.
    expect(parseStoredCart(CARRITO_VIEJO)).toEqual({ gaseosa_pequena: 2, hamburguesa: 1 });
  });

  it('EL MENÚ CARGA: resumir ese carrito no lanza', () => {
    expect(() => summarizeCart(parseStoredCart(CARRITO_VIEJO), A_LA_VENTA)).not.toThrow();
  });

  it('carga también con la gaseosa SOLA, que es el caso que tumbaba todo', () => {
    // Sin nada más en el carrito no queda ni una línea que calcular, y ahí es
    // donde `calculateOrder` lanza "El pedido debe incluir al menos un producto".
    expect(() => summarizeCart({ gaseosa_pequena: 3 }, A_LA_VENTA)).not.toThrow();

    const resumen = summarizeCart({ gaseosa_pequena: 3 }, A_LA_VENTA);
    expect(resumen.lines).toEqual([]);
    expect(resumen.total).toBe(0);
    expect(resumen.units).toBe(0);
    expect(resumen.unavailableCodes).toEqual(['gaseosa_pequena']);
  });

  it('no se cobra, y lo que sí se vende se cobra bien', () => {
    const resumen = summarizeCart(parseStoredCart(CARRITO_VIEJO), A_LA_VENTA);

    expect(resumen.lines.map((l) => l.product_code)).toEqual(['hamburguesa']);
    expect(resumen.total).toBe(20);
    // Dos gaseosas a 5 son 10 Bs que no pueden aparecer en ningún sitio.
    expect(resumen.total).not.toBe(30);
    expect(resumen.unavailableCodes).toEqual(['gaseosa_pequena']);
  });

  it('y nadie puede nombrarla: `CartPanel` no la menciona', () => {
    // El aviso de "esto se agotó" cruza los códigos caídos con la carta entera
    // para sacarles el nombre. Una fila borrada no tiene nombre en ninguna
    // lista, así que el cliente no lee nada sobre un producto que no existe.
    expect(CARTA.find((i) => i.code === 'gaseosa_pequena')).toBeUndefined();
  });
});

describe('0037 — el menú de los demás clientes', () => {
  it('la gaseosa pequeña no aparece, ni en gris', () => {
    const grupos = groupByCategory(filterMenuItems(CARTA, 'all', ''));
    const codigos = grupos.flatMap((g) => g.items.map((i) => i.code));
    expect(codigos).not.toContain('gaseosa_pequena');
  });

  it('buscarla por su nombre no devuelve nada suyo', () => {
    const encontrados = filterMenuItems(CARTA, 'all', 'gaseosa peque');
    expect(encontrados.map((i) => i.code)).not.toContain('gaseosa_pequena');
  });

  it('la carta sigue entera: nada más se movió', () => {
    const grupos = groupByCategory(filterMenuItems(CARTA, 'all', ''));
    expect(grupos.map((g) => g.category)).toEqual(['plato', 'bebida']);

    // Lo activo primero, lo agotado al final de su grupo (07-09-2026).
    expect(grupos[1].items.map((i) => i.code)).toEqual([
      'soda_peque',
      'soda_mini',
      'gaseosa_2l',
      'gaseosa_personal',
    ]);
  });

  it('un carrito normal de hoy se cobra como siempre', () => {
    const resumen = summarizeCart({ trancapecho: 2, soda_peque: 1 }, A_LA_VENTA);
    expect(resumen.total).toBe(55);
    expect(resumen.unavailableCodes).toEqual([]);
  });
});
