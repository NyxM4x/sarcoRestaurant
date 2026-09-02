-- ============================================================================
-- 0030 — Bebidas: fuera las gaseosas, entran las sodas y los vasos
--
-- Cambio de CARTA pedido por el negocio el 02-09-2026. No hay lógica nueva:
-- son filas de `menu_items`.
--
-- ── Lo que sale ─────────────────────────────────────────────────────────────
--
--   · Gaseosa 2 L (18 Bs)      — deja de venderse.
--   · Gaseosa personal (8 Bs)  — deja de venderse.
--
-- `is_active = false` y NO `delete`, igual que 0018 con la gaseosa pequeña. Dos
-- motivos: `order_items.menu_item_id` es ON DELETE RESTRICT, así que un
-- producto que aparece en un pedido no se puede borrar; y los snapshots de
-- nombre y precio conservan el detalle histórico tal como se vendió.
--
-- ── Lo que entra ────────────────────────────────────────────────────────────
--
--   · Soda Peque (5 Bs) y Soda Mini (4 Bs) — sustituyen a las gaseosas.
--   · Cuatro vasos grandes a 4 Bs: maracuyá, limonada, lima y piña.
--
-- Códigos NUEVOS (`soda_peque`, `soda_mini`, …) en vez de renombrar
-- `gaseosa_pequena`, que quedó inactiva en 0018 y también costaba 5 Bs. El
-- código es la identidad estable del producto —viaja en los pedidos y en el
-- menú web—, y reciclar el de un producto retirado haría que un "Soda Peque"
-- de hoy y una "Gaseosa pequeña" de agosto fueran indistinguibles al consultar.
--
-- ── Sobre `sort_order` ──────────────────────────────────────────────────────
--
-- 70 a 80, el hueco que dejan las gaseosas: las bebidas siguen entre los platos
-- (10-60) y los extras (100). Paso de 2 para poder intercalar una bebida nueva
-- sin renumerar la carta entera.
--
-- NO ejecutar automáticamente. Aplicar manualmente después de 0029.
-- Postgres / Supabase.
-- ============================================================================

begin;

-- ── Bajas ───────────────────────────────────────────────────────────────────

update menu_items
   set is_active = false
 where code in ('gaseosa_2l', 'gaseosa_personal');

-- ── Altas ───────────────────────────────────────────────────────────────────
--
-- `on conflict (code)` para que reaplicar la migración no falle ni duplique: si
-- el producto ya está, se le reponen nombre, precio, orden y disponibilidad.
insert into menu_items (code, name, category, price, is_active, sort_order)
values
  ('soda_peque',    'Soda Peque',              'bebida', 5, true, 70),
  ('soda_mini',     'Soda Mini',               'bebida', 4, true, 72),
  ('vaso_maracuya', 'Vaso grande de maracuyá', 'bebida', 4, true, 74),
  ('vaso_limonada', 'Vaso grande de limonada', 'bebida', 4, true, 76),
  ('vaso_lima',     'Vaso grande de lima',     'bebida', 4, true, 78),
  ('vaso_pina',     'Vaso grande de piña',     'bebida', 4, true, 80)
on conflict (code) do update
   set name       = excluded.name,
       category   = excluded.category,
       price      = excluded.price,
       is_active  = excluded.is_active,
       sort_order = excluded.sort_order;

commit;

-- ── Comprobación ────────────────────────────────────────────────────────────
select code, name, price, is_active, sort_order
  from menu_items
 where category = 'bebida'
 order by is_active desc, sort_order;
