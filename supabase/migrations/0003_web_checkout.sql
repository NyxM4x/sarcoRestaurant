-- ============================================================================
-- La Fija Orders — Checkout web (0003_web_checkout)
--
-- Agrega soporte para creación de pedidos desde la web:
-- - Columna menu_session_id (UNIQUE) para correlacionar sesión → pedido
-- - Columna checkout_fingerprint para detectar reutilización con carrito distinto
-- - RPC transaccional para creación atómica de pedido + items
-- - Bloqueo pesimista (FOR UPDATE + FOR SHARE) para serializar y proteger precios
--
-- NO ejecutar automáticamente. Aplicar manualmente después de 0001 + 0002.
-- Postgres / Supabase.
-- ============================================================================

-- ── Alteraciones de public.orders ───────────────────────────────────────────

-- Correlación sesión → pedido. Nullable: los pedidos de WhatsApp Flow no la usan.
alter table public.orders
  add column if not exists menu_session_id uuid;

-- Huella canónica del checkout web (SHA-256 hex). Nullable por la misma razón.
alter table public.orders
  add column if not exists checkout_fingerprint text;

-- ── Foreign key hacia public.menu_sessions ──────────────────────────────────
-- Idempotente: se comprueba pg_constraint antes de agregarla.

do $$
begin
  if not exists (
    select 1
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public'
      and t.relname = 'orders'
      and c.conname = 'orders_menu_session_id_fk'
  ) then
    alter table public.orders
      add constraint orders_menu_session_id_fk
      foreign key (menu_session_id)
      references public.menu_sessions (id)
      on delete restrict;
  end if;
end $$;

-- ── UNIQUE(menu_session_id) ─────────────────────────────────────────────────
-- Una sesión crea como máximo un pedido.
-- No se crea índice adicional: la restricción UNIQUE ya genera el suyo.

do $$
begin
  if not exists (
    select 1
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public'
      and t.relname = 'orders'
      and c.conname = 'orders_menu_session_id_unique'
  ) then
    alter table public.orders
      add constraint orders_menu_session_id_unique
      unique (menu_session_id);
  end if;
end $$;

-- ── CHECK del formato de checkout_fingerprint ───────────────────────────────
-- NULL (pedidos de WhatsApp Flow) o SHA-256 hexadecimal de 64 caracteres.

do $$
begin
  if not exists (
    select 1
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public'
      and t.relname = 'orders'
      and c.conname = 'orders_checkout_fingerprint_format'
  ) then
    alter table public.orders
      add constraint orders_checkout_fingerprint_format
      check (
        checkout_fingerprint is null
        or checkout_fingerprint ~ '^[0-9a-f]{64}$'
      );
  end if;
end $$;

-- ============================================================================
-- RPC: public.create_order_web
-- ============================================================================
-- Transaccional. Serializa accesos por sesión (FOR UPDATE) y congela precios
-- (FOR SHARE). Valida sesión, estructura del carrito y productos. Calcula el
-- subtotal desde public.menu_items. Crea order + order_items atómicamente.
--
-- Firma:
--   public.create_order_web(
--     p_menu_session_id uuid,
--     p_customer_name text,
--     p_delivery_type text,
--     p_notes text,
--     p_items_json jsonb,
--     p_checkout_fingerprint text
--   ) returns jsonb
--
-- SQLSTATE:
--   P1001: sesión inexistente o vencida
--   P1002: producto inexistente o inactivo
--   P1003: sesión ya usada con un fingerprint diferente
--   22023: parámetros o estructura inválida
--
-- Respuesta:
--   {
--     order_id: uuid,
--     order_number: text,
--     customer_name: text,
--     delivery_type: text,
--     status: text,
--     subtotal_amount: numeric,
--     delivery_amount: numeric (siempre 0 en esta fase),
--     total_amount: numeric,
--     created_at: timestamptz,
--     created: boolean (true = nuevo, false = reintento con mismo fingerprint)
--   }
--
-- El teléfono NUNCA llega por parámetro: se toma de public.menu_sessions.

create or replace function public.create_order_web(
  p_menu_session_id uuid,
  p_customer_name text,
  p_delivery_type text,
  p_notes text,
  p_items_json jsonb,
  p_checkout_fingerprint text
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
  -- ──────────────────────────────────────────────────────────────────────────
  -- VALIDACIÓN 1: Parámetros no nulos (explícito, sin depender de comparaciones
  -- que devolverían NULL)
  -- ──────────────────────────────────────────────────────────────────────────

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

  -- ──────────────────────────────────────────────────────────────────────────
  -- VALIDACIÓN 2: p_items_json es un array de 1 a 20 líneas
  -- ──────────────────────────────────────────────────────────────────────────

  if p_items_json is null or jsonb_typeof(p_items_json) <> 'array' then
    raise exception 'items must be a json array' using errcode = '22023';
  end if;

  v_line_count := jsonb_array_length(p_items_json);

  if v_line_count < 1 or v_line_count > 20 then
    raise exception 'items must have 1-20 elements' using errcode = '22023';
  end if;

  -- ──────────────────────────────────────────────────────────────────────────
  -- VALIDACIÓN 3: customer_name normalizado (btrim, 1-100 caracteres)
  -- ──────────────────────────────────────────────────────────────────────────

  v_customer_name_clean := btrim(p_customer_name);

  if v_customer_name_clean is null
     or v_customer_name_clean = ''
     or length(v_customer_name_clean) > 100 then
    raise exception 'customer_name must be 1-100 characters' using errcode = '22023';
  end if;

  -- ──────────────────────────────────────────────────────────────────────────
  -- VALIDACIÓN 4: delivery_type
  -- ──────────────────────────────────────────────────────────────────────────

  if p_delivery_type not in ('delivery', 'pickup') then
    raise exception 'delivery_type must be delivery or pickup' using errcode = '22023';
  end if;

  -- ──────────────────────────────────────────────────────────────────────────
  -- VALIDACIÓN 5: notes normalizadas (nullif + btrim, máximo 500 caracteres)
  -- ──────────────────────────────────────────────────────────────────────────

  v_notes_clean := nullif(btrim(p_notes), '');

  if v_notes_clean is not null and length(v_notes_clean) > 500 then
    raise exception 'notes must be max 500 characters' using errcode = '22023';
  end if;

  -- ──────────────────────────────────────────────────────────────────────────
  -- VALIDACIÓN 6: checkout_fingerprint es SHA-256 hexadecimal (64 caracteres)
  -- ──────────────────────────────────────────────────────────────────────────

  if p_checkout_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'checkout_fingerprint must be 64 hex characters'
      using errcode = '22023';
  end if;

  -- ──────────────────────────────────────────────────────────────────────────
  -- VALIDACIÓN 7: Estructura de cada elemento del carrito.
  --
  -- Se recorre con jsonb_array_elements ANTES de usar jsonb_to_recordset para
  -- que un item malformado produzca 22023 y no un error inesperado de Postgres
  -- (22P02 por un cast fallido, 23502 por un NOT NULL, etc.).
  --
  -- jsonb_typeof(x -> 'clave') devuelve NULL si la clave no existe, así que
  -- "is distinct from" cubre a la vez clave ausente y tipo incorrecto.
  -- ──────────────────────────────────────────────────────────────────────────

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

  -- ──────────────────────────────────────────────────────────────────────────
  -- VALIDACIÓN 8: Códigos sin duplicados (comparados ya normalizados con btrim).
  -- Se ejecuta DESPUÉS de la validación estructural para que un carrito
  -- malformado no se reporte como "duplicados".
  -- ──────────────────────────────────────────────────────────────────────────

  select count(*), count(distinct btrim(item ->> 'code'))
  into v_code_count, v_unique_codes
  from jsonb_array_elements(p_items_json) as item;

  if v_code_count <> v_unique_codes then
    raise exception 'duplicate product codes' using errcode = '22023';
  end if;

  -- ──────────────────────────────────────────────────────────────────────────
  -- BLOQUEO 1: Sesión con FOR UPDATE.
  -- Serializa solicitudes simultáneas de la misma sesión (doble clic, reintento
  -- por red lenta): la segunda espera y encuentra el pedido ya creado.
  --
  -- phone_number_id se selecciona aquí y queda disponible como
  -- v_session.phone_number_id para la fase posterior de WhatsApp/ubicación.
  -- ──────────────────────────────────────────────────────────────────────────

  select id, customer_phone, phone_number_id, expires_at
  into v_session
  from public.menu_sessions
  where id = p_menu_session_id
  for update;

  if not found then
    raise exception 'session not found' using errcode = 'P1001';
  end if;

  -- ──────────────────────────────────────────────────────────────────────────
  -- VALIDACIÓN 9: Sesión vigente (revalidada dentro de la transacción)
  -- ──────────────────────────────────────────────────────────────────────────

  if v_session.expires_at <= now() then
    raise exception 'session expired' using errcode = 'P1001';
  end if;

  -- El teléfono sale de la sesión, nunca del request.
  v_customer_phone := v_session.customer_phone;

  -- ──────────────────────────────────────────────────────────────────────────
  -- BÚSQUEDA: Pedido existente para esta sesión (una sola consulta)
  -- ──────────────────────────────────────────────────────────────────────────

  select
    id,
    order_number,
    customer_name,
    delivery_type,
    status,
    subtotal_amount,
    delivery_amount,
    total_amount,
    checkout_fingerprint,
    created_at
  into v_existing_order
  from public.orders
  where menu_session_id = p_menu_session_id
  limit 1;

  -- ──────────────────────────────────────────────────────────────────────────
  -- REINTENTO vs. REUTILIZACIÓN DE SESIÓN
  --
  -- IS DISTINCT FROM (no <>) para que un fingerprint NULL en el pedido previo
  -- —caso imposible hoy, pero defensivo— cuente como diferente.
  -- ──────────────────────────────────────────────────────────────────────────

  if found then
    if v_existing_order.checkout_fingerprint is distinct from p_checkout_fingerprint then
      -- Misma sesión, carrito distinto: el endpoint responde 409 y NO vacía el carrito.
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
      'created_at', v_existing_order.created_at,
      'created', false
    );
  end if;

  -- ──────────────────────────────────────────────────────────────────────────
  -- BLOQUEO 2: Productos con FOR SHARE, en orden determinista por code.
  --
  -- El orden fijo evita deadlocks entre transacciones concurrentes. El bloqueo
  -- compartido congela los precios hasta el COMMIT, de modo que el subtotal y
  -- los snapshots de order_items usen exactamente el mismo valor.
  --
  -- Tras la VALIDACIÓN 7, jsonb_to_recordset es seguro: todos los elementos son
  -- objetos con code string y quantity number entero en rango. Las comprobaciones
  -- de NULL se mantienen como defensa en profundidad.
  -- ──────────────────────────────────────────────────────────────────────────

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

  -- ──────────────────────────────────────────────────────────────────────────
  -- CÁLCULO: Subtotal desde public.menu_items (nunca del request).
  -- Los productos ya están bloqueados con FOR SHARE.
  -- ──────────────────────────────────────────────────────────────────────────

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

  -- ──────────────────────────────────────────────────────────────────────────
  -- ESTADO INICIAL según delivery_type
  -- ──────────────────────────────────────────────────────────────────────────

  if p_delivery_type = 'pickup' then
    v_initial_status := 'confirmed';
    v_confirmed_at := now();
  else
    -- 'delivery': falta la ubicación, que llega por WhatsApp.
    v_initial_status := 'awaiting_location';
    v_confirmed_at := null;
  end if;

  -- ──────────────────────────────────────────────────────────────────────────
  -- INSERCIÓN 1: public.orders
  --
  -- Los campos de WhatsApp Flow quedan en NULL: los pedidos web no los usan.
  -- ──────────────────────────────────────────────────────────────────────────

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
    v_confirmed_at,
    null,
    null,
    null,
    null
  )
  returning id, order_number
  into v_order_id, v_order_number;

  -- ──────────────────────────────────────────────────────────────────────────
  -- INSERCIÓN 2: public.order_items (snapshots).
  --
  -- Misma transacción que la inserción del pedido: cualquier error revierte
  -- todo y no deja pedidos sin líneas. Nombre y precio salen de los productos
  -- bloqueados, no del request.
  -- ──────────────────────────────────────────────────────────────────────────

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

  -- ──────────────────────────────────────────────────────────────────────────
  -- RESPUESTA: pedido nuevo (created = true)
  -- ──────────────────────────────────────────────────────────────────────────

  return jsonb_build_object(
    'order_id', v_order_id,
    'order_number', v_order_number,
    'customer_name', v_customer_name_clean,
    'delivery_type', p_delivery_type,
    'status', v_initial_status,
    'subtotal_amount', v_subtotal,
    'delivery_amount', 0,
    'total_amount', v_total,
    'created_at', (select created_at from public.orders where id = v_order_id),
    'created', true
  );

end;
$$;

-- ── Permisos ────────────────────────────────────────────────────────────────
-- La RPC solo se invoca desde el backend con SUPABASE_SERVICE_ROLE_KEY.

revoke all on function public.create_order_web(uuid, text, text, text, jsonb, text)
  from public;
revoke all on function public.create_order_web(uuid, text, text, text, jsonb, text)
  from anon;
revoke all on function public.create_order_web(uuid, text, text, text, jsonb, text)
  from authenticated;

grant execute on function public.create_order_web(uuid, text, text, text, jsonb, text)
  to service_role;
