-- ============================================================================
-- 0018 — Retira la gaseosa pequeña del menú de Don Zarco
--
-- Heredada del catálogo de La Fija y nunca formó parte de la carta real: el
-- negocio vende gaseosa de 2 L y personal, nada más.
--
-- Se DESACTIVA, no se borra: `order_items.menu_item_id` es ON DELETE RESTRICT
-- y cualquier pedido histórico que la incluya debe seguir resolviendo. Queda
-- invisible en el menú e intacta en el histórico, igual que los productos
-- retirados en 0017.
--
-- Idempotente.
-- ============================================================================

update menu_items
   set is_active = false
 where code = 'gaseosa_pequena';
