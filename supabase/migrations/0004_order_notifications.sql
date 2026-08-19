-- ============================================================================
-- La Fija Orders — Notificaciones salientes de pedidos (0004_order_notifications)
--
-- Introduce el rastreo transaccional de los mensajes de WhatsApp que se envían
-- tras un checkout web (Fase 5.2D):
-- - Tabla public.order_notifications: una fila por (pedido, tipo de mensaje),
--   con máquina de estados pending → sending → sent | failed.
-- - Claim atómico (SELECT ... FOR UPDATE) para que dos ejecuciones concurrentes
--   NO puedan enviar ambas el mismo mensaje.
-- - RPC de inicialización explícita, claim y cierre (sent / failed), todas
--   service_role-only.
--
-- La inicialización NO es automática: solo crea filas cuando el backend la pide
-- para un pedido web nuevo (created:true) o vía el reintento interno explícito.
-- Esta migración NO inserta ni migra pedidos existentes.
--
-- NO ejecutar automáticamente. Aplicar manualmente después de 0001 + 0002 + 0003.
-- Postgres / Supabase.
--
-- Toda la migración se aplica de forma atómica: begin; ... commit;. Si algo
-- falla, no queda nada a medias (no dependas del SQL Editor para envolverla).
-- ============================================================================

begin;

-- ── Tabla public.order_notifications ────────────────────────────────────────

create table if not exists public.order_notifications (
  id                  uuid primary key default gen_random_uuid(),
  order_id            uuid not null references public.orders (id) on delete cascade,
  notification_type   text not null,
  status              text not null default 'pending',
  claim_token         uuid,
  claimed_at          timestamptz,
  external_message_id text,
  attempt_count       integer not null default 0,
  last_error_code     text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  sent_at             timestamptz,

  -- Dominios cerrados.
  constraint order_notifications_type_check
    check (notification_type in ('confirmation', 'location_request')),
  constraint order_notifications_status_check
    check (status in ('pending', 'sending', 'sent', 'failed')),

  -- Un intento nunca es negativo.
  constraint order_notifications_attempt_count_check
    check (attempt_count >= 0),

  -- Si hay wamid, no puede ser cadena vacía.
  constraint order_notifications_external_message_id_not_empty
    check (external_message_id is null or btrim(external_message_id) <> ''),

  -- Código de error: cuando existe, corto y sin caracteres inseguros. Nunca
  -- mensajes técnicos, respuestas completas, JSON, teléfonos ni secretos.
  constraint order_notifications_last_error_code_format
    check (last_error_code is null or last_error_code ~ '^[A-Za-z0-9._:-]{1,64}$'),

  -- Una notificación por tipo y pedido (genera su propio índice único).
  constraint order_notifications_order_type_unique
    unique (order_id, notification_type),

  -- Coherencia estado ↔ columnas: cada estado fija exactamente qué campos
  -- pueden estar poblados. Impide filas imposibles (p. ej. 'sent' sin wamid,
  -- 'sending' sin claim_token, o un 'failed' sin código de error).
  constraint order_notifications_state_coherence check (
    (
      status = 'pending'
      and claim_token is null
      and claimed_at is null
      and external_message_id is null
      and sent_at is null
      and last_error_code is null
    )
    or (
      status = 'sending'
      and claim_token is not null
      and claimed_at is not null
      and external_message_id is null
      and sent_at is null
      and last_error_code is null
    )
    or (
      status = 'failed'
      and claim_token is null
      and claimed_at is null
      and external_message_id is null
      and sent_at is null
      and last_error_code is not null
    )
    or (
      status = 'sent'
      and claim_token is null
      and claimed_at is null
      and external_message_id is not null
      and sent_at is not null
      and last_error_code is null
    )
  )
);

-- Unicidad global del wamid saliente, solo cuando existe (índice parcial).
create unique index if not exists uq_order_notifications_external_message_id
  on public.order_notifications (external_message_id)
  where external_message_id is not null;

-- updated_at automático (reutiliza el trigger genérico de 0001).
drop trigger if exists trg_order_notifications_updated_at on public.order_notifications;
create trigger trg_order_notifications_updated_at
  before update on public.order_notifications
  for each row execute function public.set_updated_at();

-- RLS habilitado SIN políticas: anon/authenticated quedan cerrados por defecto.
-- Solo service_role (que omite RLS) accede, y únicamente a través de las RPC.
alter table public.order_notifications enable row level security;

-- ============================================================================
-- RPC 1: initialize_order_notifications
--
-- Crea (idempotentemente) las filas de notificación que corresponden a un
-- pedido WEB nuevo. NO envía nada, NO escanea otros pedidos, NO acepta teléfono
-- ni phone_number_id ni texto. La inicialización es la ÚNICA vía de creación de
-- filas: las RPC de claim jamás insertan.
--
-- Uso previsto:
--   - automático solo para checkout con created:true;
--   - explícito desde el endpoint interno de reintento.
-- Nunca automático cuando created:false.
-- ============================================================================

create or replace function public.initialize_order_notifications(
  p_order_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_order record;
  v_types text[];
  v_created text[] := array[]::text[];
  v_type text;
  v_inserted uuid;
begin
  if p_order_id is null then
    raise exception 'order_id required' using errcode = '22023';
  end if;

  -- Bloquear el pedido: serializa contra inicializaciones concurrentes del
  -- mismo pedido y contra cambios de estado durante la decisión.
  select id, delivery_type, status, menu_session_id
    into v_order
  from public.orders
  where id = p_order_id
  for update;

  if not found then
    return jsonb_build_object('initialized', false, 'reason', 'order_not_found');
  end if;

  -- Solo pedidos web (creados desde /menu). Los de WhatsApp Flow (menu_session_id
  -- NULL) tienen su propio flujo de ubicación y quedan fuera.
  if v_order.menu_session_id is null then
    return jsonb_build_object('initialized', false, 'reason', 'not_web_order');
  end if;

  -- Tipos requeridos según el estado INICIAL del pedido web.
  if v_order.delivery_type = 'pickup' and v_order.status = 'confirmed' then
    v_types := array['confirmation'];
  elsif v_order.delivery_type = 'delivery' and v_order.status = 'awaiting_location' then
    v_types := array['confirmation', 'location_request'];
  else
    -- Estado no inicial (ya avanzó o combinación inesperada): no crear nada.
    return jsonb_build_object(
      'initialized', false,
      'reason', 'status_not_initial',
      'status', v_order.status
    );
  end if;

  foreach v_type in array v_types loop
    v_inserted := null;

    insert into public.order_notifications (order_id, notification_type, status)
    values (p_order_id, v_type, 'pending')
    on conflict (order_id, notification_type) do nothing
    returning id into v_inserted;

    if v_inserted is not null then
      v_created := array_append(v_created, v_type);
    end if;
  end loop;

  -- Información mínima y no sensible: qué tipos se requieren y cuáles se crearon
  -- en esta llamada (los ya existentes no vuelven a crearse).
  return jsonb_build_object(
    'initialized', true,
    'required_types', to_jsonb(v_types),
    'created_types', to_jsonb(v_created)
  );
end;
$$;

-- ============================================================================
-- RPC 2: claim_order_notification
--
-- Reclama atómicamente una notificación para enviarla. NO inserta filas (eso es
-- responsabilidad exclusiva de initialize_order_notifications). El SELECT ...
-- FOR UPDATE serializa a los concurrentes: solo uno obtiene claimed:true.
-- ============================================================================

create or replace function public.claim_order_notification(
  p_order_id uuid,
  p_notification_type text,
  p_stale_seconds integer default 120
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_row record;
  v_token uuid;
  v_claimable boolean;
begin
  if p_order_id is null then
    raise exception 'order_id required' using errcode = '22023';
  end if;
  if p_notification_type is null
     or p_notification_type not in ('confirmation', 'location_request') then
    raise exception 'invalid notification_type' using errcode = '22023';
  end if;
  -- Rango seguro para la ventana de reclamo de un 'sending' vencido.
  if p_stale_seconds is null or p_stale_seconds < 30 or p_stale_seconds > 3600 then
    raise exception 'p_stale_seconds out of range' using errcode = '22023';
  end if;

  -- Lock de fila ANTES de decidir: dos ejecuciones se serializan aquí.
  select *
    into v_row
  from public.order_notifications
  where order_id = p_order_id
    and notification_type = p_notification_type
  for update;

  if not found then
    -- Sin inicializar: no se crea nada, no hay nada que reclamar.
    return jsonb_build_object('claimed', false, 'reason', 'not_initialized');
  end if;

  -- Reclamable si: pending, failed, o sending cuyo claim ya venció (stale).
  v_claimable :=
       v_row.status = 'pending'
    or v_row.status = 'failed'
    or (
      v_row.status = 'sending'
      and v_row.claimed_at is not null
      and v_row.claimed_at < now() - make_interval(secs => p_stale_seconds)
    );

  if not v_claimable then
    -- 'sent' (terminal) o 'sending' fresco (otro dispatch en vuelo).
    return jsonb_build_object('claimed', false, 'status', v_row.status);
  end if;

  v_token := gen_random_uuid();

  update public.order_notifications
     set status = 'sending',
         claim_token = v_token,
         claimed_at = now(),
         attempt_count = attempt_count + 1,
         last_error_code = null,
         updated_at = now()
   where id = v_row.id;

  return jsonb_build_object(
    'claimed', true,
    'notification_id', v_row.id,
    'claim_token', v_token,
    'attempt_count', v_row.attempt_count + 1
  );
end;
$$;

-- ============================================================================
-- RPC 3: mark_order_notification_sent
--
-- Cierre exitoso de una notificación de CONFIRMACIÓN. Solo el dueño del claim
-- vigente puede cerrarla (claim_token coincidente y status = 'sending').
-- ============================================================================

create or replace function public.mark_order_notification_sent(
  p_notification_id uuid,
  p_claim_token uuid,
  p_external_message_id text
)
returns boolean
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_updated int;
begin
  if p_notification_id is null or p_claim_token is null then
    raise exception 'notification_id and claim_token required' using errcode = '22023';
  end if;
  if p_external_message_id is null or btrim(p_external_message_id) = '' then
    raise exception 'external_message_id required' using errcode = '22023';
  end if;

  update public.order_notifications
     set status = 'sent',
         external_message_id = p_external_message_id,
         sent_at = now(),
         claim_token = null,
         claimed_at = null,
         last_error_code = null,
         updated_at = now()
   where id = p_notification_id
     and claim_token = p_claim_token
     and status = 'sending'
     and notification_type = 'confirmation';

  get diagnostics v_updated = row_count;
  return v_updated > 0;
end;
$$;

-- ============================================================================
-- RPC 4: mark_location_request_sent
--
-- Cierre exitoso de una notificación de UBICACIÓN. Debe hacer DOS escrituras en
-- una sola transacción: marcar la notificación 'sent' y persistir el wamid en
-- orders.location_request_message_id (que el webhook necesita para correlacionar
-- por context.id), SIN sobrescribir jamás un wamid distinto ya presente.
-- ============================================================================

create or replace function public.mark_location_request_sent(
  p_notification_id uuid,
  p_claim_token uuid,
  p_wamid text
)
returns boolean
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_notif record;
  v_order record;
begin
  if p_notification_id is null or p_claim_token is null then
    raise exception 'notification_id and claim_token required' using errcode = '22023';
  end if;
  if p_wamid is null or btrim(p_wamid) = '' then
    raise exception 'wamid required' using errcode = '22023';
  end if;

  -- 1. Bloquear la notificación y validar tipo, estado y propiedad del claim.
  select id, order_id, notification_type, status, claim_token
    into v_notif
  from public.order_notifications
  where id = p_notification_id
  for update;

  if not found then return false; end if;
  if v_notif.notification_type <> 'location_request' then return false; end if;
  if v_notif.status <> 'sending' then return false; end if;
  if v_notif.claim_token is distinct from p_claim_token then return false; end if;

  -- 2. Bloquear el pedido y resolver el wamid de ubicación.
  select id, location_request_message_id
    into v_order
  from public.orders
  where id = v_notif.order_id
  for update;

  if not found then return false; end if;

  if v_order.location_request_message_id is null then
    -- Aún no hay solicitud registrada: escribir la nuestra.
    update public.orders
       set location_request_message_id = p_wamid
     where id = v_order.id;
  elsif v_order.location_request_message_id = p_wamid then
    -- Idempotente: el pedido ya tenía exactamente este wamid.
    null;
  else
    -- Ya existe un wamid DIFERENTE: no sobrescribir y no marcar sent.
    return false;
  end if;

  -- 3. Marcar la notificación 'sent' con el mismo wamid.
  update public.order_notifications
     set status = 'sent',
         external_message_id = p_wamid,
         sent_at = now(),
         claim_token = null,
         claimed_at = null,
         last_error_code = null,
         updated_at = now()
   where id = v_notif.id;

  return true;
end;
$$;

-- ============================================================================
-- RPC 5: mark_order_notification_failed
--
-- Cierre fallido: devuelve la notificación a 'failed' (reclamable de nuevo).
-- Solo el dueño del claim vigente puede fallarla. Guarda únicamente un código
-- corto y sanitizado; nunca mensajes, respuestas de Kapso, teléfonos ni secretos.
-- ============================================================================

create or replace function public.mark_order_notification_failed(
  p_notification_id uuid,
  p_claim_token uuid,
  p_error_code text
)
returns boolean
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_updated int;
  v_code text;
begin
  if p_notification_id is null or p_claim_token is null then
    raise exception 'notification_id and claim_token required' using errcode = '22023';
  end if;

  -- Normalizar con btrim y aplicar EXACTAMENTE la misma validación que la
  -- columna: un código corto y seguro, nunca mensajes técnicos, respuestas
  -- completas, JSON, teléfonos ni secretos. Un 'failed' siempre lleva código.
  v_code := btrim(coalesce(p_error_code, ''));
  if v_code !~ '^[A-Za-z0-9._:-]{1,64}$' then
    raise exception 'invalid error_code' using errcode = '22023';
  end if;

  update public.order_notifications
     set status = 'failed',
         claim_token = null,
         claimed_at = null,
         last_error_code = v_code,
         updated_at = now()
   where id = p_notification_id
     and claim_token = p_claim_token
     and status = 'sending';

  get diagnostics v_updated = row_count;
  return v_updated > 0;
end;
$$;

-- ============================================================================
-- Permisos
--
-- Tabla y funciones: exclusivamente service_role (backend con
-- SUPABASE_SERVICE_ROLE_KEY). Las funciones son security invoker, así que el
-- invocador (service_role) necesita privilegios sobre la tabla.
-- ============================================================================

-- Tabla.
revoke all on table public.order_notifications from public;
revoke all on table public.order_notifications from anon;
revoke all on table public.order_notifications from authenticated;
grant select, insert, update, delete on table public.order_notifications to service_role;

-- initialize_order_notifications(uuid)
revoke all on function public.initialize_order_notifications(uuid) from public;
revoke all on function public.initialize_order_notifications(uuid) from anon;
revoke all on function public.initialize_order_notifications(uuid) from authenticated;
grant execute on function public.initialize_order_notifications(uuid) to service_role;

-- claim_order_notification(uuid, text, integer)
revoke all on function public.claim_order_notification(uuid, text, integer) from public;
revoke all on function public.claim_order_notification(uuid, text, integer) from anon;
revoke all on function public.claim_order_notification(uuid, text, integer) from authenticated;
grant execute on function public.claim_order_notification(uuid, text, integer) to service_role;

-- mark_order_notification_sent(uuid, uuid, text)
revoke all on function public.mark_order_notification_sent(uuid, uuid, text) from public;
revoke all on function public.mark_order_notification_sent(uuid, uuid, text) from anon;
revoke all on function public.mark_order_notification_sent(uuid, uuid, text) from authenticated;
grant execute on function public.mark_order_notification_sent(uuid, uuid, text) to service_role;

-- mark_location_request_sent(uuid, uuid, text)
revoke all on function public.mark_location_request_sent(uuid, uuid, text) from public;
revoke all on function public.mark_location_request_sent(uuid, uuid, text) from anon;
revoke all on function public.mark_location_request_sent(uuid, uuid, text) from authenticated;
grant execute on function public.mark_location_request_sent(uuid, uuid, text) to service_role;

-- mark_order_notification_failed(uuid, uuid, text)
revoke all on function public.mark_order_notification_failed(uuid, uuid, text) from public;
revoke all on function public.mark_order_notification_failed(uuid, uuid, text) from anon;
revoke all on function public.mark_order_notification_failed(uuid, uuid, text) from authenticated;
grant execute on function public.mark_order_notification_failed(uuid, uuid, text) to service_role;

commit;
