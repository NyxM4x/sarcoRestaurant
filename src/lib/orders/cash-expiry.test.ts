import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CASH_EXPIRY_NOTICE_WINDOW_MS,
  CASH_EXPIRY_ORDER_COLUMNS,
  shouldNotifyCashExpiry,
} from './cash-expiry';

const MIGRACIONES = fileURLToPath(new URL('../../../supabase/migrations/', import.meta.url));

/**
 * Columnas de `orders` según las migraciones: las del `create table` de 0001 y
 * las que agrega cada `alter table orders … add column`.
 */
function columnasDeOrders(): Set<string> {
  const columnas = new Set<string>();
  const archivos = readdirSync(MIGRACIONES).filter((f) => f.endsWith('.sql')).sort();
  for (const archivo of archivos) {
    const sql = readFileSync(join(MIGRACIONES, archivo), 'utf8');

    const creacion = /create table if not exists (?:public\.)?orders \(([\s\S]*?)\r?\n\);/i.exec(sql);
    if (creacion) {
      for (const m of creacion[1].matchAll(/^ {2}([a-z_][a-z0-9_]*)\s/gm)) columnas.add(m[1]);
    }

    for (const sentencia of sql.split(';')) {
      if (!/alter table\s+(?:public\.)?orders\b/i.test(sentencia)) continue;
      for (const m of sentencia.matchAll(/add column\s+(?:if not exists\s+)?([a-z_][a-z0-9_]*)/gi)) {
        columnas.add(m[1]);
      }
    }
  }
  return columnas;
}

describe('barrido de efectivo — la consulta', () => {
  it('el lector de migraciones ve las columnas de orders, y no las de otras tablas', () => {
    // Si esto falla, el test de abajo no prueba nada.
    const columnas = columnasDeOrders();
    expect(columnas.has('confirmed_at')).toBe(true);
    expect(columnas.has('payment_method')).toBe(true);
    expect(columnas.has('cash_confirmed_at')).toBe(true);
    // Existe, pero en `menu_sessions`.
    expect(columnas.has('phone_number_id')).toBe(false);
  });

  it('cada columna que pide el barrido existe en orders', () => {
    // El 14-09-2026 pedía `phone_number_id`: la consulta fallaba en cada latido
    // y 24 pedidos sin CONFIRMO seguían vivos, el más antiguo del 09-09.
    const columnas = columnasDeOrders();
    const pedidas = CASH_EXPIRY_ORDER_COLUMNS.split(',').map((c) => c.trim());
    expect(pedidas.filter((c) => !columnas.has(c))).toEqual([]);
  });
});

describe('barrido de efectivo — a quién se le avisa', () => {
  const NOW = Date.parse('2026-09-14T03:00:00Z');

  it('al que acaba de vencer (veinte minutos) se le avisa', () => {
    expect(shouldNotifyCashExpiry(NOW - 21 * 60_000, NOW)).toBe(true);
  });

  it('justo en el límite de la ventana todavía se avisa', () => {
    expect(shouldNotifyCashExpiry(NOW - CASH_EXPIRY_NOTICE_WINDOW_MS, NOW)).toBe(true);
  });

  it('al pedido de hace días se lo cancela en silencio', () => {
    // Los 24 que el primer latido va a encontrar al desplegar el arreglo.
    expect(shouldNotifyCashExpiry(Date.parse('2026-09-09T23:52:19Z'), NOW)).toBe(false);
  });

  it('sin fecha legible no se escribe a nadie', () => {
    expect(shouldNotifyCashExpiry(Number.NaN, NOW)).toBe(false);
  });
});
