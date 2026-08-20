-- ============================================================================
-- 0019 — Aviso del pedido al grupo de reparto
--
-- Marca de tiempo del aviso enviado por Telegram al grupo de deliverys cuando
-- un pedido de delivery queda confirmado y cotizado.
--
-- Existe SOLO para la idempotencia. `dispatchConfirmation` puede ejecutarse más
-- de una vez sobre el mismo pedido —el envío directo y el descubrimiento por
-- `select_due` conviven a propósito—, y sin esta marca el grupo recibiría el
-- mismo pedido repetido.
--
-- El claim es un UPDATE condicional sobre la columna NULL, el mismo mecanismo
-- que ya usan `location_request_message_id` y las columnas de ubicación: solo
-- una ejecución concurrente puede escribirla.
--
-- NULL = todavía no se avisó. Los pedidos anteriores a esta migración quedan en
-- NULL, pero no se reenvían: el aviso solo se dispara en la transición a
-- cotizado, que para ellos ya ocurrió.
--
-- Idempotente.
-- ============================================================================

alter table public.orders
  add column if not exists delivery_notice_sent_at timestamptz;

comment on column public.orders.delivery_notice_sent_at is
  'Cuándo se avisó del pedido al grupo de reparto por Telegram. NULL = no avisado. '
  'Su único fin es evitar avisos duplicados (claim por UPDATE condicional).';
