-- ============================================================================
-- 0022 — Decisión de un intento de pago (RPC atómica)
--
-- Confirmar o rechazar un pago es la operación con más riesgo de duplicarse del
-- panel: dos personas mirando el mismo pedido, un doble clic en una tablet, o
-- una pestaña que reenvía la acción. Cada duplicado que se cuele es un mensaje
-- de WhatsApp de más al cliente.
--
-- ── Por qué una RPC y no un UPDATE desde la aplicación ──────────────────────
--
-- Un "SELECT para ver si está pendiente y luego UPDATE" tiene una ventana entre
-- los dos pasos. Dos llamadas concurrentes leen `pending_review` a la vez, las
-- dos creen haber ganado, y las dos mandan WhatsApp.
--
-- Aquí la condición viaja DENTRO del UPDATE (`and review_status =
-- 'pending_review'`). Postgres serializa las escrituras sobre la misma fila, así
-- que exactamente una la encuentra pendiente y actualiza; la otra no actualiza
-- ninguna fila y se entera de que perdió. No hay ventana porque no hay dos pasos.
--
-- ── Qué distingue el resultado ──────────────────────────────────────────────
--
--   won       — esta llamada aplicó la decisión. La ÚNICA que manda WhatsApp.
--   repeated  — la misma decisión ya estaba aplicada. Éxito idempotente y
--               silencioso: el doble clic no reenvía nada.
--   conflict  — otra decisión distinta ganó antes. Se devuelve el estado REAL
--               para que el panel deje de mentir y el operador lo vea.
--   not_found — el intento no existe.
--
-- `reviewed_at` lo pone `now()` del servidor. La hora del navegador no es una
-- fuente de verdad: puede estar mal, en otra zona, o ser manipulada.
--
-- ── Lo que esta RPC NO hace ─────────────────────────────────────────────────
--
-- No toca `orders.status`. Revisar un pago y avanzar el pedido son decisiones
-- distintas: confirmar un pago no marca nada como listo ni entregado. Tampoco
-- envía mensajes: eso lo hace la aplicación, y solo si el resultado es `won`.
--
-- NO ejecutar automáticamente. Aplicar manualmente después de 0021.
-- Postgres / Supabase.
-- ============================================================================

begin;

create or replace function public.decide_payment_attempt(
  p_attempt_id uuid,
  p_decision   text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_updated   public.payment_attempts%rowtype;
  v_current   public.payment_attempts%rowtype;
  v_target    text;
begin
  -- Dominio cerrado de la decisión. Se valida aquí además de en la aplicación:
  -- la base es la última barrera, no la primera.
  if p_decision = 'accept' then
    v_target := 'accepted';
  elsif p_decision = 'reject' then
    v_target := 'rejected';
  else
    return jsonb_build_object('outcome', 'invalid_decision', 'current', null);
  end if;

  -- CAS: la condición de carrera se resuelve DENTRO del UPDATE. Solo una
  -- llamada concurrente encuentra la fila en `pending_review`.
  update public.payment_attempts
     set review_status = v_target,
         reviewed_at   = now()
   where id = p_attempt_id
     and review_status = 'pending_review'
  returning * into v_updated;

  if found then
    return jsonb_build_object(
      'outcome',       'won',
      'attempt_id',    v_updated.id,
      'order_id',      v_updated.order_id,
      'review_status', v_updated.review_status,
      'reviewed_at',   v_updated.reviewed_at
    );
  end if;

  -- No se actualizó: o no existe, o ya estaba decidido. Se lee para distinguir.
  select * into v_current
    from public.payment_attempts
   where id = p_attempt_id;

  if not found then
    return jsonb_build_object('outcome', 'not_found', 'current', null);
  end if;

  -- Misma decisión ya aplicada: éxito idempotente. NO reenvía WhatsApp.
  if v_current.review_status = v_target then
    return jsonb_build_object(
      'outcome',       'repeated',
      'attempt_id',    v_current.id,
      'order_id',      v_current.order_id,
      'review_status', v_current.review_status,
      'reviewed_at',   v_current.reviewed_at
    );
  end if;

  -- Decisión CONTRARIA ya aplicada: se devuelve el estado real.
  return jsonb_build_object(
    'outcome',       'conflict',
    'attempt_id',    v_current.id,
    'order_id',      v_current.order_id,
    'review_status', v_current.review_status,
    'reviewed_at',   v_current.reviewed_at
  );
end;
$$;

-- service_role-only, igual que el resto de RPC internas: el rol anónimo no
-- puede decidir pagos ni siquiera conociendo el id de un intento.
revoke all on function public.decide_payment_attempt(uuid, text) from public;
revoke all on function public.decide_payment_attempt(uuid, text) from anon;
revoke all on function public.decide_payment_attempt(uuid, text) from authenticated;
grant execute on function public.decide_payment_attempt(uuid, text) to service_role;

commit;
