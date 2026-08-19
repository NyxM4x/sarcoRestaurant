-- ============================================================================
-- 0010_delivery_quote_result.sql — Fase 6D.2C
--
-- DOMINIO: cotización / orders (NO notificaciones — eso es 0011).
--
-- Añade UNA sola RPC: public.mark_delivery_quote_result, que persiste los dos
-- resultados NO exitosos de una cotización dinámica:
--     'failed'          → fallo técnico de Mapbox (reintentable)
--     'out_of_coverage' → distancia real > 18000 m (resolución manual)
--
-- La cotización EXITOSA la sigue aplicando public.apply_delivery_quote (0009);
-- esta RPC NO la duplica ni la reemplaza. NO acepta dinero (delivery_amount /
-- total_amount) ni delivery_pricing ni un status arbitrario, y NUNCA toca:
--   delivery_amount, subtotal_amount, total_amount, confirmed_at, status.
-- El pedido permanece en status = 'awaiting_location'.
--
-- ADITIVA. NO modifica 0009 ni ninguna otra migración. Atómica: begin; ...
-- commit;. Aplicar manualmente tras 0001..0009.
-- ============================================================================

begin;

-- ============================================================================
-- mark_delivery_quote_result(p_order_id, p_status, p_distance_meters)
--
-- Guardas (todas obligatorias, dentro del FOR UPDATE):
--   delivery_type      = 'delivery'
--   delivery_pricing   = 'dynamic'
--   status             = 'awaiting_location'
--   p_status           IN ('failed','out_of_coverage')
--   out_of_coverage    ⇒ p_distance_meters NOT NULL y > 18000
--   failed             ⇒ p_distance_meters puede ser NULL (Mapbox no dio distancia)
--
-- Idempotencia y no-degradación (SELECT ... FOR UPDATE serializa):
--   pending          → failed            : applied
--   pending|failed   → out_of_coverage   : applied
--   failed           → failed            : already_applied (sin degradar distancia)
--   out_of_coverage  → out_of_coverage   : already_applied si distancia coincide,
--                                          conflict si la distancia difiere
--   quoted           → *                 : conflict (NUNCA degrada una cotización)
--   out_of_coverage  → failed            : conflict (no se revierte lo terminal)
--
-- Distancia en 'failed': NUNCA borra una distancia existente. p_distance_meters
-- NULL conserva la actual; una distancia válida solo se guarda si la actual es
-- NULL (conservador: no pisa una distancia ya almacenada).
-- ============================================================================

create function public.mark_delivery_quote_result(
  p_order_id uuid,
  p_status text,
  p_distance_meters integer
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_order record;
  v_new_distance integer;
  v_result text;
begin
  -- Validación de entrada.
  if p_order_id is null then
    raise exception 'order_id required' using errcode = '22023';
  end if;
  if p_status is null or p_status not in ('failed', 'out_of_coverage') then
    raise exception 'status must be failed or out_of_coverage' using errcode = '22023';
  end if;
  if p_distance_meters is not null and p_distance_meters < 0 then
    raise exception 'distance_meters must be non-negative' using errcode = '22023';
  end if;

  -- out_of_coverage exige la distancia REAL y que sea > 18000 (regla del negocio,
  -- espejo de fee.ts / DELIVERY_MAX_DISTANCE_METERS). failed puede no traer distancia.
  if p_status = 'out_of_coverage' then
    if p_distance_meters is null then
      raise exception 'out_of_coverage requires distance_meters' using errcode = '22023';
    end if;
    if p_distance_meters <= 18000 then
      raise exception 'out_of_coverage requires distance_meters > 18000' using errcode = '22023';
    end if;
  end if;

  -- BLOQUEO: fila del pedido (serializa ejecuciones concurrentes).
  select
    id, order_number, delivery_type, status,
    delivery_pricing, delivery_quote_status, delivery_distance_meters
  into v_order
  from public.orders
  where id = p_order_id
  for update;

  if not found then
    raise exception 'order not found' using errcode = 'P1001';
  end if;

  -- Guardas de dominio: solo delivery dinámico esperando ubicación.
  if v_order.delivery_type <> 'delivery' then
    raise exception 'order is not delivery' using errcode = '22023';
  end if;
  if v_order.delivery_pricing is distinct from 'dynamic' then
    raise exception 'order is not dynamic pricing' using errcode = '22023';
  end if;
  if v_order.status <> 'awaiting_location' then
    raise exception 'order is not awaiting_location (status=%)', v_order.status
      using errcode = '22023';
  end if;

  -- Una cotización EXITOSA nunca se degrada.
  if v_order.delivery_quote_status = 'quoted' then
    return jsonb_build_object(
      'result', 'conflict',
      'order_id', v_order.id,
      'order_number', v_order.order_number,
      'delivery_quote_status', v_order.delivery_quote_status,
      'delivery_distance_meters', v_order.delivery_distance_meters
    );
  end if;

  -- ── Destino: out_of_coverage ──────────────────────────────────────────────
  if p_status = 'out_of_coverage' then
    if v_order.delivery_quote_status = 'out_of_coverage' then
      -- Idempotente si la distancia coincide; conflicto si difiere (no se pisa).
      if v_order.delivery_distance_meters is not distinct from p_distance_meters then
        v_result := 'already_applied';
      else
        return jsonb_build_object(
          'result', 'conflict',
          'order_id', v_order.id,
          'order_number', v_order.order_number,
          'delivery_quote_status', v_order.delivery_quote_status,
          'delivery_distance_meters', v_order.delivery_distance_meters
        );
      end if;
    else
      -- pending | failed → out_of_coverage: escribe la distancia real.
      v_result := 'applied';
    end if;

    if v_result = 'applied' then
      update public.orders
         set delivery_quote_status    = 'out_of_coverage',
             delivery_distance_meters = p_distance_meters
       where id = v_order.id;
    end if;

    return jsonb_build_object(
      'result', v_result,
      'order_id', v_order.id,
      'order_number', v_order.order_number,
      'delivery_quote_status', 'out_of_coverage',
      'delivery_distance_meters', p_distance_meters
    );
  end if;

  -- ── Destino: failed ───────────────────────────────────────────────────────
  -- out_of_coverage → failed jamás (no se revierte una decisión terminal).
  if v_order.delivery_quote_status = 'out_of_coverage' then
    return jsonb_build_object(
      'result', 'conflict',
      'order_id', v_order.id,
      'order_number', v_order.order_number,
      'delivery_quote_status', v_order.delivery_quote_status,
      'delivery_distance_meters', v_order.delivery_distance_meters
    );
  end if;

  -- Conservador con la distancia: nunca se borra. Solo se rellena si la actual
  -- es NULL y llega una válida; si ya hay una almacenada, se conserva intacta.
  if v_order.delivery_distance_meters is null then
    v_new_distance := p_distance_meters; -- puede seguir siendo NULL
  else
    v_new_distance := v_order.delivery_distance_meters; -- no se pisa
  end if;

  if v_order.delivery_quote_status = 'failed'
     and v_new_distance is not distinct from v_order.delivery_distance_meters then
    -- Ya estaba failed y no hay nueva información de distancia: no-op idempotente.
    v_result := 'already_applied';
  else
    v_result := 'applied';
    update public.orders
       set delivery_quote_status    = 'failed',
           delivery_distance_meters = v_new_distance
     where id = v_order.id;
  end if;

  return jsonb_build_object(
    'result', v_result,
    'order_id', v_order.id,
    'order_number', v_order.order_number,
    'delivery_quote_status', 'failed',
    'delivery_distance_meters', v_new_distance
  );
end;
$$;

-- ============================================================================
-- Permisos — exclusivamente service_role. anon / authenticated / public revocados.
-- El owner (postgres) conserva sus privilegios por defecto.
-- ============================================================================

revoke all on function public.mark_delivery_quote_result(uuid, text, integer) from public;
revoke all on function public.mark_delivery_quote_result(uuid, text, integer) from anon;
revoke all on function public.mark_delivery_quote_result(uuid, text, integer) from authenticated;
grant execute on function public.mark_delivery_quote_result(uuid, text, integer) to service_role;

commit;
