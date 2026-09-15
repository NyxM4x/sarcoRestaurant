-- ============================================================================
-- 0038 — Pausa de pedidos nuevos: "estamos saturados, escribinos más tarde"
--
-- La noche del 14-09-2026, con la promoción de trancapechos, la cocina se llenó
-- más rápido de lo que podía despachar: pagos aceptados sin iniciar, tickets
-- en preparación de hace una hora. Cada pedido nuevo que entraba era un
-- reclamo que se estaba fabricando.
--
-- Hace falta poder decir "ahora no" SIN cerrar el negocio: los pedidos que ya
-- entraron siguen su curso —comprobantes, ubicación, cocina—, y lo único que se
-- detiene es la entrada de pedidos NUEVOS.
--
-- ── Por qué en `delivery_settings` ──────────────────────────────────────────
--
-- Es la fila única de interruptores que el encargado mueve desde el panel
-- (0024), y ya se lee y escribe desde ahí con permisos probados. Una tabla
-- nueva para un booleano duplicaría el patrón sin ganar nada.
--
-- ── Por qué nace en false ───────────────────────────────────────────────────
--
-- Aplicar la migración no puede pausar nada: encenderla es un acto aparte y
-- explícito del encargado. Y si el código llega a producción ANTES que esta
-- columna, la lectura falla y se trata como "no pausado": los pedidos siguen
-- entrando, que es lo de siempre.
--
-- Idempotente: aplicarla dos veces no falla.
--
-- NO ejecutar automáticamente. Aplicar manualmente después de 0037.
-- Postgres / Supabase.
-- ============================================================================

begin;

alter table public.delivery_settings
  add column if not exists orders_paused boolean not null default false;

commit;
