-- ============================================================================
-- 0039_mensaje_unico_de_ingreso.sql
--
-- UN SOLO MENSAJE cuando entra un pedido con delivery, en vez de dos.
--
-- ── Qué veía el cliente en su teléfono ──────────────────────────────────────
--
--   1) 📦 Recibimos tu pedido #42.
--      Ahora necesitamos tu ubicación para calcular el costo de delivery.
--   2) 📍 Pedido ORD-260919-042: envíame tu ubicación GPS, por favor…
--
-- Dos globos seguidos: el segundo repite lo que acaba de decir el primero y
-- arranca con un número largo que nadie lee. Ahora sale uno solo, que saluda el
-- pedido y pide la ubicación en el mismo mensaje.
--
-- ── Por qué esto tiene que cambiar en la BASE ───────────────────────────────
--
-- El orden "primero la recepción, después la ubicación" no vivía solo en el
-- código: estaba escrito en dos funciones. Mientras esa dependencia exista, la
-- ubicación no se puede reclamar hasta que conste enviada una recepción que ya
-- no se manda — y el pedido se quedaría MUDO, que es el peor fallo de todo el
-- sistema: el cliente confirma y no recibe nada.
--
--   1. initialize_order_notifications: el delivery dinámico deja de crear la
--      fila `order_received`. Nacen dos: location_request programada (es el
--      mensaje que sale) y confirmation dormida hasta la cotización.
--   2. claim_order_notification: la ubicación dinámica ya no depende de
--      order_received. Legacy y pickup conservan su dependencia intacta.
--   3. claim_notification_reconciliation: la misma caída, para que una
--      reconciliación no quede bloqueada por una fila que ya no existe.
--   4. Las filas `order_received` que quedaron PENDIENTES de pedidos ya
--      creados se cierran (ver el final del archivo).
--
-- ── El despliegue puede ir en cualquier orden ───────────────────────────────
--
-- El código nuevo funciona con la base vieja y con esta: si al reclamar la
-- ubicación la base contesta `order_received_not_sent`, manda los dos mensajes
-- de siempre. Así no existe la ventana en la que un pedido se quedaría sin
-- recibir nada, corra antes el SQL o antes el despliegue.
--
-- No se borra ninguna fila y las que constan `sent` no se tocan: son el
-- historial de lo que de verdad se mandó. Idempotente: `create or replace` y un
-- UPDATE acotado a lo que sigue pendiente.
--
-- Postgres / Supabase.
-- ============================================================================

begin;

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
    -- 0039: las MISMAS dos filas en dinámico y en legacy. Lo que las distingue
    -- ya no es cuáles nacen, sino cuál nace despierta (ver el bucle de abajo).
    v_types := array['confirmation', 'location_request'];
  else
    return jsonb_build_object(
      'initialized', false, 'reason', 'status_not_initial', 'status', v_order.status
    );
  end if;

  foreach v_type in array v_types loop
    v_inserted := null;

    -- 0039: en dinámico la que nace programada es location_request —el mensaje
    -- único de ingreso, que saluda el pedido y pide la ubicación— y
    -- confirmation sigue DORMIDA hasta que haya cotización aplicada.
    -- Legacy/pickup: todo programado now(), exactamente como antes.
    if v_dynamic and v_type = 'confirmation' then
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

  -- 0039: el dinámico YA NO espera a order_received. Ese mensaje dejó de
  -- existir y su contenido viaja dentro de este, así que la ubicación se
  -- reclama directamente. Legacy conserva su dependencia de la confirmación:
  -- ahí siguen siendo dos mensajes distintos.
  if p_notification_type = 'location_request' and v_pricing is distinct from 'dynamic' then
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

  -- 0039: la misma caída de dependencia que en `claim_order_notification`. Las
  -- dos tienen que decir lo mismo: si una reconciliación quedara bloqueada por
  -- un order_received que ya no existe, el envío ambiguo no se resolvería nunca
  -- y ese pedido se quedaría sin pedir la ubicación.
  if p_notification_type = 'location_request' then
    select o.delivery_pricing into v_pricing
    from public.orders o
    where o.id = p_order_id;

    if v_pricing is distinct from 'dynamic' then
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

-- ── Las recepciones que se quedaron a medias ────────────────────────────────
--
-- Un pedido creado minutos antes de esta migración tiene su `order_received`
-- todavía pendiente. Nadie la va a enviar ya: el código nuevo no la mira, y su
-- texto viaja dentro del mensaje de ubicación que ese mismo pedido va a
-- recibir. Dejarla pendiente la volvería eterna —`select_due_notification_orders`
-- la devolvería en cada barrido— así que se cierra con `terminal_at`, que es el
-- mecanismo que ya existe para "esta fila no tiene nada más que hacer".
--
-- Solo `pending`: lo que esté enviándose, reconciliándose o ya enviado sigue su
-- curso. Y solo `order_received`: ninguna otra fila se toca.
update public.order_notifications
   set terminal_at     = now(),
       next_attempt_at = null,
       updated_at      = now()
 where notification_type = 'order_received'
   and status = 'pending'
   and terminal_at is null;

commit;
