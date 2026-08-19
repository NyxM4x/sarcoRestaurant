-- ============================================================================
-- La Fija Orders — Seed del menú
-- Aplicar DESPUÉS de la migración 0001_init.sql.
-- Idempotente: on conflict (code) no duplica ni pisa manualmente.
-- Precios en Bs. (BOB). Fuente de verdad de precios (IDEA.md §3, §9).
-- ============================================================================

insert into menu_items (code, name, category, price, sort_order) values
  -- Platos
  ('la_fija',          'La Fija',           'plato',  22, 10),
  ('doble_o_nada',     'Doble o Nada',      'plato',  32, 20),
  ('hat_trick',        'Hat Trick',         'plato',  42, 30),
  ('lomito_jackpot',   'Lomito Jackpot',    'plato',  25, 40),
  -- Bebidas
  ('gaseosa_2l',       'Gaseosa 2 L',       'bebida', 18, 50),
  ('gaseosa_personal', 'Gaseosa personal',  'bebida',  8, 60),
  ('gaseosa_pequena',  'Gaseosa pequeña',   'bebida',  5, 70),
  -- Extras
  ('tocino',           'Tocino',            'extra',   5, 80),
  ('porcion_papas',    'Porción de papas',  'extra',  10, 90)
on conflict (code) do nothing;
