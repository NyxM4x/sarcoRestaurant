-- ============================================================================
-- La Fija Orders — Claims atómicos para alertas de incidencias (0007)
--
-- Añade el ciclo de ENTREGA DE ALERTA (Telegram) sobre las notificaciones que
-- YA requieren intervención humana, con deduplicación entre workers concurrentes.
--
-- Una alerta NO es una fila nueva: se DESCUBRE desde el estado de incidencia de
-- la propia notificación (manual_review_required = true OR terminal_at not null)
-- que aún no fue alertada (alerted_at is null). Las columnas alert_* solo rastrean
-- la entrega de la alerta; alerted_at (de 0005) se REUTILIZA como marca de éxito.
--
-- INVARIANTES:
--   - Solo se alertan incidencias confirmadas (manual_review/terminal). Los
--     pedidos normales NUNCA inicializan una alerta.
--   - Un claim atómico impide que dos workers envíen la misma alerta.
--   - Ninguna RPC envía mensajes (ni WhatsApp ni Telegram), toca
--     external_message_id/sent_at, ni degrada status = 'sent'.
--   - Una alerta enviada (alerted_at not null / alert_status='sent') no se
--     vuelve a seleccionar. Una alerta fallida se reintenta con retraso; agotados
--     los intentos queda 'failed' (requiere humano) y deja de reintentarse.
--
-- NO modifica 0005 ni 0006. NO crea alertas para todas las order_notifications.
-- Aplicar manualmente tras 0001..0006. Atómica.
-- ============================================================================

begin;

-- ── 1. Columnas del ciclo de entrega de alerta ──────────────────────────────
-- alerted_at ya existe (0005) y es la marca de "alerta entregada".

alter table public.order_notifications
  add column if not exists alert_status          text,
  add column if not exists alert_claim_token     uuid,
  add column if not exists alert_claimed_at       timestamptz,
  add column if not exists alert_attempt_count    integer not null default 0,
  add column if not exists alert_next_attempt_at  timestamptz,
  add column if not exists alert_last_error_code  text;

-- ── 2. Dominio y coherencia del estado de alerta ────────────────────────────

alter table public.order_notifications
  drop constraint if exists order_notifications_alert_status_check;
alter table public.order_notifications
  add constraint order_notifications_alert_status_check
  check (
    alert_status is null
    or alert_status in ('pending', 'alerting', 'sent', 'failed')
  );

alter table public.order_notifications
  drop constraint if exists order_notifications_alert_attempt_count_check;
alter table public.order_notifications
  add constraint order_notifications_alert_attempt_count_check
  check (alert_attempt_count >= 0);

-- Solo 'alerting' está reclamada; cualquier otro estado no tiene claim.
alter table public.order_notifications
  drop constraint if exists order_notifications_alert_claim_coherence;
alter table public.order_notifications
  add constraint order_notifications_alert_claim_coherence
  check (
    (alert_status is distinct from 'alerting'
       and alert_claim_token is null and alert_claimed_at is null)
    or
    (alert_status = 'alerting'
       and alert_claim_token is not null and alert_claimed_at is not null)
  );

-- Una alerta marcada 'sent' exige su marca de entrega.
alter table public.order_notifications
  drop constraint if exists order_notifications_alert_sent_coherence;
alter table public.order_notifications
  add constraint order_notifications_alert_sent_coherence
  check (alert_status is distinct from 'sent' or alerted_at is not null);

-- ── 3. Índice de descubrimiento (parcial) ───────────────────────────────────

create index if not exists ix_order_notifications_due_alert
  on public.order_notifications (alert_next_attempt_at)
  where alerted_at is null
    and (manual_review_required = true or terminal_at is not null);

-- ============================================================================
-- RPC: select_due_notification_alerts
--
-- Descubre incidencias que requieren ALERTA y aún no fueron alertadas. Solo
-- lectura. Devuelve notification ids únicos, sin datos sensibles.
-- ============================================================================

create or replace function public.select_due_notification_alerts(
  p_limit integer default 10
)
returns table (notification_id uuid)
language plpgsql
security invoker
set search_path = public
as $$
begin
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'p_limit out of range' using errcode = '22023';
  end if;

  return query
  select n.id
  from public.order_notifications n
  where n.alerted_at is null
    and (n.manual_review_required = true or n.terminal_at is not null)
    and coalesce(n.alert_status, 'pending') not in ('sent', 'failed')
    and n.alert_attempt_count < 5
    and (
      n.alert_status is null
      or (
        n.alert_status = 'pending'
        and (n.alert_next_attempt_at is null or n.alert_next_attempt_at <= now())
      )
      or (
        -- Claim de alerta abandonado: recuperable tras el umbral stale.
        n.alert_status = 'alerting'
        and n.alert_claimed_at is not null
        and n.alert_claimed_at < now() - interval '300 seconds'
      )
    )
  order by n.id
  limit p_limit;
end;
$$;

-- ============================================================================
-- RPC: claim_notification_alert
--
-- Transición: (null | pending | alerting-stale) → alerting. Claim atómico con
-- token nuevo e incremento de intento. Devuelve el contexto SANITIZADO para
-- construir el texto (order_number, tipo, código de error, clase de revisión).
-- Nunca envía nada.
-- ============================================================================

create or replace function public.claim_notification_alert(
  p_notification_id uuid,
  p_stale_seconds integer default 300
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_row record;
  v_order_number text;
  v_token uuid;
  v_claimable boolean;
begin
  if p_notification_id is null then
    raise exception 'notification_id required' using errcode = '22023';
  end if;
  if p_stale_seconds is null or p_stale_seconds < 120 or p_stale_seconds > 3600 then
    raise exception 'p_stale_seconds out of range' using errcode = '22023';
  end if;

  select *
    into v_row
  from public.order_notifications
  where id = p_notification_id
  for update;

  if not found then
    return jsonb_build_object('claimed', false, 'reason', 'not_available');
  end if;

  -- Ya alertada: no se reenvía.
  if v_row.alerted_at is not null or v_row.alert_status = 'sent' then
    return jsonb_build_object('claimed', false, 'reason', 'already_alerted');
  end if;

  -- La incidencia debe seguir requiriendo intervención humana.
  if not (v_row.manual_review_required = true or v_row.terminal_at is not null) then
    return jsonb_build_object('claimed', false, 'reason', 'not_applicable');
  end if;

  -- Intentos de alerta agotados: no se reintenta automáticamente.
  if v_row.alert_attempt_count >= 5 then
    return jsonb_build_object('claimed', false, 'reason', 'max_attempts_reached');
  end if;

  v_claimable :=
       v_row.alert_status is null
    or v_row.alert_status = 'pending'
    or (
      v_row.alert_status = 'alerting'
      and v_row.alert_claimed_at is not null
      and v_row.alert_claimed_at < now() - make_interval(secs => p_stale_seconds)
    );

  if not v_claimable then
    -- Reclamada y aún fresca: no se roba.
    return jsonb_build_object('claimed', false, 'reason', 'in_flight',
                              'status', v_row.alert_status);
  end if;

  select o.order_number into v_order_number
  from public.orders o
  where o.id = v_row.order_id;

  v_token := gen_random_uuid();

  update public.order_notifications
     set alert_status       = 'alerting',
         alert_claim_token   = v_token,
         alert_claimed_at    = now(),
         alert_attempt_count = alert_attempt_count + 1,
         updated_at          = now()
   where id = v_row.id;

  return jsonb_build_object(
    'claimed', true,
    'notification_id', v_row.id,
    'claim_token', v_token,
    'notification_type', v_row.notification_type,
    'order_number', coalesce(v_order_number, ''),
    'reason_code', coalesce(v_row.last_error_code, ''),
    'review_kind', case when v_row.manual_review_required then 'manual_review' else 'terminal' end,
    'alert_attempt_count', v_row.alert_attempt_count + 1
  );
end;
$$;

-- ============================================================================
-- RPC: mark_notification_alerted
--
-- Transición: alerting → sent (alerted_at = now()). Idempotente frente a una
-- alerta ya marcada. Exige el claim_token vigente. No toca status/external_message_id.
-- ============================================================================

create or replace function public.mark_notification_alerted(
  p_notification_id uuid,
  p_claim_token uuid
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

  select id, alert_status, alert_claim_token, alerted_at
    into v_row
  from public.order_notifications
  where id = p_notification_id
  for update;

  if not found then return false; end if;

  -- Idempotencia: ya entregada.
  if v_row.alert_status = 'sent' and v_row.alerted_at is not null then
    return true;
  end if;

  if v_row.alert_status <> 'alerting' then return false; end if;
  if v_row.alert_claim_token is distinct from p_claim_token then return false; end if;

  update public.order_notifications
     set alerted_at            = now(),
         alert_status          = 'sent',
         alert_claim_token     = null,
         alert_claimed_at      = null,
         alert_next_attempt_at = null,
         updated_at            = now()
   where id = v_row.id;

  return true;
end;
$$;

-- ============================================================================
-- RPC: reschedule_notification_alert
--
-- Transición: alerting → pending (reintento con retraso) o → failed (agotados
-- los intentos: deja de reintentarse, requiere humano). Exige el claim_token.
-- Nunca marca la alerta como enviada.
-- ============================================================================

create or replace function public.reschedule_notification_alert(
  p_notification_id uuid,
  p_claim_token uuid,
  p_error_code text,
  p_delay_seconds integer default 300
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_row record;
  v_code text;
begin
  if p_notification_id is null or p_claim_token is null then
    raise exception 'notification_id and claim_token required' using errcode = '22023';
  end if;
  v_code := btrim(coalesce(p_error_code, ''));
  if v_code !~ '^[A-Za-z0-9._:-]{1,64}$' then
    raise exception 'invalid error_code' using errcode = '22023';
  end if;
  if p_delay_seconds is null or p_delay_seconds < 0 or p_delay_seconds > 86400 then
    raise exception 'p_delay_seconds out of range' using errcode = '22023';
  end if;

  select id, alert_status, alert_claim_token, alert_attempt_count
    into v_row
  from public.order_notifications
  where id = p_notification_id
  for update;

  if not found then
    return jsonb_build_object('rescheduled', false, 'terminal', false, 'reason', 'not_found');
  end if;
  if v_row.alert_status <> 'alerting'
     or v_row.alert_claim_token is distinct from p_claim_token then
    return jsonb_build_object('rescheduled', false, 'terminal', false, 'reason', 'claim_mismatch');
  end if;

  -- Agotados los intentos: se cierra la alerta (requiere humano), sin más envíos.
  if v_row.alert_attempt_count >= 5 then
    update public.order_notifications
       set alert_status          = 'failed',
           alert_last_error_code  = v_code,
           alert_claim_token      = null,
           alert_claimed_at       = null,
           alert_next_attempt_at  = null,
           updated_at             = now()
     where id = v_row.id;
    return jsonb_build_object('rescheduled', false, 'terminal', true,
                              'reason', 'max_attempts_reached');
  end if;

  update public.order_notifications
     set alert_status          = 'pending',
         alert_last_error_code  = v_code,
         alert_next_attempt_at  = now() + make_interval(secs => p_delay_seconds),
         alert_claim_token      = null,
         alert_claimed_at       = null,
         updated_at             = now()
   where id = v_row.id;

  return jsonb_build_object('rescheduled', true, 'terminal', false);
end;
$$;

-- ============================================================================
-- Permisos — exclusivamente service_role.
-- ============================================================================

revoke all on function public.select_due_notification_alerts(integer) from public;
revoke all on function public.select_due_notification_alerts(integer) from anon;
revoke all on function public.select_due_notification_alerts(integer) from authenticated;
grant execute on function public.select_due_notification_alerts(integer) to service_role;

revoke all on function public.claim_notification_alert(uuid, integer) from public;
revoke all on function public.claim_notification_alert(uuid, integer) from anon;
revoke all on function public.claim_notification_alert(uuid, integer) from authenticated;
grant execute on function public.claim_notification_alert(uuid, integer) to service_role;

revoke all on function public.mark_notification_alerted(uuid, uuid) from public;
revoke all on function public.mark_notification_alerted(uuid, uuid) from anon;
revoke all on function public.mark_notification_alerted(uuid, uuid) from authenticated;
grant execute on function public.mark_notification_alerted(uuid, uuid) to service_role;

revoke all on function public.reschedule_notification_alert(uuid, uuid, text, integer) from public;
revoke all on function public.reschedule_notification_alert(uuid, uuid, text, integer) from anon;
revoke all on function public.reschedule_notification_alert(uuid, uuid, text, integer) from authenticated;
grant execute on function public.reschedule_notification_alert(uuid, uuid, text, integer) to service_role;

commit;
