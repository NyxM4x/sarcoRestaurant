-- ============================================================================
-- 0032 — create_order_web_v4: el pedido puede llevar promociones
--
-- Copia de `create_order_web_v3` (0009) con UN añadido: `p_promotions_json`.
-- v3 y las anteriores quedan INTACTAS, igual que hizo 0009 con v2 — así el
-- despliegue no tiene un instante en el que el código viejo llame a una función
-- que ya cambió de forma.
--
-- ── Por qué el precio del combo se vuelve a calcular aquí ───────────────────
--
-- El navegador manda `{promotion_id, quantity}` y NADA más: ni el precio, ni el
-- ahorro, ni los componentes. Todo eso se relee de `promotions` y
-- `promotion_items` DENTRO de esta transacción, con la fila bloqueada.
--
-- No es desconfianza del navegador: es que entre que el cliente vio la tarjeta
-- y pulsó confirmar pueden haber pasado veinte minutos, y en ese rato el
-- encargado pudo apagar la promoción, subir el precio de un componente o
-- agotarlo. Quien decide es el estado en el instante del INSERT, no el que
-- había cuando se pintó la pantalla.
--
-- ── Qué NO entra en order_items ─────────────────────────────────────────────
--
-- Los componentes del combo no se insertan como líneas sueltas: se congelan en
-- `order_promotions.components_snapshot`. Si fueran a `order_items`, el mismo
-- lomito aparecería dos veces al sumar —una por la línea y otra por el combo— y
-- el subtotal saldría el doble.
--
-- NO ejecutar automáticamente. Aplicar manualmente después de 0031.
-- Postgres / Supabase.
-- ============================================================================

begin;

create or replace function public.create_order_web_v4(
  p_menu_session_id uuid,
  p_customer_name text,
  p_delivery_type text,
  p_notes text,
  p_items_json jsonb,
  p_checkout_fingerprint text,
  p_payment_method text,
  -- Default para que un carrito sin combos llame igual que a v3.
  p_promotions_json jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $fn$
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
  v_promo_subtotal numeric;
  v_total numeric;
  v_line_count int;
  v_promo_count int;
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
  v_promo record;
  v_promo_row record;
  v_avail record;
  v_components jsonb;
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

  if p_payment_method is null or p_payment_method not in ('cash', 'qr') then
    raise exception 'payment_method must be cash or qr' using errcode = '22023';
  end if;

  -- VALIDACIÓN 2: items es un array de 0 a 20 líneas.
  --
  -- CAMBIO respecto a v3: ahora se admite el array VACÍO, porque un carrito de
  -- solo promociones es legítimo. Que el pedido tenga algo dentro se comprueba
  -- más abajo, contando líneas y combos juntos.
  if p_items_json is null or jsonb_typeof(p_items_json) <> 'array' then
    raise exception 'items must be a json array' using errcode = '22023';
  end if;

  v_line_count := jsonb_array_length(p_items_json);

  if v_line_count > 20 then
    raise exception 'items must have 0-20 elements' using errcode = '22023';
  end if;

  -- VALIDACIÓN 2b: promociones es un array de 0 a 5 líneas.
  if p_promotions_json is null or jsonb_typeof(p_promotions_json) <> 'array' then
    raise exception 'promotions must be a json array' using errcode = '22023';
  end if;

  v_promo_count := jsonb_array_length(p_promotions_json);

  if v_promo_count > 5 then
    raise exception 'promotions must have 0-5 elements' using errcode = '22023';
  end if;

  if v_line_count = 0 and v_promo_count = 0 then
    raise exception 'order must have at least one item' using errcode = '22023';
  end if;

  -- VALIDACIÓN 3: customer_name normalizado.
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

  -- VALIDACIÓN 5: notes normalizadas.
  v_notes_clean := nullif(btrim(p_notes), '');

  if v_notes_clean is not null and length(v_notes_clean) > 500 then
    raise exception 'notes must be max 500 characters' using errcode = '22023';
  end if;

  -- VALIDACIÓN 6: checkout_fingerprint es SHA-256 hexadecimal.
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

  -- VALIDACIÓN 7b: Estructura de cada promoción del carrito.
  --
  -- `revision` es OPCIONAL y actúa de testigo: si viene y ya no coincide, la
  -- promoción cambió mientras el cliente miraba la pantalla y no se cobra la
  -- versión que él creía. Si no viene, se valida igual todo lo demás — el
  -- testigo evita una sorpresa, no sustituye a ninguna comprobación.
  for v_element in
    select value
    from jsonb_array_elements(p_promotions_json) as t(value)
  loop
    if jsonb_typeof(v_element.value) <> 'object' then
      raise exception 'each promotion must be a json object' using errcode = '22023';
    end if;

    if jsonb_typeof(v_element.value -> 'promotion_id') is distinct from 'string' then
      raise exception 'each promotion requires a string promotion_id' using errcode = '22023';
    end if;

    if (v_element.value ->> 'promotion_id') !~
       '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'promotion_id must be a uuid' using errcode = '22023';
    end if;

    if jsonb_typeof(v_element.value -> 'quantity') is distinct from 'number' then
      raise exception 'each promotion requires a numeric quantity' using errcode = '22023';
    end if;

    v_quantity_num := (v_element.value ->> 'quantity')::numeric;

    if v_quantity_num is null or v_quantity_num <> trunc(v_quantity_num) then
      raise exception 'promotion quantity must be an integer' using errcode = '22023';
    end if;

    if v_quantity_num < 1 or v_quantity_num > 10 then
      raise exception 'promotion quantity must be 1-10' using errcode = '22023';
    end if;

    if v_element.value ? 'revision'
       and jsonb_typeof(v_element.value -> 'revision') is distinct from 'number' then
      raise exception 'promotion revision must be numeric' using errcode = '22023';
    end if;
  end loop;

  -- VALIDACIÓN 8: Códigos sin duplicados.
  select count(*), count(distinct btrim(item ->> 'code'))
  into v_code_count, v_unique_codes
  from jsonb_array_elements(p_items_json) as item;

  if v_code_count <> v_unique_codes then
    raise exception 'duplicate product codes' using errcode = '22023';
  end if;

  -- VALIDACIÓN 8b: Promociones sin duplicados. Dos líneas del mismo combo
  -- serían dos verdades sobre la misma cantidad; el carrito manda una sola.
  select count(*), count(distinct (promo ->> 'promotion_id'))
  into v_code_count, v_unique_codes
  from jsonb_array_elements(p_promotions_json) as promo;

  if v_code_count <> v_unique_codes then
    raise exception 'duplicate promotion ids' using errcode = '22023';
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

  if v_session.expires_at <= now() then
    raise exception 'session expired' using errcode = 'P1001';
  end if;

  v_customer_phone := v_session.customer_phone;

  -- BÚSQUEDA: Pedido existente para esta sesión.
  select
    id, order_number, customer_name, delivery_type, status,
    subtotal_amount, delivery_amount, total_amount, payment_method,
    delivery_pricing, delivery_quote_status, delivery_distance_meters,
    checkout_fingerprint, created_at
  into v_existing_order
  from public.orders
  where menu_session_id = p_menu_session_id
  limit 1;

  -- REINTENTO vs. REUTILIZACIÓN DE SESIÓN.
  --
  -- La huella la calcula el servidor sobre el carrito COMPLETO —líneas y
  -- combos—, así que un reintento con los mismos combos coincide y uno con
  -- combos distintos no. Ver `calculateCheckoutFingerprint`.
  if found then
    if v_existing_order.checkout_fingerprint is distinct from p_checkout_fingerprint then
      raise exception 'session already used with a different cart' using errcode = 'P1003';
    end if;

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

  -- BLOQUEO 2: Productos sueltos con FOR SHARE, en orden determinista.
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

  -- CÁLCULO 1: Subtotal de los productos sueltos, desde menu_items.
  select coalesce(sum(((item ->> 'quantity')::integer) * m.price), 0)
  into v_subtotal
  from jsonb_array_elements(p_items_json) as item
  join public.menu_items m
    on m.code = btrim(item ->> 'code')
   and m.is_active = true;

  -- ══ BLOQUEO 3 y CÁLCULO 2: las promociones ════════════════════════════════
  --
  -- Aquí está toda la autoridad del servidor sobre los combos. Por cada uno:
  -- se bloquea la fila, se comprueba que siga siendo vendible AHORA, y el
  -- precio que se cobra sale de la base — nunca del request.
  --
  -- El orden por id es determinista para que dos pedidos simultáneos con los
  -- mismos combos tomen los bloqueos en el mismo orden y no se abracen.
  v_promo_subtotal := 0;

  for v_promo in
    select (t.value ->> 'promotion_id')::uuid as promotion_id,
           (t.value ->> 'quantity')::integer as quantity,
           case when t.value ? 'revision'
                then (t.value ->> 'revision')::integer
                else null end as revision
    from jsonb_array_elements(p_promotions_json) as t(value)
    order by (t.value ->> 'promotion_id')::uuid asc
  loop
    -- FOR SHARE: nadie puede apagar ni reprecificar la promoción entre esta
    -- lectura y el COMMIT. Es la carrera "desactivar mientras confirma".
    select p.id, p.name, p.promo_price, p.revision
    into v_promo_row
    from public.promotions p
    where p.id = v_promo.promotion_id
    for share;

    if not found then
      raise exception 'promotion_rejected:not_found:%', v_promo.promotion_id
        using errcode = 'P1004';
    end if;

    -- El testigo de concurrencia. Va ANTES de la disponibilidad: si el combo
    -- cambió, lo que hay que decirle al cliente es que cambió, no el detalle
    -- de una versión que ya no está mirando.
    if v_promo.revision is not null and v_promo.revision <> v_promo_row.revision then
      raise exception 'promotion_rejected:stale_revision:%', v_promo.promotion_id
        using errcode = 'P1004';
    end if;

    -- Bloqueo de los componentes: cierra la carrera "agotar mientras confirma".
    -- Sin esto, alguien podría desactivar el lomito justo entre la comprobación
    -- y el INSERT, y el pedido entraría con un combo imposible de preparar.
    perform 1
    from public.promotion_items pi
    join public.menu_items m on m.id = pi.menu_item_id
    where pi.promotion_id = v_promo.promotion_id
    order by m.code asc
    for share of m;

    -- La MISMA función que usan el panel y el menú. Un criterio distinto aquí
    -- sería la forma de vender un combo vencido sin que nadie se entere.
    select a.status, a.normal_price, a.promo_price, a.savings
    into v_avail
    from public.promotion_availability(v_promo.promotion_id, now()) as a;

    if v_avail.status <> 'available' then
      raise exception 'promotion_rejected:%:%', v_avail.status, v_promo.promotion_id
        using errcode = 'P1004';
    end if;

    -- Defensa final y redundante sobre la regla monetaria. `promotion_
    -- availability` ya la comprueba; se repite aquí porque es la línea que
    -- decide cuánto se cobra, y una condición que gobierna dinero se verifica
    -- justo antes de escribirla.
    if v_avail.promo_price >= v_avail.normal_price then
      raise exception 'promotion_rejected:price_not_below_normal:%', v_promo.promotion_id
        using errcode = 'P1004';
    end if;

    v_promo_subtotal := v_promo_subtotal + (v_avail.promo_price * v_promo.quantity);
  end loop;

  v_subtotal := v_subtotal + v_promo_subtotal;

  if v_subtotal <= 0 then
    raise exception 'order total must be positive' using errcode = '22023';
  end if;

  v_total := v_subtotal;

  -- ESTADO INICIAL según delivery_type.
  if p_delivery_type = 'pickup' then
    v_initial_status := 'confirmed';
    v_confirmed_at := now();
  else
    v_initial_status := 'awaiting_location';
    v_confirmed_at := null;
  end if;

  -- El SERVIDOR deriva el modo de pricing (el cliente no lo envía).
  if p_delivery_type = 'delivery' then
    v_delivery_pricing := 'dynamic';
    v_delivery_quote_status := 'pending';
  else
    v_delivery_pricing := null;
    v_delivery_quote_status := null;
  end if;

  -- INSERCIÓN 1: public.orders.
  insert into public.orders (
    menu_session_id, checkout_fingerprint, customer_phone, customer_name,
    delivery_type, notes, status, subtotal_amount, delivery_amount,
    total_amount, payment_method, delivery_pricing, delivery_quote_status,
    confirmed_at, flow_token, source_message_id, raw_flow_response,
    location_request_message_id
  ) values (
    p_menu_session_id, p_checkout_fingerprint, v_customer_phone,
    v_customer_name_clean, p_delivery_type, v_notes_clean, v_initial_status,
    v_subtotal, 0, v_total, p_payment_method, v_delivery_pricing,
    v_delivery_quote_status, v_confirmed_at, null, null, null, null
  )
  returning id, order_number
  into v_order_id, v_order_number;

  -- INSERCIÓN 2: public.order_items (snapshots de los productos sueltos).
  insert into public.order_items (
    order_id, menu_item_id, product_code, product_name_snapshot,
    unit_price_snapshot, quantity, subtotal
  )
  select
    v_order_id, m.id, m.code, m.name, m.price,
    (item ->> 'quantity')::integer,
    m.price * ((item ->> 'quantity')::integer)
  from jsonb_array_elements(p_items_json) as item
  join public.menu_items m
    on m.code = btrim(item ->> 'code')
   and m.is_active = true;

  -- INSERCIÓN 3: public.order_promotions (el combo, congelado).
  --
  -- Se recorre otra vez en vez de acumular durante el cálculo porque las filas
  -- ya están bloqueadas y nada pudo cambiar: el segundo recorrido lee lo mismo
  -- que el primero, y a cambio el bloque de cálculo se queda con una sola
  -- responsabilidad.
  for v_promo in
    select (t.value ->> 'promotion_id')::uuid as promotion_id,
           (t.value ->> 'quantity')::integer as quantity
    from jsonb_array_elements(p_promotions_json) as t(value)
  loop
    select a.normal_price, a.promo_price
    into v_avail
    from public.promotion_availability(v_promo.promotion_id, now()) as a;

    select p.name into v_promo_row
    from public.promotions p where p.id = v_promo.promotion_id;

    -- La composición TAL COMO SE VENDIÓ. Con nombre y precio unitario dentro:
    -- sin ellos, reconstruir el combo de un pedido de hace un mes exigiría que
    -- el catálogo no hubiera cambiado, que es justo lo que no se puede asumir.
    select coalesce(
             jsonb_agg(
               jsonb_build_object(
                 'code', m.code,
                 'name', m.name,
                 'unit_price', m.price,
                 'quantity', pi.quantity
               )
               order by m.sort_order, m.code
             ),
             '[]'::jsonb
           )
    into v_components
    from public.promotion_items pi
    join public.menu_items m on m.id = pi.menu_item_id
    where pi.promotion_id = v_promo.promotion_id;

    insert into public.order_promotions (
      order_id, promotion_id, name_snapshot, promo_price_snapshot,
      normal_price_snapshot, quantity, subtotal, components_snapshot
    ) values (
      v_order_id,
      v_promo.promotion_id,
      v_promo_row.name,
      v_avail.promo_price,
      v_avail.normal_price,
      v_promo.quantity,
      v_avail.promo_price * v_promo.quantity,
      v_components
    );
  end loop;

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
$fn$;

-- ── Permisos ────────────────────────────────────────────────────────────────
--
-- Solo el backend. `anon` y `authenticated` quedan fuera: quien crea pedidos es
-- el servidor con `service_role`, igual que con v3.
revoke all on function public.create_order_web_v4(
  uuid, text, text, text, jsonb, text, text, jsonb
) from public;
revoke all on function public.create_order_web_v4(
  uuid, text, text, text, jsonb, text, text, jsonb
) from anon;
revoke all on function public.create_order_web_v4(
  uuid, text, text, text, jsonb, text, text, jsonb
) from authenticated;
grant execute on function public.create_order_web_v4(
  uuid, text, text, text, jsonb, text, text, jsonb
) to service_role;

commit;
