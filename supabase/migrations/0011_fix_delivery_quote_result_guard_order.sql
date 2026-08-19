-- ============================================================================
-- 0011_fix_delivery_quote_result_guard_order.sql — Fase 6D.2C (corrección)
--
-- CORRIGE el ORDEN DE GUARDAS de public.mark_delivery_quote_result (creada en
-- 0010, ya aplicada). 0010 evaluaba `status = 'awaiting_location'` ANTES de la
-- protección `delivery_quote_status = 'quoted'`. Como apply_delivery_quote deja
-- un pedido cotizado en status='confirmed' (y quote='quoted'), una llamada
-- posterior a mark_delivery_quote_result sobre ese pedido LANZABA
-- 'order is not awaiting_location' en lugar de devolver el contrato acordado:
--   { result: 'conflict', ... } sin modificar nada.
--
-- ÚNICO cambio funcional: mover la guarda de 'quoted' → conflict ANTES de la
-- guarda status='awaiting_location'. Todo lo demás es IDÉNTICO a 0010:
--   - locking SELECT ... FOR UPDATE;
--   - guardas delivery_type='delivery' y delivery_pricing='dynamic';
--   - validación out_of_coverage > 18000;
--   - idempotencia failed / out_of_coverage; out_of_coverage→failed = conflict;
--   - distancia conservadora en failed (nunca borra);
--   - NUNCA escribe delivery_amount / subtotal_amount / total_amount /
--     confirmed_at / status;
--   - grants solo service_role.
--
-- Es CREATE OR REPLACE (la función ya existe en la BD por 0010). Misma firma y
-- mismo retorno. NO toca 0009/0010 como archivos ni otras funciones.
--
-- Aplicar manualmente tras 0001..0010. Atómica: begin; ... commit;.
-- ============================================================================

begin;

create or replace function public.mark_delivery_quote_result(
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

  -- Guardas de dominio: solo delivery dinámico.
  if v_order.delivery_type <> 'delivery' then
    raise exception 'order is not delivery' using errcode = '22023';
  end if;
  if v_order.delivery_pricing is distinct from 'dynamic' then
    raise exception 'order is not dynamic pricing' using errcode = '22023';
  end if;

  -- ⚑ CORRECCIÓN 0011: la protección de una cotización EXITOSA se evalúa ANTES de
  -- exigir awaiting_location. Un pedido 'quoted' ya está en status='confirmed';
  -- debe devolver conflict SIN modificar nada, no lanzar 'not awaiting_location'.
  if v_order.delivery_quote_status = 'quoted' then
    return jsonb_build_object(
      'result', 'conflict',
      'order_id', v_order.id,
      'order_number', v_order.order_number,
      'delivery_quote_status', v_order.delivery_quote_status,
      'delivery_distance_meters', v_order.delivery_distance_meters
    );
  end if;

  -- Ya descartado 'quoted', el resto de transiciones (pending / failed /
  -- out_of_coverage) SÍ ocurren con el pedido esperando ubicación.
  if v_order.status <> 'awaiting_location' then
    raise exception 'order is not awaiting_location (status=%)', v_order.status
      using errcode = '22023';
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
-- Permisos — se re-otorgan (idempotente y autocontenido). Solo service_role.
-- ============================================================================

revoke all on function public.mark_delivery_quote_result(uuid, text, integer) from public;
revoke all on function public.mark_delivery_quote_result(uuid, text, integer) from anon;
revoke all on function public.mark_delivery_quote_result(uuid, text, integer) from authenticated;
grant execute on function public.mark_delivery_quote_result(uuid, text, integer) to service_role;

commit;
