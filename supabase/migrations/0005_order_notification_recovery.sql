-- ============================================================================
-- La Fija Orders — Persistencia para recuperación de notificaciones
-- (0005_order_notification_recovery)
--
-- Amplía public.order_notifications (0004) con el estado necesario para que una
-- notificación pueda quedar pendiente de envío, enviándose, pendiente de
-- reconciliación, reconciliándose, enviada, fallida recuperable, fallida
-- terminal o en revisión manual.
--
-- NO activa comportamiento automático: no crea cron ni worker, no reenvía nada,
-- no hace backfill, no convierte pedidos históricos en trabajo pendiente.
--
-- ── TRES INVARIANTES ANTI-DUPLICACIÓN ──────────────────────────────────────
--
-- I1. FILAS HISTÓRICAS INVISIBLES. next_attempt_at y reconciliation_due_at se
--     añaden NULL sin default: toda fila anterior a 0005 es indescubrible. El
--     descubrimiento exige fecha EXPLÍCITA y vencida.
--
-- I2. NINGÚN AMBIGUO VUELVE A LA COLA DE ENVÍO. Un timeout / error de red /
--     respuesta ilegible / error HTTP puede corresponder a un mensaje YA
--     entregado. Esas filas solo avanzan reconciliándose.
--
-- I3. NINGÚN 'sending' SE REENVÍA, NI SIQUIERA VENCIDO. Una fila 'sending'
--     abandonada puede representar un mensaje que Kapso SÍ recibió y cuya
--     respuesta se perdió. Nunca vuelve a 'sending': se convierte en
--     'pending_reconciliation' y debe reconciliarse.
--
-- NO modifica el ARCHIVO 0004. Sí reemplaza (CREATE OR REPLACE) algunas de sus
-- funciones conservando firma y semántica de retorno, para que el código ya
-- desplegado siga funcionando y quede protegido desde el minuto 0.
--
-- Aplicar manualmente tras 0001 + 0002 + 0003 + 0004. Atómica: begin; ... commit;
-- ============================================================================

begin;

-- ── 1. Columnas de recuperación ─────────────────────────────────────────────

alter table public.order_notifications
  add column if not exists next_attempt_at              timestamptz,
  add column if not exists reconciliation_due_at        timestamptz,
  add column if not exists last_attempt_at              timestamptz,
  add column if not exists reconciliation_attempt_count integer not null default 0,
  add column if not exists max_attempts                 integer not null default 5,
  add column if not exists last_http_status             integer,
  add column if not exists reconciled_at                timestamptz,
  add column if not exists reconciliation_source        text,
  add column if not exists terminal_at                  timestamptz,
  add column if not exists manual_review_required       boolean not null default false,
  add column if not exists alerted_at                   timestamptz;

-- ── 2. Dominio de estados ampliado ──────────────────────────────────────────
-- La revisión manual NO es un estado: es manual_review_required = true.

alter table public.order_notifications
  drop constraint if exists order_notifications_status_check;

alter table public.order_notifications
  add constraint order_notifications_status_check
  check (status in (
    'pending', 'sending', 'pending_reconciliation', 'reconciling', 'sent', 'failed'
  ));

-- ── 3. Coherencia estado ↔ columnas ─────────────────────────────────────────
-- Las cuatro ramas de 0004 se mantienen IDÉNTICAS: ninguna fila existente puede
-- violarla al revalidarse.
--
-- Nota sobre 'sent': manual_review_required NO se restringe aquí, de modo que
-- una fila enviada PUEDE marcarse en conflicto (dos wamid distintos) sin dejar
-- de ser 'sent' ni perder su wamid original.

alter table public.order_notifications
  drop constraint if exists order_notifications_state_coherence;

alter table public.order_notifications
  add constraint order_notifications_state_coherence check (
    (
      status = 'pending'
      and claim_token is null and claimed_at is null
      and external_message_id is null and sent_at is null
      and last_error_code is null
    )
    or (
      status = 'sending'
      and claim_token is not null and claimed_at is not null
      and external_message_id is null and sent_at is null
      and last_error_code is null
    )
    or (
      -- Ambiguo: exige fecha de reconciliación y conserva el código del error.
      status = 'pending_reconciliation'
      and claim_token is null and claimed_at is null
      and external_message_id is null and sent_at is null
      and reconciliation_due_at is not null
      and last_error_code is not null
    )
    or (
      status = 'reconciling'
      and claim_token is not null and claimed_at is not null
      and external_message_id is null and sent_at is null
    )
    or (
      status = 'failed'
      and claim_token is null and claimed_at is null
      and external_message_id is null and sent_at is null
      and last_error_code is not null
    )
    or (
      status = 'sent'
      and claim_token is null and claimed_at is null
      and external_message_id is not null and sent_at is not null
      and last_error_code is null
    )
  );

-- ── 4. Constraints de las columnas nuevas ───────────────────────────────────

alter table public.order_notifications
  drop constraint if exists order_notifications_reconciliation_attempt_count_check;
alter table public.order_notifications
  add constraint order_notifications_reconciliation_attempt_count_check
  check (reconciliation_attempt_count >= 0);

alter table public.order_notifications
  drop constraint if exists order_notifications_max_attempts_check;
alter table public.order_notifications
  add constraint order_notifications_max_attempts_check
  check (max_attempts between 1 and 10);

alter table public.order_notifications
  drop constraint if exists order_notifications_last_http_status_check;
alter table public.order_notifications
  add constraint order_notifications_last_http_status_check
  check (last_http_status is null or last_http_status between 100 and 599);

alter table public.order_notifications
  drop constraint if exists order_notifications_reconciliation_source_check;
alter table public.order_notifications
  add constraint order_notifications_reconciliation_source_check
  check (
    reconciliation_source is null
    or reconciliation_source in ('webhook', 'history', 'send_response', 'manual')
  );

-- Una fila cerrada definitivamente NUNCA queda con trabajo programado.
alter table public.order_notifications
  drop constraint if exists order_notifications_terminal_not_scheduled;
alter table public.order_notifications
  add constraint order_notifications_terminal_not_scheduled
  check (
    terminal_at is null
    or (next_attempt_at is null and reconciliation_due_at is null)
  );

-- Una fila en revisión manual NUNCA queda elegible para trabajo automático.
alter table public.order_notifications
  drop constraint if exists order_notifications_manual_review_not_scheduled;
alter table public.order_notifications
  add constraint order_notifications_manual_review_not_scheduled
  check (
    manual_review_required = false
    or (next_attempt_at is null and reconciliation_due_at is null)
  );

-- Una fila enviada no conserva programación ni estado de error.
alter table public.order_notifications
  drop constraint if exists order_notifications_sent_not_scheduled;
alter table public.order_notifications
  add constraint order_notifications_sent_not_scheduled
  check (
    status <> 'sent'
    or (
      next_attempt_at is null
      and reconciliation_due_at is null
      and last_http_status is null
      and terminal_at is null
    )
  );

-- ── 5. Índices de descubrimiento (parciales) ────────────────────────────────

create index if not exists ix_order_notifications_due_send
  on public.order_notifications (next_attempt_at)
  where next_attempt_at is not null
    and terminal_at is null
    and manual_review_required = false;

create index if not exists ix_order_notifications_due_reconciliation
  on public.order_notifications (reconciliation_due_at)
  where reconciliation_due_at is not null
    and terminal_at is null
    and manual_review_required = false;

-- Localiza 'sending' vencidos para su recuperación segura.
create index if not exists ix_order_notifications_sending_claimed_at
  on public.order_notifications (claimed_at)
  where status = 'sending';

-- ============================================================================
-- HELPER 1: is_ambiguous_notification_error   (invariante I2)
--
-- Un error es AMBIGUO cuando el mensaje pudo haberse entregado pese al fallo.
-- Corresponde 1:1 con la unión de errores del transport de Kapso:
--   ambiguos     -> timeout, network_error, invalid_response, http_error,
--                   persistence_error, stale_sending_unknown, y todo http_*.
--   NO ambiguos  -> invalid_phone, invalid_text, invalid_body_text (el
--                   transport los devuelve SIN llegar a llamar a fetch).
-- ============================================================================

create or replace function public.is_ambiguous_notification_error(
  p_error_code text
)
returns boolean
language sql
immutable
security invoker
set search_path = public
as $$
  select p_error_code is not null
     and (
       btrim(p_error_code) in (
         'timeout',
         'network_error',
         'invalid_response',
         'http_error',
         'persistence_error',
         'stale_sending_unknown'
       )
       or btrim(p_error_code) like 'http\_%'
     );
$$;

-- ============================================================================
-- HELPER 2: internal_apply_notification_sent
--
-- ÚNICA definición de "convertirse en enviada". Todas las rutas a 'sent'
-- (respuesta directa, historial, webhook) pasan por aquí, de modo que la
-- limpieza no se duplica ni puede divergir entre funciones.
--
-- Cancela cualquier trabajo pendiente: next_attempt_at, reconciliation_due_at,
-- terminal_at, manual_review_required, errores y claim quedan limpios.
-- ============================================================================

create or replace function public.internal_apply_notification_sent(
  p_notification_id uuid,
  p_external_message_id text,
  p_source text
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  update public.order_notifications
     set status                 = 'sent',
         external_message_id    = p_external_message_id,
         sent_at                = coalesce(sent_at, now()),
         reconciliation_source  = p_source,
         reconciled_at          = case
                                    when p_source in ('webhook', 'history') then now()
                                    else reconciled_at
                                  end,
         claim_token            = null,
         claimed_at             = null,
         last_error_code        = null,
         last_http_status       = null,
         next_attempt_at        = null,
         reconciliation_due_at  = null,
         terminal_at            = null,
         manual_review_required = false,
         updated_at             = now()
   where id = p_notification_id;
end;
$$;

-- ============================================================================
-- HELPER 3: internal_claim_location_wamid
--
-- ÚNICA definición de la doble escritura de orders.location_request_message_id.
-- Devuelve true si el pedido quedó con ESTE wamid (escrito ahora o ya presente),
-- false si ya tenía uno DIFERENTE (nunca se sobrescribe).
-- ============================================================================

create or replace function public.internal_claim_location_wamid(
  p_order_id uuid,
  p_wamid text
)
returns boolean
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_order record;
begin
  select id, location_request_message_id
    into v_order
  from public.orders
  where id = p_order_id
  for update;

  if not found then return false; end if;

  if v_order.location_request_message_id is null then
    update public.orders
       set location_request_message_id = p_wamid
     where id = v_order.id;
    return true;
  end if;

  return v_order.location_request_message_id = p_wamid;
end;
$$;

-- ============================================================================
-- HELPER 4: internal_flag_manual_review
--
-- Marca una fila para intervención humana sin alterar su status ni su wamid.
-- Se usa en los conflictos (dos external_message_id distintos).
-- ============================================================================

create or replace function public.internal_flag_manual_review(
  p_notification_id uuid
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  update public.order_notifications
     set manual_review_required = true,
         next_attempt_at        = null,
         reconciliation_due_at  = null,
         updated_at             = now()
   where id = p_notification_id;
end;
$$;

-- ============================================================================
-- RPC (reemplazo): initialize_order_notifications
--
-- MISMA firma y MISMO jsonb que 0004: el checkout con after() no cambia. Única
-- diferencia: las filas NUEVAS nacen con next_attempt_at = now().
-- `on conflict do nothing` NO toca filas preexistentes.
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

  select id, delivery_type, status, menu_session_id
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

  if v_order.delivery_type = 'pickup' and v_order.status = 'confirmed' then
    v_types := array['confirmation'];
  elsif v_order.delivery_type = 'delivery' and v_order.status = 'awaiting_location' then
    v_types := array['confirmation', 'location_request'];
  else
    return jsonb_build_object(
      'initialized', false, 'reason', 'status_not_initial', 'status', v_order.status
    );
  end if;

  foreach v_type in array v_types loop
    v_inserted := null;

    insert into public.order_notifications (
      order_id, notification_type, status, next_attempt_at
    )
    values (p_order_id, v_type, 'pending', now())
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
-- RPC (reemplazo): claim_order_notification            (invariantes I2 + I3)
--
-- MISMA firma y MISMO jsonb que 0004. Solo reclama para ENVIAR:
--   - 'pending'  : siempre (fila nueva que aún no salió).
--   - 'failed'   : SOLO si tiene next_attempt_at explícito y vencido, y el
--                  error NO es ambiguo.
--   - 'sending'  : NUNCA, ni fresco ni vencido. Un 'sending' vencido devuelve
--                  reason = 'requires_reconciliation' y debe pasar por
--                  recover_stale_sending_notification.
--
-- Rechaza además: terminal, revisión manual, max_attempts, y location_request
-- cuya confirmation hermana no esté 'sent'.
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
  v_confirmation_sent boolean;
begin
  if p_order_id is null then
    raise exception 'order_id required' using errcode = '22023';
  end if;
  if p_notification_type is null
     or p_notification_type not in ('confirmation', 'location_request') then
    raise exception 'invalid notification_type' using errcode = '22023';
  end if;
  -- Suelo 120 s: siempre mayor que el timeout de envío (20 s).
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

  -- I3: un 'sending' NUNCA se reenvía. Vencido o no.
  if v_row.status = 'sending' then
    if v_row.claimed_at is not null
       and v_row.claimed_at < now() - make_interval(secs => p_stale_seconds) then
      return jsonb_build_object('claimed', false, 'reason', 'requires_reconciliation');
    end if;
    return jsonb_build_object('claimed', false, 'reason', 'in_flight', 'status', 'sending');
  end if;

  -- Estados de reconciliación: no son competencia de esta RPC.
  if v_row.status in ('pending_reconciliation', 'reconciling') then
    return jsonb_build_object('claimed', false, 'reason', 'requires_reconciliation');
  end if;

  if v_row.status = 'sent' then
    return jsonb_build_object('claimed', false, 'status', 'sent');
  end if;

  -- I2: un fallo ambiguo exige reconciliación, nunca reenvío.
  if v_row.status = 'failed'
     and public.is_ambiguous_notification_error(v_row.last_error_code) then
    return jsonb_build_object('claimed', false, 'reason', 'requires_reconciliation');
  end if;

  -- Un 'failed' solo se reintenta si está EXPLÍCITAMENTE programado y vencido.
  if v_row.status = 'failed'
     and (v_row.next_attempt_at is null or v_row.next_attempt_at > now()) then
    return jsonb_build_object('claimed', false, 'reason', 'not_scheduled');
  end if;

  if v_row.attempt_count >= v_row.max_attempts then
    return jsonb_build_object('claimed', false, 'reason', 'max_attempts_reached');
  end if;

  -- Dependencia DB-side: la solicitud de ubicación nunca se adelanta.
  if p_notification_type = 'location_request' then
    select exists (
      select 1 from public.order_notifications c
      where c.order_id = p_order_id
        and c.notification_type = 'confirmation'
        and c.status = 'sent'
    ) into v_confirmation_sent;

    if not v_confirmation_sent then
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

-- ============================================================================
-- RPC: recover_stale_sending_notification                     (invariante I3)
--
-- Transición: sending (vencido) → pending_reconciliation.
--
-- Única vía de salida de un 'sending' abandonado. NO reenvía y NO incrementa
-- attempt_count: el intento ya se contó al reclamar. Deja la fila lista para
-- reconciliarse de inmediato (reconciliation_due_at = now()).
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
     or p_notification_type not in ('confirmation', 'location_request') then
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
    -- Todavía podría estar ejecutándose: no se toca.
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
         -- attempt_count NO se incrementa: el intento ya está contado.
   where id = v_row.id;

  return jsonb_build_object(
    'recovered', true,
    'notification_id', v_row.id,
    'attempt_count', v_row.attempt_count
  );
end;
$$;

-- ============================================================================
-- RPC (reemplazo): mark_order_notification_sent
--
-- MISMA firma (uuid, uuid, text) y MISMO boolean que 0004.
--
-- CARRERA WEBHOOK vs RESPUESTA HTTP: si el webhook ya cerró la fila con el
-- MISMO wamid, devuelve true de forma idempotente y NO pisa
-- reconciliation_source='webhook'. Con un wamid DISTINTO devuelve false y marca
-- revisión manual, sin tocar el wamid original.
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
  if v_row.notification_type <> 'confirmation' then return false; end if;

  -- Idempotencia frente a un webhook que ganó la carrera.
  if v_row.status = 'sent' then
    if v_row.external_message_id = p_external_message_id then
      return true; -- already_sent: no se degrada ni se pisa el origen.
    end if;
    perform public.internal_flag_manual_review(v_row.id);
    return false; -- conflicto: wamid distinto.
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
-- RPC (reemplazo): mark_location_request_sent
--
-- MISMA firma (uuid, uuid, text) y MISMO boolean que 0004. Conserva la doble
-- escritura y aplica la misma idempotencia frente al webhook.
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
  v_row record;
begin
  if p_notification_id is null or p_claim_token is null then
    raise exception 'notification_id and claim_token required' using errcode = '22023';
  end if;
  if p_wamid is null or btrim(p_wamid) = '' then
    raise exception 'wamid required' using errcode = '22023';
  end if;

  select id, order_id, notification_type, status, claim_token, external_message_id
    into v_row
  from public.order_notifications
  where id = p_notification_id
  for update;

  if not found then return false; end if;
  if v_row.notification_type <> 'location_request' then return false; end if;

  -- Idempotencia frente a un webhook que ganó la carrera.
  if v_row.status = 'sent' then
    if v_row.external_message_id = p_wamid then
      return true;
    end if;
    perform public.internal_flag_manual_review(v_row.id);
    return false;
  end if;

  if v_row.status <> 'sending' then return false; end if;
  if v_row.claim_token is distinct from p_claim_token then return false; end if;

  if not public.internal_claim_location_wamid(v_row.order_id, p_wamid) then
    return false; -- El pedido ya tiene otro wamid de solicitud.
  end if;

  perform public.internal_apply_notification_sent(v_row.id, p_wamid, 'send_response');
  return true;
end;
$$;

-- ============================================================================
-- RPC (reemplazo): mark_order_notification_failed              (invariante I2)
--
-- MISMA firma (uuid, uuid, text) y MISMO boolean que 0004.
--
-- CLASIFICA el error, porque el código HOY desplegado llama a esta función ante
-- CUALQUIER fallo, incluido un timeout:
--   - AMBIGUO    -> 'pending_reconciliation' + reconciliation_due_at, sin
--                   next_attempt_at. Nunca vuelve a la cola de envío.
--   - NO ambiguo -> 'failed' con next_attempt_at = NULL: no se reintenta solo.
-- La protección existe desde que se aplica 0005, sin tocar el servicio.
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

  v_code := btrim(coalesce(p_error_code, ''));
  if v_code !~ '^[A-Za-z0-9._:-]{1,64}$' then
    raise exception 'invalid error_code' using errcode = '22023';
  end if;

  if public.is_ambiguous_notification_error(v_code) then
    update public.order_notifications
       set status                = 'pending_reconciliation',
           last_error_code       = v_code,
           last_attempt_at       = now(),
           reconciliation_due_at = now() + make_interval(secs => 60),
           next_attempt_at       = null,
           claim_token           = null,
           claimed_at            = null,
           updated_at            = now()
     where id = p_notification_id
       and claim_token = p_claim_token
       and status = 'sending';
  else
    update public.order_notifications
       set status          = 'failed',
           last_error_code = v_code,
           last_attempt_at = now(),
           next_attempt_at = null,
           claim_token     = null,
           claimed_at      = null,
           updated_at      = now()
     where id = p_notification_id
       and claim_token = p_claim_token
       and status = 'sending';
  end if;

  get diagnostics v_updated = row_count;
  return v_updated > 0;
end;
$$;

-- ============================================================================
-- RPC: mark_order_notification_pending_reconciliation
--
-- Transición: sending → pending_reconciliation. Variante explícita para el
-- futuro código que sí conoce el HTTP status. NO incrementa attempt_count.
-- ============================================================================

create or replace function public.mark_order_notification_pending_reconciliation(
  p_notification_id uuid,
  p_claim_token uuid,
  p_error_code text,
  p_http_status integer default null,
  p_due_seconds integer default 60
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

  v_code := btrim(coalesce(p_error_code, ''));
  if v_code !~ '^[A-Za-z0-9._:-]{1,64}$' then
    raise exception 'invalid error_code' using errcode = '22023';
  end if;
  if p_http_status is not null and (p_http_status < 100 or p_http_status > 599) then
    raise exception 'invalid http_status' using errcode = '22023';
  end if;
  if p_due_seconds is null or p_due_seconds < 0 or p_due_seconds > 3600 then
    raise exception 'p_due_seconds out of range' using errcode = '22023';
  end if;

  update public.order_notifications
     set status                = 'pending_reconciliation',
         last_error_code       = v_code,
         last_http_status      = coalesce(p_http_status, last_http_status),
         last_attempt_at       = now(),
         reconciliation_due_at = now() + make_interval(secs => p_due_seconds),
         next_attempt_at       = null,
         claim_token           = null,
         claimed_at            = null,
         updated_at            = now()
   where id = p_notification_id
     and claim_token = p_claim_token
     and status = 'sending';

  get diagnostics v_updated = row_count;
  return v_updated > 0;
end;
$$;

-- ============================================================================
-- RPC: claim_notification_reconciliation
--
-- Transición: pending_reconciliation → reconciling.
--
-- CLAIM DIRIGIDO por (p_order_id, p_notification_type): el WHERE incluye
-- order_id, así que es imposible que descubrir ORD-A reclame una fila de ORD-B.
-- No acepta teléfono, wamid ni destinatario.
--
-- La protección real es el cambio de estado + claim_token nuevo. El
-- `for update skip locked` solo evita bloqueos DENTRO de la transacción.
--
-- Un 'reconciling' abandonado se re-reclama tras p_stale_seconds (suelo 120 s):
-- repetir una CONSULTA de historial es seguro; jamás habilita un envío.
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
  v_confirmation_sent boolean;
begin
  if p_order_id is null then
    raise exception 'order_id required' using errcode = '22023';
  end if;
  if p_notification_type is null
     or p_notification_type not in ('confirmation', 'location_request') then
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

  -- Agotados los intentos: revisión manual, NUNCA reintento automático.
  if v_row.reconciliation_attempt_count >= v_row.max_attempts then
    return jsonb_build_object('claimed', false, 'reason', 'max_attempts_reached');
  end if;

  if p_notification_type = 'location_request' then
    select exists (
      select 1 from public.order_notifications c
      where c.order_id = p_order_id
        and c.notification_type = 'confirmation'
        and c.status = 'sent'
    ) into v_confirmation_sent;

    if not v_confirmation_sent then
      return jsonb_build_object('claimed', false, 'reason', 'confirmation_not_sent');
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
-- RPC: mark_reconciliation_sent            (vía HISTORY / worker, CON claim)
--
-- Transición: reconciling → sent. El worker reclamó la fila deliberadamente,
-- así que DEBE presentar el claim_token vigente.
-- ============================================================================

create or replace function public.mark_reconciliation_sent(
  p_notification_id uuid,
  p_claim_token uuid,
  p_external_message_id text,
  p_source text
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
  if p_source is null or p_source not in ('webhook', 'history') then
    raise exception 'invalid reconciliation_source' using errcode = '22023';
  end if;

  select id, order_id, notification_type, status, claim_token, external_message_id
    into v_row
  from public.order_notifications
  where id = p_notification_id
  for update;

  if not found then return false; end if;

  -- Idempotencia: el webhook pudo cerrarla mientras reconciliábamos.
  if v_row.status = 'sent' then
    if v_row.external_message_id = p_external_message_id then
      return true;
    end if;
    perform public.internal_flag_manual_review(v_row.id);
    return false;
  end if;

  if v_row.status <> 'reconciling' then return false; end if;
  if v_row.claim_token is distinct from p_claim_token then return false; end if;

  if v_row.notification_type = 'location_request'
     and not public.internal_claim_location_wamid(v_row.order_id, p_external_message_id) then
    return false;
  end if;

  perform public.internal_apply_notification_sent(
    v_row.id, p_external_message_id, p_source
  );
  return true;
end;
$$;

-- ============================================================================
-- RPC: mark_notification_sent_by_webhook          (vía WEBHOOK, SIN claim)
--
-- Transición: sending | pending_reconciliation | reconciling | failed
--             recuperable → sent.
--
-- Kapso confirmó que whatsapp.message.sent puede llegar DESPUÉS de que nuestro
-- HTTP terminara en timeout, e incluso después de haber programado un retry.
-- Este evento es una señal empujada desde fuera: no hay worker que haya
-- reclamado la fila, así que NO puede exigir claim_token.
--
-- DIFERENCIA CON LA VÍA history:
--   history : el worker RECLAMÓ (reconciling + claim_token). Autoridad = claim.
--   webhook : nadie reclamó. Autoridad = identidad interna (order_id +
--             notification_type) + el external_message_id del proveedor.
--
-- CANCELA cualquier retry pendiente: next_attempt_at y reconciliation_due_at
-- quedan NULL, así que el worker ya no puede descubrirla y no habrá 2º envío.
--
-- NO acepta: 'failed' terminal, filas en revisión manual, ni otro
-- order_id/notification_type (la fila se localiza por ambos).
--
-- Retorna jsonb: result = sent | already_sent | conflict | not_found |
--                         terminal | manual_review_required |
--                         duplicate_message_id
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
     or p_notification_type not in ('confirmation', 'location_request') then
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

  -- Una fila enviada nunca se degrada.
  if v_row.status = 'sent' then
    if v_row.external_message_id = v_wamid then
      return jsonb_build_object('result', 'already_sent');
    end if;
    perform public.internal_flag_manual_review(v_row.id);
    return jsonb_build_object('result', 'conflict', 'manual_review_required', true);
  end if;

  -- Cierres explícitos: requieren decisión humana, no se reabren solos.
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
      -- El índice único global rechazó el wamid: pertenece a otra notificación.
      return jsonb_build_object('result', 'duplicate_message_id');
  end;

  return jsonb_build_object('result', 'sent');
end;
$$;

-- ============================================================================
-- RPC: reschedule_notification_reconciliation
--
-- Transición: reconciling → pending_reconciliation.
--
-- Reconciliación no concluyente. Para impedir ciclos infinitos se NIEGA cuando
-- reconciliation_attempt_count ya alcanzó max_attempts; en ese caso el llamador
-- debe cerrar con mark_notification_terminal (revisión manual).
-- ============================================================================

create or replace function public.reschedule_notification_reconciliation(
  p_notification_id uuid,
  p_claim_token uuid,
  p_due_seconds integer default 300
)
returns jsonb
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
  if p_due_seconds is null or p_due_seconds < 30 or p_due_seconds > 86400 then
    raise exception 'p_due_seconds out of range' using errcode = '22023';
  end if;

  select id, status, claim_token, last_error_code,
         reconciliation_attempt_count, max_attempts
    into v_row
  from public.order_notifications
  where id = p_notification_id
  for update;

  if not found then
    return jsonb_build_object('rescheduled', false, 'reason', 'not_found');
  end if;
  if v_row.status <> 'reconciling'
     or v_row.claim_token is distinct from p_claim_token then
    return jsonb_build_object('rescheduled', false, 'reason', 'claim_mismatch');
  end if;

  if v_row.reconciliation_attempt_count >= v_row.max_attempts then
    return jsonb_build_object(
      'rescheduled', false,
      'reason', 'max_attempts_reached',
      'reconciliation_attempt_count', v_row.reconciliation_attempt_count,
      'max_attempts', v_row.max_attempts
    );
  end if;

  update public.order_notifications
     set status                = 'pending_reconciliation',
         reconciliation_due_at = now() + make_interval(secs => p_due_seconds),
         -- La coherencia exige last_error_code en pending_reconciliation.
         last_error_code       = coalesce(v_row.last_error_code, 'reconciliation_pending'),
         claim_token           = null,
         claimed_at            = null,
         updated_at            = now()
   where id = v_row.id;

  return jsonb_build_object(
    'rescheduled', true,
    'reconciliation_attempt_count', v_row.reconciliation_attempt_count,
    'max_attempts', v_row.max_attempts
  );
end;
$$;

-- ============================================================================
-- RPC: schedule_notification_retry
--
-- Transición: sending | reconciling → failed recuperable (con next_attempt_at).
--
-- EVIDENCIA OBLIGATORIA (ya no es una promesa del llamador):
--   - desde 'reconciling': p_reconciliation_outcome DEBE ser 'not_found', el
--     único resultado que prueba que el mensaje NO se envió. Cualquier otro
--     (ambiguous, multiple_matches, provider_failed, history_error,
--     history_timeout, invalid_response, webhook_pending, desconocido) se
--     RECHAZA: esas filas vuelven a pending_reconciliation o terminan en
--     revisión manual, nunca en envío directo.
--   - desde 'sending': el error NO puede ser ambiguo (I2).
--
-- Retorna jsonb con el motivo, para que el mal uso sea explícito y auditable.
-- ============================================================================

create or replace function public.schedule_notification_retry(
  p_notification_id uuid,
  p_claim_token uuid,
  p_error_code text,
  p_reconciliation_outcome text default null,
  p_http_status integer default null,
  p_delay_seconds integer default 120
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
  if p_http_status is not null and (p_http_status < 100 or p_http_status > 599) then
    raise exception 'invalid http_status' using errcode = '22023';
  end if;
  if p_delay_seconds is null or p_delay_seconds < 0 or p_delay_seconds > 86400 then
    raise exception 'p_delay_seconds out of range' using errcode = '22023';
  end if;

  select id, status, claim_token
    into v_row
  from public.order_notifications
  where id = p_notification_id
  for update;

  if not found then
    return jsonb_build_object('scheduled', false, 'reason', 'not_found');
  end if;
  if v_row.claim_token is distinct from p_claim_token then
    return jsonb_build_object('scheduled', false, 'reason', 'claim_mismatch');
  end if;

  if v_row.status = 'reconciling' then
    -- Solo una reconciliación CONCLUYENTE de "no enviado" autoriza reenvío.
    if p_reconciliation_outcome is distinct from 'not_found' then
      return jsonb_build_object(
        'scheduled', false,
        'reason', 'reconciliation_evidence_required',
        'outcome', coalesce(p_reconciliation_outcome, 'null')
      );
    end if;
  elsif v_row.status = 'sending' then
    -- I2: un ambiguo nunca se convierte en reintento directo.
    if public.is_ambiguous_notification_error(v_code) then
      return jsonb_build_object('scheduled', false, 'reason', 'ambiguous_requires_reconciliation');
    end if;
  else
    return jsonb_build_object('scheduled', false, 'reason', 'invalid_state',
                              'status', v_row.status);
  end if;

  update public.order_notifications
     set status                 = 'failed',
         last_error_code        = v_code,
         last_http_status       = coalesce(p_http_status, last_http_status),
         last_attempt_at        = now(),
         next_attempt_at        = now() + make_interval(secs => p_delay_seconds),
         reconciliation_due_at  = null,
         terminal_at            = null,
         manual_review_required = false,
         claim_token            = null,
         claimed_at             = null,
         updated_at             = now()
   where id = v_row.id;

  return jsonb_build_object('scheduled', true);
end;
$$;

-- ============================================================================
-- RPC: schedule_notification_send
--
-- Reprograma un 'failed' NO ambiguo para un nuevo envío, sin necesitar claim.
-- Existe para que una recuperación explícita (operación humana o el endpoint
-- interno de reintento) pueda re-armar una fila que quedó con
-- next_attempt_at = NULL, ahora que claim_order_notification exige programación.
--
-- NUNCA programa un ambiguo, un terminal, uno en revisión manual ni uno que
-- agotó intentos.
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
     or p_notification_type not in ('confirmation', 'location_request') then
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
-- RPC: mark_notification_terminal
--
-- Cierre definitivo: status='failed', terminal_at=now(), sin trabajo programado.
-- Con p_manual_review = true queda marcada para revisión humana.
--
-- p_claim_token puede ser NULL para cerrar manualmente una fila NO reclamada.
-- Si la fila SÍ está reclamada, el token debe coincidir.
-- NO envía alertas: alerted_at queda intacto en esta subfase.
-- ============================================================================

create or replace function public.mark_notification_terminal(
  p_notification_id uuid,
  p_claim_token uuid,
  p_error_code text,
  p_http_status integer default null,
  p_manual_review boolean default false
)
returns boolean
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_row record;
  v_code text;
begin
  if p_notification_id is null then
    raise exception 'notification_id required' using errcode = '22023';
  end if;

  v_code := btrim(coalesce(p_error_code, ''));
  if v_code !~ '^[A-Za-z0-9._:-]{1,64}$' then
    raise exception 'invalid error_code' using errcode = '22023';
  end if;
  if p_http_status is not null and (p_http_status < 100 or p_http_status > 599) then
    raise exception 'invalid http_status' using errcode = '22023';
  end if;

  select id, status, claim_token
    into v_row
  from public.order_notifications
  where id = p_notification_id
  for update;

  if not found then return false; end if;

  -- Una notificación ya enviada nunca se degrada a fallo.
  if v_row.status = 'sent' then return false; end if;

  if v_row.claim_token is not null
     and v_row.claim_token is distinct from p_claim_token then
    return false;
  end if;

  update public.order_notifications
     set status                 = 'failed',
         last_error_code        = v_code,
         last_http_status       = coalesce(p_http_status, last_http_status),
         terminal_at            = now(),
         manual_review_required = coalesce(p_manual_review, false),
         next_attempt_at        = null,
         reconciliation_due_at  = null,
         claim_token            = null,
         claimed_at             = null,
         updated_at             = now()
   where id = v_row.id;

  return true;
end;
$$;

-- ============================================================================
-- RPC: select_due_notification_orders
--
-- Descubrimiento para el FUTURO worker. Devuelve order_id ÚNICOS con trabajo
-- explícitamente programado y vencido. NO escribe nada.
--
-- Garantías:
-- - I1: nunca devuelve filas históricas (fechas NULL).
-- - I2: la rama de envío excluye errores ambiguos.
-- - I3: 'sending' vencido se ofrece como trabajo de RECUPERACIÓN (nunca de
--       envío); el worker debe llamar a recover_stale_sending_notification.
-- - Excluye terminal_at y manual_review_required.
-- - Respeta los techos de intentos.
-- - location_request solo cuenta si su confirmation hermana está 'sent'.
-- - Único parámetro: un límite numérico. Nunca teléfono ni message_id.
--
-- SKIP LOCKED NO se usa aquí: esto es solo descubrimiento. El worker DEBE
-- reclamar después con la RPC de claim correspondiente.
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
    and (
      -- Reintento de ENVÍO explícitamente programado y vencido.
      (
        n.status in ('pending', 'failed')
        and n.next_attempt_at is not null
        and n.next_attempt_at <= now()
        and n.attempt_count < n.max_attempts
        and not public.is_ambiguous_notification_error(n.last_error_code)
      )
      or
      -- RECONCILIACIÓN explícitamente programada y vencida.
      (
        n.status = 'pending_reconciliation'
        and n.reconciliation_due_at is not null
        and n.reconciliation_due_at <= now()
        and n.reconciliation_attempt_count < n.max_attempts
      )
      or
      -- RECUPERACIÓN de un 'sending' abandonado (nunca reenvío directo).
      (
        n.status = 'sending'
        and n.claimed_at is not null
        and n.claimed_at < now() - interval '120 seconds'
      )
    )
    and (
      n.notification_type <> 'location_request'
      or exists (
        select 1 from public.order_notifications c
        where c.order_id = n.order_id
          and c.notification_type = 'confirmation'
          and c.status = 'sent'
      )
    )
  order by n.order_id
  limit p_limit;
end;
$$;

-- ============================================================================
-- Permisos — exclusivamente service_role.
--
-- GRANT explícito para las 19 funciones (4 helpers + 5 reemplazos de 0004 +
-- 10 nuevas), de modo que la migración sea autocontenida y verificable sin
-- depender del estado previo. anon y authenticated quedan revocados en todas.
-- ============================================================================

revoke all on function public.is_ambiguous_notification_error(text) from public;
revoke all on function public.is_ambiguous_notification_error(text) from anon;
revoke all on function public.is_ambiguous_notification_error(text) from authenticated;
grant execute on function public.is_ambiguous_notification_error(text) to service_role;

revoke all on function public.internal_apply_notification_sent(uuid, text, text) from public;
revoke all on function public.internal_apply_notification_sent(uuid, text, text) from anon;
revoke all on function public.internal_apply_notification_sent(uuid, text, text) from authenticated;
grant execute on function public.internal_apply_notification_sent(uuid, text, text) to service_role;

revoke all on function public.internal_claim_location_wamid(uuid, text) from public;
revoke all on function public.internal_claim_location_wamid(uuid, text) from anon;
revoke all on function public.internal_claim_location_wamid(uuid, text) from authenticated;
grant execute on function public.internal_claim_location_wamid(uuid, text) to service_role;

revoke all on function public.internal_flag_manual_review(uuid) from public;
revoke all on function public.internal_flag_manual_review(uuid) from anon;
revoke all on function public.internal_flag_manual_review(uuid) from authenticated;
grant execute on function public.internal_flag_manual_review(uuid) to service_role;

revoke all on function public.initialize_order_notifications(uuid) from public;
revoke all on function public.initialize_order_notifications(uuid) from anon;
revoke all on function public.initialize_order_notifications(uuid) from authenticated;
grant execute on function public.initialize_order_notifications(uuid) to service_role;

revoke all on function public.claim_order_notification(uuid, text, integer) from public;
revoke all on function public.claim_order_notification(uuid, text, integer) from anon;
revoke all on function public.claim_order_notification(uuid, text, integer) from authenticated;
grant execute on function public.claim_order_notification(uuid, text, integer) to service_role;

revoke all on function public.recover_stale_sending_notification(uuid, text, integer) from public;
revoke all on function public.recover_stale_sending_notification(uuid, text, integer) from anon;
revoke all on function public.recover_stale_sending_notification(uuid, text, integer) from authenticated;
grant execute on function public.recover_stale_sending_notification(uuid, text, integer) to service_role;

revoke all on function public.mark_order_notification_sent(uuid, uuid, text) from public;
revoke all on function public.mark_order_notification_sent(uuid, uuid, text) from anon;
revoke all on function public.mark_order_notification_sent(uuid, uuid, text) from authenticated;
grant execute on function public.mark_order_notification_sent(uuid, uuid, text) to service_role;

revoke all on function public.mark_location_request_sent(uuid, uuid, text) from public;
revoke all on function public.mark_location_request_sent(uuid, uuid, text) from anon;
revoke all on function public.mark_location_request_sent(uuid, uuid, text) from authenticated;
grant execute on function public.mark_location_request_sent(uuid, uuid, text) to service_role;

revoke all on function public.mark_order_notification_failed(uuid, uuid, text) from public;
revoke all on function public.mark_order_notification_failed(uuid, uuid, text) from anon;
revoke all on function public.mark_order_notification_failed(uuid, uuid, text) from authenticated;
grant execute on function public.mark_order_notification_failed(uuid, uuid, text) to service_role;

revoke all on function public.mark_order_notification_pending_reconciliation(uuid, uuid, text, integer, integer) from public;
revoke all on function public.mark_order_notification_pending_reconciliation(uuid, uuid, text, integer, integer) from anon;
revoke all on function public.mark_order_notification_pending_reconciliation(uuid, uuid, text, integer, integer) from authenticated;
grant execute on function public.mark_order_notification_pending_reconciliation(uuid, uuid, text, integer, integer) to service_role;

revoke all on function public.claim_notification_reconciliation(uuid, text, integer) from public;
revoke all on function public.claim_notification_reconciliation(uuid, text, integer) from anon;
revoke all on function public.claim_notification_reconciliation(uuid, text, integer) from authenticated;
grant execute on function public.claim_notification_reconciliation(uuid, text, integer) to service_role;

revoke all on function public.mark_reconciliation_sent(uuid, uuid, text, text) from public;
revoke all on function public.mark_reconciliation_sent(uuid, uuid, text, text) from anon;
revoke all on function public.mark_reconciliation_sent(uuid, uuid, text, text) from authenticated;
grant execute on function public.mark_reconciliation_sent(uuid, uuid, text, text) to service_role;

revoke all on function public.mark_notification_sent_by_webhook(uuid, text, text) from public;
revoke all on function public.mark_notification_sent_by_webhook(uuid, text, text) from anon;
revoke all on function public.mark_notification_sent_by_webhook(uuid, text, text) from authenticated;
grant execute on function public.mark_notification_sent_by_webhook(uuid, text, text) to service_role;

revoke all on function public.reschedule_notification_reconciliation(uuid, uuid, integer) from public;
revoke all on function public.reschedule_notification_reconciliation(uuid, uuid, integer) from anon;
revoke all on function public.reschedule_notification_reconciliation(uuid, uuid, integer) from authenticated;
grant execute on function public.reschedule_notification_reconciliation(uuid, uuid, integer) to service_role;

revoke all on function public.schedule_notification_retry(uuid, uuid, text, text, integer, integer) from public;
revoke all on function public.schedule_notification_retry(uuid, uuid, text, text, integer, integer) from anon;
revoke all on function public.schedule_notification_retry(uuid, uuid, text, text, integer, integer) from authenticated;
grant execute on function public.schedule_notification_retry(uuid, uuid, text, text, integer, integer) to service_role;

revoke all on function public.schedule_notification_send(uuid, text, integer) from public;
revoke all on function public.schedule_notification_send(uuid, text, integer) from anon;
revoke all on function public.schedule_notification_send(uuid, text, integer) from authenticated;
grant execute on function public.schedule_notification_send(uuid, text, integer) to service_role;

revoke all on function public.mark_notification_terminal(uuid, uuid, text, integer, boolean) from public;
revoke all on function public.mark_notification_terminal(uuid, uuid, text, integer, boolean) from anon;
revoke all on function public.mark_notification_terminal(uuid, uuid, text, integer, boolean) from authenticated;
grant execute on function public.mark_notification_terminal(uuid, uuid, text, integer, boolean) to service_role;

revoke all on function public.select_due_notification_orders(integer) from public;
revoke all on function public.select_due_notification_orders(integer) from anon;
revoke all on function public.select_due_notification_orders(integer) from authenticated;
grant execute on function public.select_due_notification_orders(integer) to service_role;

commit;
