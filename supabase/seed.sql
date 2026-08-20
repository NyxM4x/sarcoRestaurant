-- ============================================================================
-- Don Zarco Orders — Seed del menú
-- Aplicar DESPUÉS de la migración 0001_init.sql.
-- Idempotente: on conflict (code) no duplica ni pisa manualmente.
-- Precios en Bs. (BOB), según la carta oficial de "Don Zarco".
--
-- Este seed refleja la carta VIGENTE. Para una base ya existente con el
-- catálogo anterior (La Fija), la transición la hace 0017_don_zarco_menu.sql.
-- ============================================================================

insert into menu_items (code, name, category, price, sort_order) values
  -- Platos
  ('trancaburguer',    'Trancaburguer',     'plato',  30,  10),
  ('trancapecho',      'Trancapecho',       'plato',  18,  20),
  ('salchiburguer',    'Salchiburguer',     'plato',  18,  30),
  ('hamburguesa',      'Hamburguesa',       'plato',  15,  40),
  ('lomito',           'Lomito',            'plato',  18,  50),
  ('salchipapa',       'Salchipapa',        'plato',  18,  60),
  -- Bebidas
  ('gaseosa_2l',       'Gaseosa 2 L',       'bebida', 18,  70),
  ('gaseosa_personal', 'Gaseosa personal',  'bebida',  8,  80),
  -- Extras
  ('porcion_papas',    'Porción de papa',   'extra',   7, 100)
on conflict (code) do nothing;
