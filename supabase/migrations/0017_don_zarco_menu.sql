-- ============================================================================
-- 0017 — Carta de Don Zarco (rebranding desde La Fija)
--
-- Reemplaza el catálogo de hamburguesas de La Fija por la carta real de
-- "Don Zarco" — Trancapecho Cochabambino. Precios en Bs. (BOB), tomados de la
-- carta oficial del cliente.
--
-- NO se borra ningún producto: `order_items.menu_item_id` es ON DELETE
-- RESTRICT y los pedidos históricos deben seguir resolviendo. Los productos
-- descontinuados se marcan `is_active = false`, que es exactamente el
-- mecanismo previsto en 0001_init.sql. El menú del cliente solo lista activos.
--
-- Idempotente: se puede reaplicar sin duplicar ni pisar precios manuales
-- posteriores... salvo los que esta migración fija a propósito (ver el
-- `do update` de abajo, que sí normaliza nombre/precio/orden a la carta).
-- ============================================================================

-- ── 1. Productos descontinuados de La Fija ──────────────────────────────────
-- Las hamburguesas de marca y el tocino no forman parte de la carta de Don
-- Zarco. Quedan inactivos: invisibles en el menú, intactos en el histórico.
update menu_items
   set is_active = false
 where code in ('la_fija', 'doble_o_nada', 'hat_trick', 'lomito_jackpot', 'tocino');

-- ── 2. Carta de Don Zarco ───────────────────────────────────────────────────
-- Las gaseosas se conservan tal cual (el cliente aún no define su carta de
-- refrescos) y `porcion_papas` se reutiliza con el nombre y precio nuevos.
insert into menu_items (code, name, category, price, sort_order, is_active) values
  -- Platos
  ('trancaburguer',    'Trancaburguer',     'plato',  30,  10, true),
  ('trancapecho',      'Trancapecho',       'plato',  18,  20, true),
  ('salchiburguer',    'Salchiburguer',     'plato',  18,  30, true),
  ('hamburguesa',      'Hamburguesa',       'plato',  15,  40, true),
  ('lomito',           'Lomito',            'plato',  18,  50, true),
  ('salchipapa',       'Salchipapa',        'plato',  18,  60, true),
  -- Bebidas (heredadas: pendientes de definir con el cliente)
  ('gaseosa_2l',       'Gaseosa 2 L',       'bebida', 18,  70, true),
  ('gaseosa_personal', 'Gaseosa personal',  'bebida',  8,  80, true),
  ('gaseosa_pequena',  'Gaseosa pequeña',   'bebida',  5,  90, true),
  -- Extras
  ('porcion_papas',    'Porción de papa',   'extra',   7, 100, true)
on conflict (code) do update
   set name       = excluded.name,
       category   = excluded.category,
       price      = excluded.price,
       sort_order = excluded.sort_order,
       is_active  = excluded.is_active;
