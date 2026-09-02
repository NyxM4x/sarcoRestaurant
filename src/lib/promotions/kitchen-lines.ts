import type { RawKitchenItemRow } from '@/lib/kitchen/ticket-view';

/**
 * Los combos, vistos desde la cocina — módulo PURO.
 *
 * ── El problema que resuelve ────────────────────────────────────────────────
 *
 * Los componentes de una promoción NO están en `order_items`: viven congelados
 * en `order_promotions.components_snapshot`, porque si fueran líneas sueltas el
 * mismo lomito se contaría dos veces y el subtotal saldría el doble.
 *
 * Correcto para el dinero, y desastroso para la cocina: un pedido de Bs 60 se
 * vería en el tablero SIN NADA que preparar. Alguien tendría que adivinar.
 *
 * ── Por qué se aplanan y no se pintan como "combo" ──────────────────────────
 *
 * Quien cocina no necesita saber que dos lomitos venían juntos y con descuento:
 * necesita saber que hay DOS lomitos. Aplanar los componentes los mete en las
 * mismas líneas que el resto y todo lo demás sigue funcionando igual — el
 * agrupado por nombre, el recuento del ticket y el resumen de la jornada.
 *
 * El efecto secundario es el correcto: un pedido con un lomito suelto MÁS un
 * combo de dos lomitos muestra "3× Lomito", que es exactamente lo que hay que
 * poner en la plancha. Pintarlos por separado obligaría a sumar de cabeza.
 *
 * El precio y el ahorro no aparecen por ningún lado, y no deben: en el tablero
 * de cocina no se cobra.
 */

/** Un componente tal como quedó congelado en el snapshot del pedido. */
interface SnapshotComponent {
  code: string;
  name: string;
  unit_price: number;
  quantity: number;
}

/** Fila de `order_promotions` con lo justo para la cocina. */
export interface KitchenPromotionRow {
  order_id: string;
  /** Cuántas veces se pidió el combo. Multiplica a cada componente. */
  quantity: number;
  components_snapshot: unknown;
}

/**
 * Convierte los combos de un tablero en líneas de ticket normales.
 *
 * El snapshot llega como `unknown` a propósito: es `jsonb` escrito hace semanas
 * y puede tener cualquier forma si alguna vez cambió el formato. Se valida cada
 * campo antes de usarlo, y lo que no encaja se descarta en silencio — un
 * componente ilegible no puede tumbar el tablero entero en plena hora punta.
 */
export function promotionsToKitchenLines(rows: KitchenPromotionRow[]): RawKitchenItemRow[] {
  const lineas: RawKitchenItemRow[] = [];

  for (const row of rows) {
    if (typeof row.order_id !== 'string' || row.order_id === '') continue;

    const vecesElCombo = Number(row.quantity);
    if (!Number.isFinite(vecesElCombo) || vecesElCombo < 1) continue;

    for (const componente of leerComponentes(row.components_snapshot)) {
      lineas.push({
        order_id: row.order_id,
        product_name_snapshot: componente.name,
        quantity: componente.quantity * vecesElCombo,
      });
    }
  }

  return lineas;
}

/** Lee el snapshot con desconfianza. Devuelve solo lo que es utilizable. */
function leerComponentes(snapshot: unknown): SnapshotComponent[] {
  if (!Array.isArray(snapshot)) return [];

  const salida: SnapshotComponent[] = [];
  for (const bruto of snapshot) {
    if (typeof bruto !== 'object' || bruto === null) continue;
    const c = bruto as Record<string, unknown>;

    const name = typeof c.name === 'string' ? c.name.trim() : '';
    // Sin nombre no hay línea que pintar: una fila vacía en el ticket es peor
    // que una línea de menos, porque parece un producto y no se puede preguntar
    // cuál es.
    if (name === '') continue;

    const quantity = Number(c.quantity);
    if (!Number.isInteger(quantity) || quantity < 1) continue;

    salida.push({
      code: typeof c.code === 'string' ? c.code : '',
      name,
      unit_price: Number(c.unit_price) || 0,
      quantity,
    });
  }

  return salida;
}
