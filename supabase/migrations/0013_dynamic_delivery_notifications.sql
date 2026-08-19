-- ============================================================================
-- 0013_dynamic_delivery_notifications.sql — Fase 6D.2C
--
-- Flujo DURABLE de TRES mensajes para WEB + DELIVERY + delivery_pricing='dynamic':
--
--     order_received  →  location_request  →  confirmation (final con total/QR)
--
-- Gates (la BD es la barrera final, no solo TypeScript):
--   dynamic + awaiting_location + quote pending/failed
--       order_received  : PERMITIDO (sin dependencias)
--       location_request: PERMITIDA solo si order_received.status = 'sent'
--       confirmation    : BLOQUEADA (quote_not_applied)
--   dynamic + confirmed + quote quoted
--       confirmation    : PERMITIDA
--       order_received / location_request: ya enviados, no se repiten
--   dynamic + out_of_coverage
--       confirmation    : BLOQUEADA
--
-- LEGACY (delivery_pricing IS NULL): comportamiento EXACTO previo — confirmation
-- primero, location_request tras confirmation 'sent'. Cubre create_order_web,
-- create_order_web_v2, históricos, WhatsApp Flow y pickup v3 (que NO crea
-- order_received).
--
-- BASE REAL de cada función (no 0005 a ciegas):
--   - select_due_notification_orders y terminalize_exhausted_reconciliation
--     parten de 0006 (conservan la 4ª rama: reconciling stale claimed_at<now-300s).
--   - claim_order_notification, claim_notification_reconciliation,
--     initialize_order_notifications, recover_stale_sending_notification,
--     mark_notification_sent_by_webhook, schedule_notification_send,
--     mark_order_notification_sent parten de 0005.
--
-- Todas CREATE OR REPLACE (misma firma y retorno). Requiere el CHECK ampliado de
-- 0012 (order_received admitido). NO toca: mark_location_request_sent,
-- mark_order_notification_failed, mark_order_notification_pending_reconciliation,
-- mark_reconciliation_sent, reschedule_*, helpers internal_*, is_ambiguous_*,
-- alertas (0007), el CHECK ni las columnas. Atómica: begin; ... commit;.
--
-- Aplicar manualmente tras 0001..0012.
-- ============================================================================

begin;

-- ============================================================================
-- initialize_order_notifications  (base 0005)
--
-- delivery dinámico → crea las TRES filas:
--   order_received  : pending, next_attempt_at = now()  (activa)
--   location_request: pending, next_attempt_at = NULL    (dormida hasta OR sent)
--   confirmation    : pending, next_attempt_at = NULL    (dormida hasta quoted)
-- pickup / delivery legacy: sin order_received; comportamiento previo.
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
  v_next_attempt timestamptz;
  v_dynamic boolean;
begin
  if p_order_id is null then
    raise exception 'order_id required' using errcode = '22023';
  end if;

  select id, delivery_type, status, menu_session_id, delivery_pricing
    into v_order
  from public.orders
  where id = p_order_id
  for update;

  if not found then
    return jsonb_build_object('initialized', false, 'reason', 'order_not_found');
  end if;

  if v_order.menu_session_id is null then
    return jsonb_build_object('initialized', false, 'reason', 'not_web_order');
  end if;

  v_dynamic := v_order.delivery_pricing = 'dynamic';

  if v_order.delivery_type = 'pickup' and v_order.status = 'confirmed' then
    v_types := array['confirmation'];
  elsif v_order.delivery_type = 'delivery' and v_order.status = 'awaiting_location' then
    if v_dynamic then
      v_types := array['order_received', 'confirmation', 'location_request'];
    else
      v_types := array['confirmation', 'location_request'];
    end if;
  else
    return jsonb_build_object(
      'initialized', false, 'reason', 'status_not_initial', 'status', v_order.status
    );
  end if;

  foreach v_type in array v_types loop
    v_inserted := null;

    -- 6D.2C: en dinámico SOLO order_received nace programada; confirmation y
    -- location_request nacen DORMIDAS (las despiertan order_received-sent y la
    -- cotización, respectivamente). Legacy/pickup: todo programado now().
    if v_dynamic and v_type <> 'order_received' then
      v_next_attempt := null;
    else
      v_next_attempt := now();
    end if;

    insert into public.order_notifications (
      order_id, notification_type, status, next_attempt_at
    )
    values (p_order_id, v_type, 'pending', v_next_attempt)
    on conflict (order_id, notification_type) do nothing
    returning id into v_inserted;

    if v_inserted is not null then
      v_created := array_append(v_created, v_type);
    end if;
  end loop;

  return jsonb_build_object(
    'initialized', true,
    'required_types', to_jsonb(v_types),
    'created_types', to_jsonb(v_created)
  );
end;
$$;

-- ============================================================================
-- claim_order_notification  (base 0005)                     (invariantes I2 + I3)
--
-- Añade el 3er tipo y los gates dinámicos:
--   - order_received: sin dependencias.
--   - location_request dinámico: exige order_received 'sent' (order_received_not_sent).
--   - location_request legacy: exige confirmation 'sent' (confirmation_not_sent).
--   - confirmation dinámica: exige quote = 'quoted' (quote_not_applied).
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
  v_dep_sent boolean;
  v_pricing text;
  v_quote text;
begin
  if p_order_id is null then
    raise exception 'order_id required' using errcode = '22023';
  end if;
  if p_notification_type is null
     or p_notification_type not in ('order_received', 'confirmation', 'location_request') then
    raise exception 'invalid notification_type' using errcode = '22023';
  end if;
  if p_stale_seconds is null or p_stale_seconds < 120 or p_stale_seconds > 3600 then
    raise exception 'p_stale_seconds out of range' using errcode = '22023';
  end if;

  select *
    into v_row
  from public.order_notifications
  where order_id = p_order_id
    and notification_type = p_notification_type
  for update;

  if not found then
    return jsonb_build_object('claimed', false, 'reason', 'not_initialized');
  end if;

  if v_row.terminal_at is not null then
    return jsonb_build_object('claimed', false, 'reason', 'terminal');
  end if;
  if v_row.manual_review_required then
    return jsonb_build_object('claimed', false, 'reason', 'manual_review_required');
  end if;

  if v_row.status = 'sending' then
    if v_row.claimed_at is not null
       and v_row.claimed_at < now() - make_interval(secs => p_stale_seconds) then
      return jsonb_build_object('claimed', false, 'reason', 'requires_reconciliation');
    end if;
    return jsonb_build_object('claimed', false, 'reason', 'in_flight', 'status', 'sending');
  end if;

  if v_row.status in ('pending_reconciliation', 'reconciling') then
    return jsonb_build_object('claimed', false, 'reason', 'requires_reconciliation');
  end if;

  if v_row.status = 'sent' then
    return jsonb_build_object('claimed', false, 'status', 'sent');
  end if;

  if v_row.status = 'failed'
     and public.is_ambiguous_notification_error(v_row.last_error_code) then
    return jsonb_build_object('claimed', false, 'reason', 'requires_reconciliation');
  end if;

  if v_row.status = 'failed'
     and (v_row.next_attempt_at is null or v_row.next_attempt_at > now()) then
    return jsonb_build_object('claimed', false, 'reason', 'not_scheduled');
  end if;

  if v_row.attempt_count >= v_row.max_attempts then
    return jsonb_build_object('claimed', false, 'reason', 'max_attempts_reached');
  end if;

  -- 6D.2C: modo de pricing del pedido para los gates dinámicos.
  select o.delivery_pricing, o.delivery_quote_status
    into v_pricing, v_quote
  from public.orders o
  where o.id = p_order_id;

  -- Confirmación dinámica: bloqueada hasta la cotización. Legacy/pickup no entra.
  if p_notification_type = 'confirmation'
     and v_pricing = 'dynamic'
     and v_quote is distinct from 'quoted' then
    return jsonb_build_object('claimed', false, 'reason', 'quote_not_applied');
  end if;

  -- Dependencia de la ubicación: dinámico → order_received; legacy → confirmation.
  if p_notification_type = 'location_request' then
    if v_pricing = 'dynamic' then
      select exists (
        select 1 from public.order_notifications orr
        where orr.order_id = p_order_id
          and orr.notification_type = 'order_received'
          and orr.status = 'sent'
      ) into v_dep_sent;

      if not v_dep_sent then
        return jsonb_build_object('claimed', false, 'reason', 'order_received_not_sent');
      end if;
    else
      select exists (
        select 1 from public.order_notifications c
        where c.order_id = p_order_id
          and c.notification_type = 'confirmation'
          and c.status = 'sent'
      ) into v_dep_sent;

      if not v_dep_sent then
        return jsonb_build_object('claimed', false, 'reason', 'confirmation_not_sent');
      end if;
    end if;
  end if;

  v_token := gen_random_uuid();

  update public.order_notifications
     set status          = 'sending',
         claim_token     = v_token,
         claimed_at      = now(),
         attempt_count   = attempt_count + 1,
         last_attempt_at = now(),
         last_error_code = null,
         next_attempt_at = null,
         updated_at      = now()
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
-- claim_notification_reconciliation  (base 0005)
--
-- Añade el 3er tipo y la MISMA inversión de la dependencia de ubicación
-- (dinámico → order_received sent; legacy → confirmation sent).
-- ============================================================================

create or replace function public.claim_notification_reconciliation(
  p_order_id uuid,
  p_notification_type text,
  p_stale_seconds integer default 300
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
  v_dep_sent boolean;
  v_pricing text;
begin
  if p_order_id is null then
    raise exception 'order_id required' using errcode = '22023';
  end if;
  if p_notification_type is null
     or p_notification_type not in ('order_received', 'confirmation', 'location_request') then
    raise exception 'invalid notification_type' using errcode = '22023';
  end if;
  if p_stale_seconds is null or p_stale_seconds < 120 or p_stale_seconds > 3600 then
    raise exception 'p_stale_seconds out of range' using errcode = '22023';
  end if;

  select *
    into v_row
  from public.order_notifications
  where order_id = p_order_id
    and notification_type = p_notification_type
  for update skip locked;

  if not found then
    return jsonb_build_object('claimed', false, 'reason', 'not_available');
  end if;

  if v_row.terminal_at is not null then
    return jsonb_build_object('claimed', false, 'reason', 'terminal');
  end if;
  if v_row.manual_review_required then
    return jsonb_build_object('claimed', false, 'reason', 'manual_review_required');
  end if;

  if v_row.reconciliation_attempt_count >= v_row.max_attempts then
    return jsonb_build_object('claimed', false, 'reason', 'max_attempts_reached');
  end if;

  if p_notification_type = 'location_request' then
    select o.delivery_pricing into v_pricing
    from public.orders o
    where o.id = p_order_id;

    if v_pricing = 'dynamic' then
      select exists (
        select 1 from public.order_notifications orr
        where orr.order_id = p_order_id
          and orr.notification_type = 'order_received'
          and orr.status = 'sent'
      ) into v_dep_sent;

      if not v_dep_sent then
        return jsonb_build_object('claimed', false, 'reason', 'order_received_not_sent');
      end if;
    else
      select exists (
        select 1 from public.order_notifications c
        where c.order_id = p_order_id
          and c.notification_type = 'confirmation'
          and c.status = 'sent'
      ) into v_dep_sent;

      if not v_dep_sent then
        return jsonb_build_object('claimed', false, 'reason', 'confirmation_not_sent');
      end if;
    end if;
  end if;

  v_claimable :=
       (
         v_row.status = 'pending_reconciliation'
         and v_row.reconciliation_due_at is not null
         and v_row.reconciliation_due_at <= now()
       )
    or (
      v_row.status = 'reconciling'
      and v_row.claimed_at is not null
      and v_row.claimed_at < now() - make_interval(secs => p_stale_seconds)
    );

  if not v_claimable then
    return jsonb_build_object('claimed', false, 'status', v_row.status);
  end if;

  v_token := gen_random_uuid();

  update public.order_notifications
     set status                       = 'reconciling',
         claim_token                  = v_token,
         claimed_at                   = now(),
         reconciliation_attempt_count = reconciliation_attempt_count + 1,
         updated_at                   = now()
   where id = v_row.id;

  return jsonb_build_object(
    'claimed', true,
    'notification_id', v_row.id,
    'order_id', v_row.order_id,
    'notification_type', v_row.notification_type,
    'claim_token', v_token,
    'reconciliation_attempt_count', v_row.reconciliation_attempt_count + 1,
    'max_attempts', v_row.max_attempts
  );
end;
$$;

-- ============================================================================
-- select_due_notification_orders  (base 0006 — CONSERVA la 4ª rama)
--
-- Descubrimiento. Ramas de 0006 intactas (envío, reconciliación due, sending
-- stale 120 s, RECONCILING STALE 300 s) + dinámicos:
--   - order_received: cubierto por la rama de envío (nace pending + now()).
--   - location_request dinámico dormido: descubrible si order_received 'sent'.
--   - confirmation dinámica dormida: descubrible si quote='quoted' (aunque
--     next_attempt_at sea NULL).
-- Exclusión: la confirmación de un dinámico NO cotizado nunca se descubre.
-- Gate de ubicación: legacy → confirmation sent; dinámico → order_received sent.
-- ============================================================================

create or replace function public.select_due_notification_orders(
  p_limit integer default 10
)
returns table (order_id uuid)
language plpgsql
security invoker
set search_path = public
as $$
begin
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'p_limit out of range' using errcode = '22023';
  end if;

  return query
  select distinct n.order_id
  from public.order_notifications n
  where n.terminal_at is null
    and n.manual_review_required = false
    -- No descubrir la confirmación de un dinámico aún no cotizado.
    and not (
      n.notification_type = 'confirmation'
      and exists (
        select 1 from public.orders o
        where o.id = n.order_id
          and o.delivery_pricing = 'dynamic'
          and o.delivery_quote_status is distinct from 'quoted'
      )
    )
    and (
      -- Reintento de ENVÍO explícitamente programado y vencido (0005).
      (
        n.status in ('pending', 'failed')
        and n.next_attempt_at is not null
        and n.next_attempt_at <= now()
        and n.attempt_count < n.max_attempts
        and not public.is_ambiguous_notification_error(n.last_error_code)
      )
      or
      -- 6D.2C: ubicación dinámica DORMIDA (next_attempt_at NULL). El gate de
      -- ubicación (más abajo) exige que order_received esté 'sent'.
      (
        n.notification_type = 'location_request'
        and n.status = 'pending'
        and n.attempt_count < n.max_attempts
        and exists (
          select 1 from public.orders o
          where o.id = n.order_id and o.delivery_pricing = 'dynamic'
        )
      )
      or
      -- 6D.2C: confirmación dinámica YA cotizada (dormida hasta la cotización).
      (
        n.notification_type = 'confirmation'
        and n.status = 'pending'
        and n.attempt_count < n.max_attempts
        and exists (
          select 1 from public.orders o
          where o.id = n.order_id
            and o.delivery_pricing = 'dynamic'
            and o.delivery_quote_status = 'quoted'
            and o.status = 'confirmed'
        )
      )
      or
      -- RECONCILIACIÓN explícitamente programada y vencida (0005).
      (
        n.status = 'pending_reconciliation'
        and n.reconciliation_due_at is not null
        and n.reconciliation_due_at <= now()
        and n.reconciliation_attempt_count < n.max_attempts
      )
      or
      -- RECUPERACIÓN de un 'sending' abandonado (0005).
      (
        n.status = 'sending'
        and n.claimed_at is not null
        and n.claimed_at < now() - interval '120 seconds'
      )
      or
      -- RECONCILIACIÓN ABANDONADA: un 'reconciling' cuyo claim venció (0006, 4ª rama).
      (
        n.status = 'reconciling'
        and n.claimed_at is not null
        and n.claimed_at < now() - interval '300 seconds'
      )
    )
    and (
      n.notification_type <> 'location_request'
      -- Legacy: la ubicación depende de la confirmación enviada.
      or exists (
        select 1 from public.order_notifications c
        where c.order_id = n.order_id
          and c.notification_type = 'confirmation'
          and c.status = 'sent'
      )
      -- Dinámico: la ubicación depende de order_received enviado.
      or exists (
        select 1
        from public.orders o
        join public.order_notifications orr
          on orr.order_id = o.id and orr.notification_type = 'order_received'
        where o.id = n.order_id
          and o.delivery_pricing = 'dynamic'
          and orr.status = 'sent'
      )
    )
  order by n.order_id
  limit p_limit;
end;
$$;

-- ============================================================================
-- recover_stale_sending_notification  (base 0005) — solo amplía el 3er tipo.
-- ============================================================================

create or replace function public.recover_stale_sending_notification(
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
begin
  if p_order_id is null then
    raise exception 'order_id required' using errcode = '22023';
  end if;
  if p_notification_type is null
     or p_notification_type not in ('order_received', 'confirmation', 'location_request') then
    raise exception 'invalid notification_type' using errcode = '22023';
  end if;
  if p_stale_seconds is null or p_stale_seconds < 120 or p_stale_seconds > 3600 then
    raise exception 'p_stale_seconds out of range' using errcode = '22023';
  end if;

  select *
    into v_row
  from public.order_notifications
  where order_id = p_order_id
    and notification_type = p_notification_type
  for update skip locked;

  if not found then
    return jsonb_build_object('recovered', false, 'reason', 'not_available');
  end if;

  if v_row.status <> 'sending' then
    return jsonb_build_object('recovered', false, 'reason', 'not_sending',
                              'status', v_row.status);
  end if;

  if v_row.claimed_at is null
     or v_row.claimed_at >= now() - make_interval(secs => p_stale_seconds) then
    return jsonb_build_object('recovered', false, 'reason', 'still_fresh');
  end if;

  update public.order_notifications
     set status                = 'pending_reconciliation',
         last_error_code       = 'stale_sending_unknown',
         reconciliation_due_at = now(),
         next_attempt_at       = null,
         claim_token           = null,
         claimed_at            = null,
         updated_at            = now()
   where id = v_row.id;

  return jsonb_build_object(
    'recovered', true,
    'notification_id', v_row.id,
    'attempt_count', v_row.attempt_count
  );
end;
$$;

-- ============================================================================
-- mark_order_notification_sent  (base 0005) — cierre de texto simple.
-- 6D.2C: acepta también 'order_received' (mismo cierre que 'confirmation', sin
-- doble escritura). 'location_request' sigue usando su propia RPC.
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
  v_row record;
begin
  if p_notification_id is null or p_claim_token is null then
    raise exception 'notification_id and claim_token required' using errcode = '22023';
  end if;
  if p_external_message_id is null or btrim(p_external_message_id) = '' then
    raise exception 'external_message_id required' using errcode = '22023';
  end if;

  select id, notification_type, status, claim_token, external_message_id
    into v_row
  from public.order_notifications
  where id = p_notification_id
  for update;

  if not found then return false; end if;
  -- Cierre de texto simple: confirmation u order_received. La ubicación NO.
  if v_row.notification_type not in ('confirmation', 'order_received') then return false; end if;

  -- Idempotencia frente a un webhook que ganó la carrera.
  if v_row.status = 'sent' then
    if v_row.external_message_id = p_external_message_id then
      return true;
    end if;
    perform public.internal_flag_manual_review(v_row.id);
    return false;
  end if;

  if v_row.status <> 'sending' then return false; end if;
  if v_row.claim_token is distinct from p_claim_token then return false; end if;

  perform public.internal_apply_notification_sent(
    v_row.id, p_external_message_id, 'send_response'
  );
  return true;
end;
$$;

-- ============================================================================
-- mark_notification_sent_by_webhook  (base 0005) — solo amplía el 3er tipo.
-- order_received se cierra por la vía genérica (no es location_request).
-- ============================================================================

create or replace function public.mark_notification_sent_by_webhook(
  p_order_id uuid,
  p_notification_type text,
  p_external_message_id text
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_row record;
  v_wamid text;
begin
  if p_order_id is null then
    raise exception 'order_id required' using errcode = '22023';
  end if;
  if p_notification_type is null
     or p_notification_type not in ('order_received', 'confirmation', 'location_request') then
    raise exception 'invalid notification_type' using errcode = '22023';
  end if;

  v_wamid := btrim(coalesce(p_external_message_id, ''));
  if v_wamid = '' then
    raise exception 'external_message_id required' using errcode = '22023';
  end if;

  select *
    into v_row
  from public.order_notifications
  where order_id = p_order_id
    and notification_type = p_notification_type
  for update;

  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;

  if v_row.status = 'sent' then
    if v_row.external_message_id = v_wamid then
      return jsonb_build_object('result', 'already_sent');
    end if;
    perform public.internal_flag_manual_review(v_row.id);
    return jsonb_build_object('result', 'conflict', 'manual_review_required', true);
  end if;

  if v_row.terminal_at is not null then
    return jsonb_build_object('result', 'terminal');
  end if;
  if v_row.manual_review_required then
    return jsonb_build_object('result', 'manual_review_required');
  end if;

  if v_row.status not in ('sending', 'pending_reconciliation', 'reconciling', 'failed') then
    return jsonb_build_object('result', 'invalid_state', 'status', v_row.status);
  end if;

  if v_row.notification_type = 'location_request'
     and not public.internal_claim_location_wamid(v_row.order_id, v_wamid) then
    perform public.internal_flag_manual_review(v_row.id);
    return jsonb_build_object('result', 'conflict', 'manual_review_required', true);
  end if;

  begin
    perform public.internal_apply_notification_sent(v_row.id, v_wamid, 'webhook');
  exception
    when unique_violation then
      return jsonb_build_object('result', 'duplicate_message_id');
  end;

  return jsonb_build_object('result', 'sent');
end;
$$;

-- ============================================================================
-- schedule_notification_send  (base 0005) — solo amplía el 3er tipo.
-- ============================================================================

create or replace function public.schedule_notification_send(
  p_order_id uuid,
  p_notification_type text,
  p_delay_seconds integer default 0
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_row record;
begin
  if p_order_id is null then
    raise exception 'order_id required' using errcode = '22023';
  end if;
  if p_notification_type is null
     or p_notification_type not in ('order_received', 'confirmation', 'location_request') then
    raise exception 'invalid notification_type' using errcode = '22023';
  end if;
  if p_delay_seconds is null or p_delay_seconds < 0 or p_delay_seconds > 86400 then
    raise exception 'p_delay_seconds out of range' using errcode = '22023';
  end if;

  select *
    into v_row
  from public.order_notifications
  where order_id = p_order_id
    and notification_type = p_notification_type
  for update;

  if not found then
    return jsonb_build_object('scheduled', false, 'reason', 'not_initialized');
  end if;
  if v_row.terminal_at is not null then
    return jsonb_build_object('scheduled', false, 'reason', 'terminal');
  end if;
  if v_row.manual_review_required then
    return jsonb_build_object('scheduled', false, 'reason', 'manual_review_required');
  end if;
  if v_row.status <> 'failed' then
    return jsonb_build_object('scheduled', false, 'reason', 'invalid_state',
                              'status', v_row.status);
  end if;
  if public.is_ambiguous_notification_error(v_row.last_error_code) then
    return jsonb_build_object('scheduled', false, 'reason', 'requires_reconciliation');
  end if;
  if v_row.attempt_count >= v_row.max_attempts then
    return jsonb_build_object('scheduled', false, 'reason', 'max_attempts_reached');
  end if;

  update public.order_notifications
     set next_attempt_at = now() + make_interval(secs => p_delay_seconds),
         updated_at      = now()
   where id = v_row.id;

  return jsonb_build_object('scheduled', true);
end;
$$;

-- ============================================================================
-- terminalize_exhausted_reconciliation  (base 0006) — solo amplía el 3er tipo.
-- ============================================================================

create or replace function public.terminalize_exhausted_reconciliation(
  p_order_id uuid,
  p_notification_type text,
  p_stale_seconds integer default 300
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_row record;
begin
  if p_order_id is null then
    raise exception 'order_id required' using errcode = '22023';
  end if;
  if p_notification_type is null
     or p_notification_type not in ('order_received', 'confirmation', 'location_request') then
    raise exception 'invalid notification_type' using errcode = '22023';
  end if;
  if p_stale_seconds is null or p_stale_seconds < 120 or p_stale_seconds > 3600 then
    raise exception 'p_stale_seconds out of range' using errcode = '22023';
  end if;

  select id, status, claimed_at, reconciliation_attempt_count, max_attempts,
         external_message_id, terminal_at, manual_review_required
    into v_row
  from public.order_notifications
  where order_id = p_order_id
    and notification_type = p_notification_type
  for update skip locked;

  if not found then
    return jsonb_build_object('terminalized', false, 'reason', 'not_available');
  end if;

  -- Una fila ya enviada nunca se degrada a fallo.
  if v_row.status = 'sent' then
    return jsonb_build_object('terminalized', false, 'reason', 'already_sent');
  end if;

  -- Ya cerrada por otra vía: idempotente.
  if v_row.terminal_at is not null then
    return jsonb_build_object('terminalized', false, 'reason', 'terminal');
  end if;

  if v_row.status <> 'reconciling' then
    return jsonb_build_object('terminalized', false, 'reason', 'not_reconciling',
                              'status', v_row.status);
  end if;

  if v_row.claimed_at is null
     or v_row.claimed_at >= now() - make_interval(secs => p_stale_seconds) then
    return jsonb_build_object('terminalized', false, 'reason', 'still_fresh');
  end if;

  if v_row.reconciliation_attempt_count < v_row.max_attempts then
    return jsonb_build_object('terminalized', false, 'reason', 'attempts_available');
  end if;

  update public.order_notifications
     set status                 = 'failed',
         last_error_code        = 'reconciliation_attempts_exhausted',
         last_attempt_at        = now(),
         terminal_at            = now(),
         manual_review_required = true,
         next_attempt_at        = null,
         reconciliation_due_at  = null,
         claim_token            = null,
         claimed_at             = null,
         updated_at             = now()
   where id = v_row.id;

  return jsonb_build_object('terminalized', true, 'notification_id', v_row.id);
end;
$$;

-- ============================================================================
-- Permisos — se re-otorgan (idempotente y autocontenido). Solo service_role.
-- ============================================================================

do $$
declare
  v_sig text;
begin
  foreach v_sig in array array[
    'initialize_order_notifications(uuid)',
    'claim_order_notification(uuid, text, integer)',
    'claim_notification_reconciliation(uuid, text, integer)',
    'select_due_notification_orders(integer)',
    'recover_stale_sending_notification(uuid, text, integer)',
    'mark_order_notification_sent(uuid, uuid, text)',
    'mark_notification_sent_by_webhook(uuid, text, text)',
    'schedule_notification_send(uuid, text, integer)',
    'terminalize_exhausted_reconciliation(uuid, text, integer)'
  ]
  loop
    execute format('revoke all on function public.%s from public', v_sig);
    execute format('revoke all on function public.%s from anon', v_sig);
    execute format('revoke all on function public.%s from authenticated', v_sig);
    execute format('grant execute on function public.%s to service_role', v_sig);
  end loop;
end;
$$;

commit;
