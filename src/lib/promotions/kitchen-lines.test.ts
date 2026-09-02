import { describe, expect, it } from 'vitest';
import { promotionsToKitchenLines, type KitchenPromotionRow } from './kitchen-lines';

const COMBO = [
  { code: 'lomito', name: 'Lomito', unit_price: 30, quantity: 2 },
  { code: 'soda_peque', name: 'Soda Peque', unit_price: 5, quantity: 2 },
  { code: 'porcion_papas', name: 'Porción de papa', unit_price: 10, quantity: 2 },
];

const fila = (over: Partial<KitchenPromotionRow> = {}): KitchenPromotionRow => ({
  order_id: 'pedido-1',
  quantity: 1,
  components_snapshot: COMBO,
  ...over,
});

describe('los combos llegan a la cocina', () => {
  it('cada componente se convierte en una línea del ticket', () => {
    expect(promotionsToKitchenLines([fila()])).toEqual([
      { order_id: 'pedido-1', product_name_snapshot: 'Lomito', quantity: 2, product_code: 'lomito' },
      { order_id: 'pedido-1', product_name_snapshot: 'Soda Peque', quantity: 2, product_code: 'soda_peque' },
      { order_id: 'pedido-1', product_name_snapshot: 'Porción de papa', quantity: 2, product_code: 'porcion_papas' },
    ]);
  });

  it('pedir el combo dos veces duplica cada componente', () => {
    const lineas = promotionsToKitchenLines([fila({ quantity: 2 })]);
    expect(lineas.map((l) => l.quantity)).toEqual([4, 4, 4]);
  });

  it('no filtra precios: en el tablero de cocina no se cobra', () => {
    const lineas = promotionsToKitchenLines([fila()]);
    for (const linea of lineas) {
      // El código va porque el resumen del planchero lo necesita para repartir
      // por categoría. `unit_price` está en el snapshot y NO sale de ahí.
      expect(Object.keys(linea).sort()).toEqual([
        'order_id',
        'product_code',
        'product_name_snapshot',
        'quantity',
      ]);
    }
  });

  it('varios pedidos conservan cada uno su order_id', () => {
    const lineas = promotionsToKitchenLines([
      fila({ order_id: 'a' }),
      fila({ order_id: 'b', components_snapshot: [COMBO[0]] }),
    ]);
    expect(lineas.filter((l) => l.order_id === 'a')).toHaveLength(3);
    expect(lineas.filter((l) => l.order_id === 'b')).toHaveLength(1);
  });

  it('sin combos no produce líneas', () => {
    expect(promotionsToKitchenLines([])).toEqual([]);
  });
});

describe('un snapshot corrupto no tumba el tablero', () => {
  it('descarta un snapshot que no es un array', () => {
    for (const basura of [null, undefined, 'texto', 42, {}]) {
      expect(promotionsToKitchenLines([fila({ components_snapshot: basura })]), String(basura))
        .toEqual([]);
    }
  });

  it('descarta el componente sin nombre en vez de pintar una línea vacía', () => {
    const roto = [{ code: 'x', name: '   ', unit_price: 1, quantity: 2 }, COMBO[0]];
    const lineas = promotionsToKitchenLines([fila({ components_snapshot: roto })]);
    expect(lineas).toHaveLength(1);
    expect(lineas[0].product_name_snapshot).toBe('Lomito');
  });

  it('descarta cantidades que no son enteros positivos', () => {
    const roto = [
      { code: 'a', name: 'A', unit_price: 1, quantity: 0 },
      { code: 'b', name: 'B', unit_price: 1, quantity: -2 },
      { code: 'c', name: 'C', unit_price: 1, quantity: 1.5 },
      { code: 'd', name: 'D', unit_price: 1, quantity: 3 },
    ];
    const lineas = promotionsToKitchenLines([fila({ components_snapshot: roto })]);
    expect(lineas).toHaveLength(1);
    expect(lineas[0].product_name_snapshot).toBe('D');
  });

  it('descarta la promoción entera si su cantidad no tiene sentido', () => {
    expect(promotionsToKitchenLines([fila({ quantity: 0 })])).toEqual([]);
  });

  it('un pedido roto no arrastra a los demás del tablero', () => {
    const lineas = promotionsToKitchenLines([
      fila({ order_id: 'roto', components_snapshot: 'basura' }),
      fila({ order_id: 'sano' }),
    ]);
    expect(lineas.every((l) => l.order_id === 'sano')).toBe(true);
    expect(lineas).toHaveLength(3);
  });
});
