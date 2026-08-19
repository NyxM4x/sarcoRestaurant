-- ============================================================================
-- 0008_payment_method.sql — Fase 6D.1
--
-- Método de pago manual (Efectivo / QR). Alcance mínimo:
--   * Nueva columna orders.payment_method, NULLABLE y SIN DEFAULT.
--   * CHECK: solo 'cash', 'qr' o NULL.
--   * NO se hace backfill: los pedidos históricos quedan payment_method = NULL
--     ("pago no registrado"), NO se convierten en efectivo.
--   * Los pedidos del WhatsApp Flow (que NO pasan por create_order_web) también
--     quedan NULL: es intencional y compatible (reciben confirmación de texto).
--   * create_order_web recibe p_payment_method y lo EXIGE ('cash' | 'qr'): solo
--     los pedidos creados desde /menu guardan un método obligatorio.
--
-- NO toca: notification_type, su CHECK, ni las funciones de claim/retry/
-- reconcile. NO añade payment_status (eso es 6D.2). NO cambia el estado inicial
-- (pickup → confirmed, delivery → awaiting_location) ni la idempotencia.
-- ============================================================================

-- ── Columna payment_method (nullable, sin default) ──────────────────────────
alter table public.orders
  add column if not exists payment_method text
    check (payment_method is null or payment_method in ('cash', 'qr'));

-- ── create_order_web_v2: nueva RPC ADITIVA (rollout sin downtime) ───────────
--
-- ESTRATEGIA DE DESPLIEGUE SIN VENTANA DE CAÍDA:
--   La función legacy public.create_order_web(6 args) NO SE TOCA (ni DROP ni
--   CREATE OR REPLACE). Producción actual la sigue usando con normalidad ANTES
--   y DESPUÉS de aplicar esta migración. En su lugar se crea una función NUEVA
--   con OTRO NOMBRE, create_order_web_v2, con el 7º parámetro p_payment_method.
--   Secuencia garantizada:
--     * antes de aplicar 0008: prod (afd7228) llama create_order_web → funciona;
--     * tras aplicar 0008 pero ANTES del deploy 6D.1: legacy intacta → funciona;
--     * tras el deploy 6D.1: el código nuevo llama create_order_web_v2 → funciona.
--   Nunca existe un instante en el que /menu se quede sin una RPC válida.
--
--   Se descartó la sobrecarga create_order_web(6)+create_order_web(7): aunque
--   PostgREST puede resolver overloads por nombres de parámetros, cualquier
--   ambigüedad (o recarga de caché de esquema) es un riesgo innecesario. Con
--   nombres distintos PostgREST NUNCA tiene que elegir: cero ambigüedad.
--
-- create_order_web_v2 es una COPIA de create_order_web (0003) con EXACTAMENTE
-- tres añadidos:
--   (1) el parámetro p_payment_method y su validación (cash|qr, no nulo);
--   (2) payment_method en el INSERT y en el jsonb de respuesta del pedido nuevo;
--   (3) payment_method en el SELECT y el jsonb del reintento idempotente.
-- El resto del cuerpo es idéntico a 0003 (misma lógica, validaciones, bloqueos,
-- cálculo de precios y snapshots, estado inicial e idempotencia por fingerprint).
--
-- RETIRO FUTURO (fuera de 6D.1): cuando 6D.1 esté desplegado y estable y ninguna
-- versión de la app llame ya a la legacy, una migración posterior podrá ejecutar
-- de forma segura:
--   drop function public.create_order_web(uuid, text, text, text, jsonb, text);

create function public.create_order_web_v2(
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
  -- Solo los pedidos web pasan por aquí, así que /menu SIEMPRE guarda cash|qr.
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
    checkout_fingerprint,
    created_at
  into v_existing_order
  from public.orders
  where menu_session_id = p_menu_session_id
  limit 1;

  -- REINTENTO vs. REUTILIZACIÓN DE SESIÓN.
  -- El fingerprint (que el servidor calcula ya incluyendo payment_method)
  -- distingue un reintento legítimo de un carrito/método distinto.
  if found then
    if v_existing_order.checkout_fingerprint is distinct from p_checkout_fingerprint then
      raise exception 'session already used with a different cart' using errcode = 'P1003';
    end if;

    -- Reintento legítimo: mismo carrito, mismo pedido (se devuelve el método ya guardado).
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

  -- El costo de envío se define fuera de la web en esta fase.
  v_total := v_subtotal;

  -- ESTADO INICIAL según delivery_type (SIN CAMBIOS).
  if p_delivery_type = 'pickup' then
    v_initial_status := 'confirmed';
    v_confirmed_at := now();
  else
    v_initial_status := 'awaiting_location';
    v_confirmed_at := null;
  end if;

  -- INSERCIÓN 1: public.orders (ahora con payment_method).
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

  -- RESPUESTA: pedido nuevo (created = true).
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
    'created_at', (select created_at from public.orders where id = v_order_id),
    'created', true
  );

end;
$$;

-- ── Permisos (create_order_web_v2, 7 args) ──────────────────────────────────
-- La RPC solo se invoca desde el backend con SUPABASE_SERVICE_ROLE_KEY. Los
-- permisos de la legacy create_order_web (6 args) NO se tocan: quedan como en 0003.

revoke all on function public.create_order_web_v2(uuid, text, text, text, jsonb, text, text)
  from public;
revoke all on function public.create_order_web_v2(uuid, text, text, text, jsonb, text, text)
  from anon;
revoke all on function public.create_order_web_v2(uuid, text, text, text, jsonb, text, text)
  from authenticated;

grant execute on function public.create_order_web_v2(uuid, text, text, text, jsonb, text, text)
  to service_role;
