-- ============================================================================
-- 0035 — El menú que se abre para CAMBIAR un pedido, no para hacer otro
--
-- El cliente arma su pedido, recibe su total y su QR… y entonces se acuerda de
-- la soda. Hasta hoy eso no tenía camino: si volvía al menú y pedía otra vez,
-- el negocio se encontraba con DOS pedidos suyos —dos comandas, dos envíos, dos
-- QR— y alguien tenía que entrar al chat a deshacer el enredo a mano.
--
-- Esta columna es todo lo que hacía falta para que ese segundo pedido no sea un
-- pedido nuevo, sino el mismo corregido: la sesión de menú lleva escrito a qué
-- pedido viene a sustituir.
--
-- ── Por qué en la SESIÓN y no en el pedido nuevo ────────────────────────────
--
-- Porque la intención existe ANTES que el pedido nuevo. Cuando el cliente toca
-- "Cambiar mi pedido" todavía no ha elegido nada; lo único que consta es que
-- ese enlace nació para reemplazar. Guardarlo en el pedido obligaría a que el
-- navegador lo mandara en el checkout —un dato de negocio viajando por el
-- cliente, que es justo lo que `create_order_web_v4` evita releyendo todo de la
-- base— y a confiar en que no lo cambie.
--
-- Así, el enlace es la autoridad: quien lo abre puede reemplazar ESE pedido y
-- ningún otro, y el enlace lo emitimos nosotros.
--
-- ── Por qué `on delete set null` y no `cascade` ─────────────────────────────
--
-- Si el pedido de origen desapareciera, la sesión sigue siendo una sesión
-- válida: el cliente puede armar su pedido igual, solo que ya no reemplaza
-- nada. Borrar su enlace por eso lo dejaría con un botón muerto en el chat.
--
-- ── Lo que esta migración NO hace ───────────────────────────────────────────
--
-- No cancela nada, no copia ubicaciones y no toca `create_order_web_v4`. La
-- columna es solo el dato; quién lo escribe y qué se hace con él vive en el
-- código (`menu/session-service.ts` y `orders/order-replacement.ts`). Una
-- migración que además decidiera política obligaría a desplegar base y código
-- en el mismo instante.
--
-- NO ejecutar automáticamente. Aplicar manualmente después de 0034.
-- Postgres / Supabase.
-- ============================================================================

begin;

alter table menu_sessions
  add column if not exists replaces_order_id uuid
    references orders(id) on delete set null;

comment on column menu_sessions.replaces_order_id is
  'Pedido al que este enlace viene a sustituir (botón "Cambiar mi pedido"). '
  'NULL = sesión normal, que crea un pedido nuevo sin tocar ninguno anterior.';

-- Índice PARCIAL: la inmensa mayoría de las sesiones no reemplazan nada, y no
-- tienen por qué ocupar sitio en él. Sirve para responder "¿hay un enlace de
-- cambio vivo para este pedido?" sin recorrer la tabla entera.
create index if not exists ix_menu_sessions_replaces_order
  on menu_sessions (replaces_order_id)
  where replaces_order_id is not null;

commit;
