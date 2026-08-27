-- ============================================================================
-- 0024 — Tarifario nuevo del proveedor + recargo por lluvia
-- ============================================================================
--
-- El proveedor publicó un tarifario por tramos que NO sigue ninguna progresión:
-- de 3 a 4 km sube 1 Bs, de 8 a 9 sube 4, y el tramo de 9.1 a 11 abarca dos
-- kilómetros. La fórmula anterior (Bs 10 + Bs 2 por km) ya no lo describe.
--
-- ── Por qué esta migración es OBLIGATORIA ───────────────────────────────────
--
-- `apply_delivery_quote` lleva un money guard que compara el importe recibido
-- con el tarifario y RECHAZA cualquier diferencia. Si el código calcula con la
-- tabla nueva y la RPC sigue con la fórmula vieja, TODA cotización de delivery
-- falla: el pedido se queda en `awaiting_location` y el cliente nunca recibe su
-- QR. No es una mejora que pueda esperar; sin ella el delivery deja de existir.
--
-- ── El guard sigue siendo estricto donde importa ────────────────────────────
--
-- Acepta el tramo o el tramo + recargo de lluvia, y nada más. Lo que previene es
-- que llegue un importe arbitrario —Bs 0, Bs 1000, uno negociado por quien haga
-- la llamada—, no la diferencia de 3 Bs entre llover y no llover. Consultar el
-- interruptor aquí dentro habría abierto una carrera: si el encargado lo apaga
-- entre el cálculo y la escritura, la cotización fallaría por un motivo que
-- nadie podría explicar.
--
-- ── Lo que NO cambia ────────────────────────────────────────────────────────
--
-- La cobertura máxima (18 km), la idempotencia por estado, el FOR UPDATE, y el
-- resto del cuerpo de la función. Solo se sustituye el bloque del tarifario.
-- ============================================================================

-- ── Ajustes operativos del delivery ─────────────────────────────────────────
--
-- Fila única: `id` fijado a 1 por un CHECK. Es un interruptor que el encargado
-- mueve desde el panel, no una tabla de configuración general — si mañana hacen
-- falta más ajustes del delivery, caben aquí sin inventar otra tabla.
create table if not exists public.delivery_settings (
  id                    smallint primary key default 1,
  /** ¿Está activa la tarifa de lluvia (+3 Bs)? La enciende el encargado. */
  rain_surcharge_active boolean not null default false,
  updated_at            timestamptz not null default now(),

  constraint delivery_settings_singleton check (id = 1)
);

-- La fila existe SIEMPRE: leer un interruptor no puede depender de que alguien
-- lo haya encendido alguna vez.
insert into public.delivery_settings (id, rain_surcharge_active)
values (1, false)
on conflict (id) do nothing;

-- ── Tarifario como función ──────────────────────────────────────────────────
--
-- Espejo exacto de `DELIVERY_TIERS` en src/lib/delivery/fee.ts. Vive aparte del
-- guard para poder leerse de un vistazo junto al cartel del proveedor.
-- MANTENER SINCRONIZADO con src/lib/delivery/fee.ts.
create or replace function public.delivery_tariff_for_meters(p_meters integer)
returns numeric
language sql
immutable
set search_path = public
as $$
  select case
    when p_meters <=  2000 then 10   -- 0.1 –  2 km
    when p_meters <=  3000 then 12   -- 2.1 –  3 km
    when p_meters <=  4000 then 13   -- 3.1 –  4 km
    when p_meters <=  5000 then 15   -- 4.1 –  5 km
    when p_meters <=  6000 then 17   -- 5.1 –  6 km
    when p_meters <=  7000 then 19   -- 6.1 –  7 km
    when p_meters <=  8000 then 21   -- 7.1 –  8 km
    when p_meters <=  9000 then 25   -- 8.1 –  9 km
    when p_meters <= 11000 then 27   -- 9.1 – 11 km  (dos kilómetros)
    when p_meters <= 12000 then 30   -- 11.1 – 12 km
    when p_meters <= 13000 then 32   -- 12.1 – 13 km
    when p_meters <= 14000 then 34   -- 13.1 – 14 km
    when p_meters <= 15000 then 36   -- 14.1 – 15 km
    when p_meters <= 16000 then 40   -- 15.1 – 16 km
    when p_meters <= 17000 then 42   -- 16.1 – 17 km
    when p_meters <= 18000 then 44   -- 17.1 – 18 km
    else null                        -- fuera de cobertura: sin precio
  end;
$$;

comment on function public.delivery_tariff_for_meters(integer) is
  'Tarifario por tramos del proveedor. Espejo de DELIVERY_TIERS en src/lib/delivery/fee.ts.';

-- ── Money guard actualizado ─────────────────────────────────────────────────
--
-- Es la función de 0009 con UN solo bloque cambiado: el que calcula el importe
-- esperado. Todo lo demás —las excepciones, la idempotencia, el FOR UPDATE, los
-- campos que devuelve— se conserva palabra por palabra. Reescribirla entera
-- habría sido la forma más fácil de perder una condición sin notarlo.

create or replace function public.apply_delivery_quote(
  p_order_id uuid,
  p_distance_meters integer,
  p_delivery_amount numeric
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_order record;
  v_expected numeric;
  v_total numeric;
begin
  -- Validación de entrada.
  if p_order_id is null then
    raise exception 'order_id required' using errcode = '22023';
  end if;
  if p_distance_meters is null or p_distance_meters < 0 then
    raise exception 'distance_meters must be a non-negative integer' using errcode = '22023';
  end if;
  if p_delivery_amount is null or p_delivery_amount < 0 then
    raise exception 'delivery_amount must be non-negative' using errcode = '22023';
  end if;

  -- Cobertura: > 18 km NO produce cotización exitosa (defensa; el flujo real
  -- decide out_of_coverage con fee.ts ANTES de llamar aquí). El manejo del
  -- estado out_of_coverage se cablea en 6D.2C.
  if p_distance_meters > 18000 then
    raise exception 'distance out of coverage (> 18000 m)' using errcode = '22023';
  end if;

  -- MONEY GUARD — tarifario por tramos del proveedor (migracion 0024).
  -- La tabla vive en delivery_tariff_for_meters, espejo de DELIVERY_TIERS en
  -- src/lib/delivery/fee.ts. Se acepta el tramo o el tramo + recargo de lluvia
  -- (3 Bs): lo que este guard impide es un importe arbitrario, no la diferencia
  -- entre llover y no llover.
  v_expected := public.delivery_tariff_for_meters(p_distance_meters);
  if v_expected is null then
    raise exception 'no tariff for % m', p_distance_meters using errcode = '22023';
  end if;

  if p_delivery_amount <> v_expected and p_delivery_amount <> v_expected + 3 then
    raise exception 'delivery_amount % does not match tariff % for % m',
      p_delivery_amount, v_expected, p_distance_meters using errcode = '22023';
  end if;

  -- BLOQUEO: fila del pedido con FOR UPDATE (serializa ejecuciones concurrentes).
  select
    id, order_number, delivery_type, status,
    delivery_pricing, delivery_quote_status,
    subtotal_amount, delivery_amount, total_amount,
    delivery_distance_meters, confirmed_at
  into v_order
  from public.orders
  where id = p_order_id
  for update;

  if not found then
    raise exception 'order not found' using errcode = 'P1001';
  end if;

  -- Solo delivery dinámico.
  if v_order.delivery_type <> 'delivery' then
    raise exception 'order is not delivery' using errcode = '22023';
  end if;
  if v_order.delivery_pricing is distinct from 'dynamic' then
    raise exception 'order is not dynamic pricing' using errcode = '22023';
  end if;

  -- IDEMPOTENCIA: cotización ya cerrada.
  if v_order.delivery_quote_status = 'quoted' then
    if v_order.delivery_distance_meters = p_distance_meters
       and v_order.delivery_amount = p_delivery_amount then
      return jsonb_build_object(
        'result', 'already_applied',
        'order_id', v_order.id,
        'order_number', v_order.order_number,
        'delivery_distance_meters', v_order.delivery_distance_meters,
        'delivery_amount', v_order.delivery_amount,
        'total_amount', v_order.total_amount,
        'status', v_order.status,
        'delivery_quote_status', v_order.delivery_quote_status
      );
    end if;
    -- Distancia/monto distintos: una cotización cerrada NUNCA se sobrescribe.
    return jsonb_build_object(
      'result', 'conflict',
      'order_id', v_order.id,
      'order_number', v_order.order_number,
      'delivery_distance_meters', v_order.delivery_distance_meters,
      'delivery_amount', v_order.delivery_amount,
      'total_amount', v_order.total_amount,
      'status', v_order.status,
      'delivery_quote_status', v_order.delivery_quote_status
    );
  end if;

  -- APLICAR: solo desde un estado pre-cotización y esperando ubicación.
  -- Se acepta 'failed' además de 'pending' para permitir el reintento de una
  -- cotización que falló técnicamente (Mapbox) SIN tener que reemplazar esta RPC
  -- en 6D.2C; ambos son estados donde aún no hay una cotización válida escrita.
  if v_order.status <> 'awaiting_location'
     or v_order.delivery_quote_status is null
     or v_order.delivery_quote_status not in ('pending', 'failed') then
    raise exception 'order not in a quotable state (status=%, quote=%)',
      v_order.status, v_order.delivery_quote_status using errcode = '22023';
  end if;

  -- Total recalculado desde la BASE, nunca desde el cliente.
  v_total := v_order.subtotal_amount + p_delivery_amount;

  update public.orders
     set delivery_distance_meters = p_distance_meters,
         delivery_amount          = p_delivery_amount,
         total_amount             = v_total,
         delivery_quote_status    = 'quoted',
         status                   = 'confirmed',
         confirmed_at             = coalesce(confirmed_at, now())
   where id = v_order.id;

  return jsonb_build_object(
    'result', 'applied',
    'order_id', v_order.id,
    'order_number', v_order.order_number,
    'delivery_distance_meters', p_distance_meters,
    'delivery_amount', p_delivery_amount,
    'total_amount', v_total,
    'status', 'confirmed',
    'delivery_quote_status', 'quoted'
  );
end;
$$;

comment on function public.apply_delivery_quote(uuid, integer, numeric) is
  'Aplica la cotizacion de delivery con money guard contra delivery_tariff_for_meters (0024).';
