-- ============================================================================
-- La Fija Orders — Descubrimiento y cierre de reconciliaciones abandonadas
-- (0006_discover_stale_reconciling_notifications)
--
-- CIERRA UNA BRECHA de 0005: select_due_notification_orders no ofrece NINGÚN
-- 'reconciling' abandonado (claim stale), de modo que una reconciliación cuyo
-- proceso murió tras reclamar la fila queda INDESCUBRIBLE para el worker. El
-- caso más peligroso es el que agotó intentos en ese último claim: no puede
-- re-reclamarse (claim_notification_reconciliation → max_attempts_reached) NI
-- cerrarse con mark_notification_terminal (que exige el claim_token, sin dueño).
--
-- Esta migración hace DOS cosas, de forma mínima y atómica:
--
--   1. CREATE OR REPLACE de select_due_notification_orders añadiendo una CUARTA
--      rama que descubre 'reconciling' stale SIN filtrar por intentos: el
--      descubrimiento no autoriza nada; la decisión (re-reclamar vs. cerrar por
--      agotamiento) la toma DESPUÉS la RPC atómica correspondiente.
--
--   2. Una RPC nueva, terminalize_exhausted_reconciliation, que cierra a revisión
--      manual —sin exigir claim_token y sin abrir ninguna ruta de envío— un
--      'reconciling' realmente stale que ya agotó reconciliation_attempt_count.
--
-- INVARIANTES CONSERVADAS (idénticas a 0005):
--   - I1: nunca se descubren filas históricas (todo exige fecha/condición
--         EXPLÍCITA; un 'reconciling' exige claimed_at no nulo y vencido).
--   - I2: la rama de ENVÍO sigue excluyendo errores ambiguos.
--   - I3: un 'sending' vencido se sigue ofreciendo como RECUPERACIÓN, jamás
--         como envío. El cierre por agotamiento NO habilita ningún envío.
--   - terminal_at / manual_review_required siguen excluyendo del descubrimiento.
--
-- NO modifica el ARCHIVO 0005 ni ninguna otra tabla o función. Solo reemplaza
-- select_due_notification_orders (misma firma y retorno) y agrega una función.
--
-- ACOPLE DE UMBRAL: la rama de 'reconciling' usa 300 s, el mismo default que
-- claim_notification_reconciliation.p_stale_seconds (0005) y que el worker no
-- sobrescribe. Así, todo lo que select ofrece como stale, el claim también lo
-- considera stale (nunca "todavía fresco"): descubrimiento y autoridad alineados.
--
-- Aplicar manualmente tras 0001 + 0002 + 0003 + 0004 + 0005. Atómica.
-- ============================================================================

begin;

-- ============================================================================
-- RPC (reemplazo): select_due_notification_orders
--
-- Idéntica a 0005 salvo por la CUARTA rama (reconciling stale). Mismo límite
-- 1..100, mismo retorno table(order_id uuid), mismos filtros de terminal /
-- revisión manual, mismo guard confirmation → location_request, mismos permisos.
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
      or
      -- RECONCILIACIÓN ABANDONADA: un 'reconciling' cuyo claim venció. NO se
      -- filtra por reconciliation_attempt_count a propósito: si aún quedan
      -- intentos, claim_notification_reconciliation lo re-reclama; si están
      -- agotados, terminalize_exhausted_reconciliation lo cierra a revisión
      -- manual. Excluirlo aquí por intentos lo volvería invisible para siempre.
      (
        n.status = 'reconciling'
        and n.claimed_at is not null
        and n.claimed_at < now() - interval '300 seconds'
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
-- RPC: terminalize_exhausted_reconciliation
--
-- Transición: reconciling (stale, intentos agotados) → failed terminal + revisión
-- manual. Es el ÚNICO cierre seguro para una reconciliación cuyo proceso murió
-- tras consumir el último intento: la fila conserva un claim_token sin dueño, así
-- que mark_notification_terminal (que exige token) no puede cerrarla.
--
-- No exige claim_token. La autoridad es la propia RPC, que re-valida bajo
-- FOR UPDATE:
--   - la fila existe;
--   - status = 'reconciling' (una 'sent' NUNCA se degrada; cualquier otro estado
--     se rechaza sin tocar nada);
--   - claim realmente stale (claimed_at < now() - p_stale_seconds);
--   - reconciliation_attempt_count >= max_attempts (si aún quedan intentos, debe
--     re-reclamarse, no cerrarse).
--
-- No abre ninguna ruta de envío, no toca external_message_id ni sent_at, limpia
-- toda programación y el claim. Idempotente: dos workers que la invoquen a la vez
-- se serializan por FOR UPDATE; el segundo ve status <> 'reconciling' y no hace
-- nada. Ninguno envía.
--
-- Retorna jsonb: terminalized = true | false (+ reason).
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
     or p_notification_type not in ('confirmation', 'location_request') then
    raise exception 'invalid notification_type' using errcode = '22023';
  end if;
  -- Mismo suelo/techo y default que claim_notification_reconciliation.
  if p_stale_seconds is null or p_stale_seconds < 120 or p_stale_seconds > 3600 then
    raise exception 'p_stale_seconds out of range' using errcode = '22023';
  end if;

  select id, status, claimed_at, reconciliation_attempt_count, max_attempts,
         external_message_id, terminal_at, manual_review_required
    into v_row
  from public.order_notifications
  where order_id = p_order_id
    and notification_type = p_notification_type
  for update;

  if not found then
    return jsonb_build_object('terminalized', false, 'reason', 'not_available');
  end if;

  -- Una fila ya enviada nunca se degrada a fallo.
  if v_row.status = 'sent' then
    return jsonb_build_object('terminalized', false, 'reason', 'already_sent');
  end if;

  -- Ya cerrada por otra vía: idempotente, no se vuelve a tocar.
  if v_row.terminal_at is not null then
    return jsonb_build_object('terminalized', false, 'reason', 'terminal');
  end if;

  -- Solo cierra reconciliaciones abandonadas; cualquier otro estado no compete.
  if v_row.status <> 'reconciling' then
    return jsonb_build_object('terminalized', false, 'reason', 'not_reconciling',
                              'status', v_row.status);
  end if;

  -- No robar un claim aún vigente: podría estar reconciliándose ahora mismo.
  if v_row.claimed_at is null
     or v_row.claimed_at >= now() - make_interval(secs => p_stale_seconds) then
    return jsonb_build_object('terminalized', false, 'reason', 'still_fresh');
  end if;

  -- Con intentos disponibles NO se cierra: corresponde re-reclamar y reconciliar.
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
         -- external_message_id y sent_at NO se tocan (una 'reconciling' los tiene
         -- en NULL por la coherencia de 0005; jamás se sobrescribe un envío).
   where id = v_row.id;

  return jsonb_build_object('terminalized', true, 'notification_id', v_row.id);
end;
$$;

-- ============================================================================
-- Permisos — exclusivamente service_role (misma política que 0005).
-- ============================================================================

revoke all on function public.select_due_notification_orders(integer) from public;
revoke all on function public.select_due_notification_orders(integer) from anon;
revoke all on function public.select_due_notification_orders(integer) from authenticated;
grant execute on function public.select_due_notification_orders(integer) to service_role;

revoke all on function public.terminalize_exhausted_reconciliation(uuid, text, integer) from public;
revoke all on function public.terminalize_exhausted_reconciliation(uuid, text, integer) from anon;
revoke all on function public.terminalize_exhausted_reconciliation(uuid, text, integer) from authenticated;
grant execute on function public.terminalize_exhausted_reconciliation(uuid, text, integer) to service_role;

commit;
