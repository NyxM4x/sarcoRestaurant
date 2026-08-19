-- ============================================================================
-- 0009_dynamic_delivery.sql — Fase 6D.2B
--
-- Prepara el modelo de datos del delivery dinámico SIN activarlo. Es ADITIVA y
-- BACKWARD-COMPATIBLE: puede aplicarse mientras producción vieja (acd7e64) sigue
-- creando pedidos con create_order_web_v2 (que quedan delivery_pricing = NULL).
--
-- Incluye EXCLUSIVAMENTE:
--   1. Columnas nuevas en public.orders (nullable, sin default, sin backfill).
--   2. public.create_order_web_v3 — RPC NUEVA (v2 y legacy quedan intactas).
--   3. public.apply_delivery_quote — RPC atómica de cotización (money guard).
--   4. Constraints y grants correspondientes.
--
-- NO TOCA (queda para 0010 / 6D.2C):
--   - order_notifications ni su CHECK;
--   - claim_order_notification, claim_notification_reconciliation,
--     select_due_notification_orders, initialize_order_notifications;
--   - mark_sent / mark_failed / reconcile / recovery;
--   - Cloudflare Worker.
--
-- NO modifica ni dropea create_order_web ni create_order_web_v2.
-- NO hace backfill de pedidos existentes (históricos, Flow y v2 → NULL).
--
-- Aplicar manualmente tras 0001..0008. Atómica: begin; ... commit;.
-- ============================================================================

begin;

-- ── 1. Columnas nuevas en public.orders ─────────────────────────────────────
-- Todas nullable, SIN default y SIN backfill: las filas previas quedan NULL.

alter table public.orders
  add column if not exists delivery_pricing text
    check (delivery_pricing is null or delivery_pricing = 'dynamic'),
  add column if not exists delivery_quote_status text
    check (
      delivery_quote_status is null
      or delivery_quote_status in ('pending', 'quoted', 'failed', 'out_of_coverage')
    ),
  -- Distancia REAL de auditoría. NO se limita a 18000: debe poder guardar una
  -- distancia mayor (p. ej. 21864 m) aunque el negocio la trate como fuera de
  -- cobertura. El límite comercial lo decide la lógica, no esta columna.
  add column if not exists delivery_distance_meters integer
    check (delivery_distance_meters is null or delivery_distance_meters >= 0);

-- ============================================================================
-- 2. create_order_web_v3
--
-- Copia EXACTA de create_order_web_v2 (0008) con UN solo añadido: el servidor
-- deriva delivery_pricing / delivery_quote_status a partir de p_delivery_type.
-- El cliente NO envía ese dato (misma firma de 7 args que v2): decidir si un
-- pedido es "dynamic" es responsabilidad del servidor.
--
--   delivery  → delivery_pricing = 'dynamic', delivery_quote_status = 'pending'
--   pickup    → delivery_pricing = NULL,      delivery_quote_status = NULL
--
-- Estados iniciales SIN cambios (pickup → confirmed, delivery → awaiting_location).
-- delivery_amount sigue 0 y total_amount = subtotal hasta que se cotice.
-- Idempotencia por checkout_fingerprint idéntica a v2.
-- ============================================================================

create function public.create_order_web_v3(
  p_menu_session_id uuid,
  p_customer_name text,
  p_delivery_type text,
  p_notes text,
  p_items_json jsonb,
  p_checkout_fingerprint text,
  p_payment_method text
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_session record;
  v_existing_order record;
  v_element record;
  v_item record;
  v_menu_item record;
  v_order_id uuid;
  v_order_number text;
  v_customer_phone text;
  v_subtotal numeric;
  v_total numeric;
  v_line_count int;
  v_code_count int;
  v_unique_codes int;
  v_code_text text;
  v_quantity_num numeric;
  v_customer_name_clean text;
  v_notes_clean text;
  v_initial_status text;
  v_confirmed_at timestamptz;
  v_delivery_pricing text;
  v_delivery_quote_status text;
begin
  -- VALIDACIÓN 1: Parámetros no nulos.
  if p_menu_session_id is null then
    raise exception 'menu_session_id required' using errcode = '22023';
  end if;

  if p_customer_name is null then
    raise exception 'customer_name required' using errcode = '22023';
  end if;

  if p_delivery_type is null then
    raise exception 'delivery_type required' using errcode = '22023';
  end if;

  if p_checkout_fingerprint is null then
    raise exception 'checkout_fingerprint required' using errcode = '22023';
  end if;

  -- VALIDACIÓN 1b (6D.1): método de pago obligatorio y válido.
  if p_payment_method is null or p_payment_method not in ('cash', 'qr') then
    raise exception 'payment_method must be cash or qr' using errcode = '22023';
  end if;

  -- VALIDACIÓN 2: p_items_json es un array de 1 a 20 líneas.
  if p_items_json is null or jsonb_typeof(p_items_json) <> 'array' then
    raise exception 'items must be a json array' using errcode = '22023';
  end if;

  v_line_count := jsonb_array_length(p_items_json);

  if v_line_count < 1 or v_line_count > 20 then
    raise exception 'items must have 1-20 elements' using errcode = '22023';
  end if;

  -- VALIDACIÓN 3: customer_name normalizado (btrim, 1-100 caracteres).
  v_customer_name_clean := btrim(p_customer_name);

  if v_customer_name_clean is null
     or v_customer_name_clean = ''
     or length(v_customer_name_clean) > 100 then
    raise exception 'customer_name must be 1-100 characters' using errcode = '22023';
  end if;

  -- VALIDACIÓN 4: delivery_type.
  if p_delivery_type not in ('delivery', 'pickup') then
    raise exception 'delivery_type must be delivery or pickup' using errcode = '22023';
  end if;

  -- VALIDACIÓN 5: notes normalizadas (nullif + btrim, máximo 500 caracteres).
  v_notes_clean := nullif(btrim(p_notes), '');

  if v_notes_clean is not null and length(v_notes_clean) > 500 then
    raise exception 'notes must be max 500 characters' using errcode = '22023';
  end if;

  -- VALIDACIÓN 6: checkout_fingerprint es SHA-256 hexadecimal (64 caracteres).
  if p_checkout_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'checkout_fingerprint must be 64 hex characters'
      using errcode = '22023';
  end if;

  -- VALIDACIÓN 7: Estructura de cada elemento del carrito.
  for v_element in
    select value
    from jsonb_array_elements(p_items_json) as t(value)
  loop
    if jsonb_typeof(v_element.value) <> 'object' then
      raise exception 'each item must be a json object' using errcode = '22023';
    end if;

    if jsonb_typeof(v_element.value -> 'code') is distinct from 'string' then
      raise exception 'each item requires a string code' using errcode = '22023';
    end if;

    if jsonb_typeof(v_element.value -> 'quantity') is distinct from 'number' then
      raise exception 'each item requires a numeric quantity' using errcode = '22023';
    end if;

    v_code_text := btrim(v_element.value ->> 'code');

    if v_code_text is null or v_code_text = '' then
      raise exception 'product code cannot be empty' using errcode = '22023';
    end if;

    v_quantity_num := (v_element.value ->> 'quantity')::numeric;

    if v_quantity_num is null or v_quantity_num <> trunc(v_quantity_num) then
      raise exception 'quantity must be an integer' using errcode = '22023';
    end if;

    if v_quantity_num < 1 or v_quantity_num > 10 then
      raise exception 'quantity must be 1-10' using errcode = '22023';
    end if;
  end loop;

  -- VALIDACIÓN 8: Códigos sin duplicados (comparados ya normalizados con btrim).
  select count(*), count(distinct btrim(item ->> 'code'))
  into v_code_count, v_unique_codes
  from jsonb_array_elements(p_items_json) as item;

  if v_code_count <> v_unique_codes then
    raise exception 'duplicate product codes' using errcode = '22023';
  end if;

  -- BLOQUEO 1: Sesión con FOR UPDATE.
  select id, customer_phone, phone_number_id, expires_at
  into v_session
  from public.menu_sessions
  where id = p_menu_session_id
  for update;

  if not found then
    raise exception 'session not found' using errcode = 'P1001';
  end if;

  -- VALIDACIÓN 9: Sesión vigente (revalidada dentro de la transacción).
  if v_session.expires_at <= now() then
    raise exception 'session expired' using errcode = 'P1001';
  end if;

  -- El teléfono sale de la sesión, nunca del request.
  v_customer_phone := v_session.customer_phone;

  -- BÚSQUEDA: Pedido existente para esta sesión (una sola consulta).
  select
    id,
    order_number,
    customer_name,
    delivery_type,
    status,
    subtotal_amount,
    delivery_amount,
    total_amount,
    payment_method,
    delivery_pricing,
    delivery_quote_status,
    delivery_distance_meters,
    checkout_fingerprint,
    created_at
  into v_existing_order
  from public.orders
  where menu_session_id = p_menu_session_id
  limit 1;

  -- REINTENTO vs. REUTILIZACIÓN DE SESIÓN.
  if found then
    if v_existing_order.checkout_fingerprint is distinct from p_checkout_fingerprint then
      raise exception 'session already used with a different cart' using errcode = 'P1003';
    end if;

    -- Reintento legítimo: mismo carrito, mismo pedido.
    return jsonb_build_object(
      'order_id', v_existing_order.id,
      'order_number', v_existing_order.order_number,
      'customer_name', v_existing_order.customer_name,
      'delivery_type', v_existing_order.delivery_type,
      'status', v_existing_order.status,
      'subtotal_amount', v_existing_order.subtotal_amount,
      'delivery_amount', v_existing_order.delivery_amount,
      'total_amount', v_existing_order.total_amount,
      'payment_method', v_existing_order.payment_method,
      'delivery_pricing', v_existing_order.delivery_pricing,
      'delivery_quote_status', v_existing_order.delivery_quote_status,
      'delivery_distance_meters', v_existing_order.delivery_distance_meters,
      'created_at', v_existing_order.created_at,
      'created', false
    );
  end if;

  -- BLOQUEO 2: Productos con FOR SHARE, en orden determinista por code.
  for v_item in
    select btrim(t.code) as code, t.quantity as quantity
    from jsonb_to_recordset(p_items_json)
      as t(code text, quantity integer)
    order by btrim(t.code) asc
  loop
    if v_item.code is null or v_item.code = '' then
      raise exception 'product code cannot be empty' using errcode = '22023';
    end if;

    if v_item.quantity is null then
      raise exception 'quantity required' using errcode = '22023';
    end if;

    if v_item.quantity < 1 or v_item.quantity > 10 then
      raise exception 'quantity must be 1-10' using errcode = '22023';
    end if;

    select *
    into v_menu_item
    from public.menu_items
    where code = v_item.code
      and is_active = true
    for share;

    if not found then
      raise exception 'product not found or inactive: %', v_item.code
        using errcode = 'P1002';
    end if;
  end loop;

  -- CÁLCULO: Subtotal desde public.menu_items (nunca del request).
  select coalesce(
    sum(((item ->> 'quantity')::integer) * m.price),
    0
  )
  into v_subtotal
  from jsonb_array_elements(p_items_json) as item
  join public.menu_items m
    on m.code = btrim(item ->> 'code')
   and m.is_active = true;

  if v_subtotal <= 0 then
    raise exception 'order total must be positive' using errcode = '22023';
  end if;

  -- El costo de envío se define fuera de la web en esta fase (0 hasta cotizar).
  v_total := v_subtotal;

  -- ESTADO INICIAL según delivery_type (SIN CAMBIOS respecto a v2).
  if p_delivery_type = 'pickup' then
    v_initial_status := 'confirmed';
    v_confirmed_at := now();
  else
    v_initial_status := 'awaiting_location';
    v_confirmed_at := null;
  end if;

  -- 6D.2B: el SERVIDOR deriva el modo de pricing (el cliente no lo envía).
  if p_delivery_type = 'delivery' then
    v_delivery_pricing := 'dynamic';
    v_delivery_quote_status := 'pending';
  else
    v_delivery_pricing := null;
    v_delivery_quote_status := null;
  end if;

  -- INSERCIÓN 1: public.orders (con payment_method + campos de pricing dinámico).
  insert into public.orders (
    menu_session_id,
    checkout_fingerprint,
    customer_phone,
    customer_name,
    delivery_type,
    notes,
    status,
    subtotal_amount,
    delivery_amount,
    total_amount,
    payment_method,
    delivery_pricing,
    delivery_quote_status,
    confirmed_at,
    flow_token,
    source_message_id,
    raw_flow_response,
    location_request_message_id
  ) values (
    p_menu_session_id,
    p_checkout_fingerprint,
    v_customer_phone,
    v_customer_name_clean,
    p_delivery_type,
    v_notes_clean,
    v_initial_status,
    v_subtotal,
    0,
    v_total,
    p_payment_method,
    v_delivery_pricing,
    v_delivery_quote_status,
    v_confirmed_at,
    null,
    null,
    null,
    null
  )
  returning id, order_number
  into v_order_id, v_order_number;

  -- INSERCIÓN 2: public.order_items (snapshots).
  insert into public.order_items (
    order_id,
    menu_item_id,
    product_code,
    product_name_snapshot,
    unit_price_snapshot,
    quantity,
    subtotal
  )
  select
    v_order_id,
    m.id,
    m.code,
    m.name,
    m.price,
    (item ->> 'quantity')::integer,
    m.price * ((item ->> 'quantity')::integer)
  from jsonb_array_elements(p_items_json) as item
  join public.menu_items m
    on m.code = btrim(item ->> 'code')
   and m.is_active = true;

  -- RESPUESTA: pedido nuevo (created = true). delivery_distance_meters es NULL
  -- hasta que apply_delivery_quote lo escriba (delivery dinámico).
  return jsonb_build_object(
    'order_id', v_order_id,
    'order_number', v_order_number,
    'customer_name', v_customer_name_clean,
    'delivery_type', p_delivery_type,
    'status', v_initial_status,
    'subtotal_amount', v_subtotal,
    'delivery_amount', 0,
    'total_amount', v_total,
    'payment_method', p_payment_method,
    'delivery_pricing', v_delivery_pricing,
    'delivery_quote_status', v_delivery_quote_status,
    'delivery_distance_meters', null,
    'created_at', (select created_at from public.orders where id = v_order_id),
    'created', true
  );

end;
$$;

-- ============================================================================
-- 3. apply_delivery_quote
--
-- Aplica ATÓMICAMENTE una cotización EXITOSA a un pedido delivery dinámico que
-- todavía espera ubicación/cotización. El servidor/base es la autoridad del
-- total: NO acepta p_total_amount; total = subtotal + delivery.
--
-- MONEY GUARD: valida que p_delivery_amount coincida EXACTAMENTE con el tarifario
-- correspondiente a p_distance_meters. Esta fórmula DEBE permanecer sincronizada
-- con src/lib/delivery/fee.ts (misma regla del negocio):
--   0–3000 m → Bs 10 ; luego +Bs 2 por cada 1000 m o fracción iniciada ;
--   máximo comercial 18000 m → Bs 40 ; > 18000 m NO se cotiza automáticamente.
-- fee.ts es la fuente del flujo server-side; esta RPC es la defensa final.
--
-- Idempotencia y concurrencia (SELECT ... FOR UPDATE serializa):
--   - pending|failed + awaiting_location + dynamic → escribe → confirmed → 'applied'
--   - ya 'quoted' con misma distancia/monto                       → 'already_applied'
--   - ya 'quoted' con distancia/monto distintos (nunca sobrescribe)→ 'conflict'
-- ============================================================================

create function public.apply_delivery_quote(
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
  v_extra_steps integer;
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

  -- MONEY GUARD — tarifario defensivo. Solo aritmética entera para el escalón
  -- (ceil por división entera). MANTENER SINCRONIZADO con src/lib/delivery/fee.ts.
  if p_distance_meters <= 3000 then
    v_expected := 10;
  else
    v_extra_steps := (p_distance_meters - 3000 + 999) / 1000; -- ceil entero
    v_expected := 10 + v_extra_steps * 2;
  end if;

  if p_delivery_amount <> v_expected then
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

-- ============================================================================
-- 4. Permisos — exclusivamente service_role (mismo principio que las RPC actuales).
-- anon / authenticated / public quedan revocados. create_order_web y v2 NO se tocan.
-- ============================================================================

revoke all on function public.create_order_web_v3(uuid, text, text, text, jsonb, text, text)
  from public;
revoke all on function public.create_order_web_v3(uuid, text, text, text, jsonb, text, text)
  from anon;
revoke all on function public.create_order_web_v3(uuid, text, text, text, jsonb, text, text)
  from authenticated;
grant execute on function public.create_order_web_v3(uuid, text, text, text, jsonb, text, text)
  to service_role;

revoke all on function public.apply_delivery_quote(uuid, integer, numeric) from public;
revoke all on function public.apply_delivery_quote(uuid, integer, numeric) from anon;
revoke all on function public.apply_delivery_quote(uuid, integer, numeric) from authenticated;
grant execute on function public.apply_delivery_quote(uuid, integer, numeric) to service_role;

commit;
