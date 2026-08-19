-- ============================================================================
-- 0012_add_order_received_notification.sql — Fase 6D.2C
--
-- EXCLUSIVAMENTE de ESQUEMA: amplía el dominio de order_notifications.notification_type
-- para admitir el tercer mensaje durable del flujo dinámico:
--
--     'order_received'  (nuevo)  →  confirmation  →  location_request
--
-- Antes: check (notification_type in ('confirmation', 'location_request'))
-- Ahora: check (notification_type in ('order_received', 'confirmation', 'location_request'))
--
-- Ampliar un CHECK es BACKWARD-COMPATIBLE: ninguna fila existente lo viola, y bajo
-- Producción `acd7e64` (create_order_web_v2) NADIE crea filas 'order_received', así
-- que esta migración queda INERTE hasta que se despliegue el código 6D.2C.
--
-- NO toca: UNIQUE(order_id, notification_type), state_coherence, columnas,
-- índices, notification recovery ni ninguna función. Atómica: begin; ... commit;.
--
-- Aplicar manualmente tras 0001..0011.
-- ============================================================================

begin;

alter table public.order_notifications
  drop constraint if exists order_notifications_type_check;

alter table public.order_notifications
  add constraint order_notifications_type_check
  check (notification_type in ('order_received', 'confirmation', 'location_request'));

commit;
