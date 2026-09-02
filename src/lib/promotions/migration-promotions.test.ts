import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Guardias sobre el SQL de 0031 y 0032.
 *
 * No ejecutan PostgreSQL: leen el archivo y comprueban que las decisiones que
 * sostienen el dinero y la privacidad siguen escritas. Es el mismo patrón que
 * `migration-0009.test.ts` y compañía, y sirve para lo mismo — que un cambio de
 * mañana no borre sin querer la línea que impedía cobrar de más.
 */

const leer = (nombre: string): string =>
  readFileSync(
    fileURLToPath(new URL(`../../../supabase/migrations/${nombre}`, import.meta.url)),
    'utf8',
  );

const M0031 = leer('0031_promotions.sql');
const M0032 = leer('0032_create_order_web_v4.sql');

describe('0031 — modelo de promociones', () => {
  it('crea las tres tablas', () => {
    for (const tabla of ['promotions', 'promotion_items', 'order_promotions']) {
      expect(M0031, tabla).toContain(`create table if not exists public.${tabla}`);
    }
  });

  it('NO guarda el precio normal: lo calcula', () => {
    // Una columna `normal_price` en `promotions` sería una copia que envejece.
    // Se acota a ESA tabla: `order_promotions` sí guarda un
    // `normal_price_snapshot`, y debe — es el histórico de lo ya vendido.
    const tablaPromotions = M0031.slice(
      M0031.indexOf('create table if not exists public.promotions ('),
      M0031.indexOf('create index if not exists idx_promotions_active'),
    );
    expect(tablaPromotions).not.toContain('normal_price');
    expect(M0031).toContain('create or replace function public.promotion_normal_price');
  });

  it('el precio del combo tiene que ser positivo', () => {
    expect(M0031).toContain('check (promo_price > 0)');
  });

  it('una promoción nace apagada', () => {
    expect(M0031).toMatch(/is_active\s+boolean not null default false/);
  });

  it('un producto no puede repetirse dentro del mismo combo', () => {
    expect(M0031).toContain('unique (promotion_id, menu_item_id)');
  });

  it('la revisión la sube un trigger, no la aplicación', () => {
    expect(M0031).toContain('create or replace function public.bump_promotion_revision');
    expect(M0031).toContain('trg_promotions_revision');
  });

  it('el snapshot del pedido exige que hubiera ahorro', () => {
    expect(M0031).toContain('check (promo_price_snapshot < normal_price_snapshot)');
  });

  it('el histórico del pedido no se puede editar ni borrar', () => {
    expect(M0031).toContain('revoke all on table public.order_promotions from service_role');
    expect(M0031).toContain('grant select, insert on table public.order_promotions to service_role');
    expect(M0031).not.toMatch(/grant[^;]*update[^;]*order_promotions/);
  });

  it('RLS encendido en las tres tablas y sin puerta pública', () => {
    for (const tabla of ['promotions', 'promotion_items', 'order_promotions']) {
      expect(M0031, tabla).toMatch(
        new RegExp(`alter table public\\.${tabla}\\s+enable row level security`),
      );
      expect(M0031, tabla).toContain(`revoke all on table public.${tabla}`);
    }
    expect(M0031).not.toContain('create policy');
  });

  it('el componente retirado y el combo sin ahorro tienen estado propio', () => {
    for (const estado of [
      'not_found',
      'incomplete',
      'component_unavailable',
      'disabled',
      'scheduled',
      'expired',
      'no_savings',
      'available',
    ]) {
      expect(M0031, estado).toContain(`'${estado}'`);
    }
  });

  it('exige dos unidades, no dos productos distintos', () => {
    expect(M0031).toContain('v_units < 2');
  });
});

describe('0032 — create_order_web_v4', () => {
  it('crea v4 y no toca las versiones anteriores', () => {
    expect(M0032).toContain('create or replace function public.create_order_web_v4');
    expect(M0032).not.toContain('drop function public.create_order_web_v3');
    expect(M0032).not.toMatch(/create (or replace )?function public\.create_order_web_v3/);
  });

  it('acepta promociones con un default, para no romper a quien no las manda', () => {
    expect(M0032).toContain("p_promotions_json jsonb default '[]'::jsonb");
  });

  it('el precio del combo sale de la base, nunca del request', () => {
    // Se cobra `v_avail.promo_price`, que viene de `promotion_availability`.
    expect(M0032).toContain('v_avail.promo_price * v_promo.quantity');
    // Y en ningún sitio se lee un precio del JSON de entrada.
    expect(M0032).not.toMatch(/->>\s*'promo_price'/);
    expect(M0032).not.toMatch(/->>\s*'price'/);
    expect(M0032).not.toMatch(/->>\s*'savings'/);
  });

  it('bloquea la promoción y sus componentes antes de decidir', () => {
    expect(M0032).toContain('for share');
    expect(M0032).toContain('for share of m');
  });

  it('usa la MISMA función de disponibilidad que el panel y el menú', () => {
    expect(M0032).toContain('public.promotion_availability(v_promo.promotion_id, now())');
  });

  it('comprueba la regla monetaria justo antes de cobrar', () => {
    expect(M0032).toContain('v_avail.promo_price >= v_avail.normal_price');
    expect(M0032).toContain('price_not_below_normal');
  });

  it('rechaza con un mensaje parseable y su SQLSTATE propio', () => {
    expect(M0032).toContain("errcode = 'P1004'");
    expect(M0032).toContain('promotion_rejected:');
  });

  it('admite un carrito de solo promociones pero no uno vacío', () => {
    expect(M0032).toContain('v_line_count = 0 and v_promo_count = 0');
    expect(M0032).toContain("raise exception 'order must have at least one item'");
  });

  it('no mete los componentes del combo en order_items: se contarían dos veces', () => {
    // Se aísla la SENTENCIA del insert (hasta su punto y coma) y se comprueba
    // que no lee de las tablas de promociones. El bloque que viene después sí
    // las consulta, y debe: es el que arma el snapshot del combo.
    const desde = M0032.indexOf('insert into public.order_items');
    const sentencia = M0032.slice(desde, M0032.indexOf(';', desde));
    expect(sentencia).toContain('from jsonb_array_elements(p_items_json)');
    expect(sentencia).not.toContain('promotion');
  });

  it('congela la composición vendida en el snapshot', () => {
    expect(M0032).toContain('components_snapshot');
    for (const campo of ['code', 'name', 'unit_price', 'quantity']) {
      expect(M0032, campo).toContain(`'${campo}',`);
    }
  });

  it('la función es solo para el backend', () => {
    expect(M0032).toContain('to service_role');
    expect(M0032).toMatch(/revoke all on function public\.create_order_web_v4[\s\S]*?from anon/);
    expect(M0032).toMatch(/revoke all on function public\.create_order_web_v4[\s\S]*?from authenticated/);
  });
});
