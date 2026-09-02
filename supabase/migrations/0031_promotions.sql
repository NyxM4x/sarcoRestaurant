-- ============================================================================
-- 0031 — Promociones: combos de productos existentes con precio propio
--
-- Un combo es una UNIDAD de venta compuesta por productos del catálogo:
--
--     2× Lomito + 2× Soda Peque + 2× Porción de papa
--     Normal Bs 90 · Promo Bs 60 · Ahorro Bs 30
--
-- No cambia el precio de los productos sueltos ni toca `menu_items`. En el
-- carrito cuenta como UN artículo, no como sus seis componentes.
--
-- ── La regla monetaria vive AQUÍ ────────────────────────────────────────────
--
-- El precio normal NO se guarda: se CALCULA sumando los precios actuales de los
-- componentes. Guardarlo lo convertiría en una copia que envejece — sube el
-- lomito y el combo seguiría anunciando un ahorro que ya no existe.
--
-- Y el ahorro tiene que ser positivo SIEMPRE, no solo al crear: por eso la
-- comprobación es una función que se ejecuta al listar, al añadir al carrito y
-- al confirmar el pedido, y no una bandera escrita una vez.
--
-- ── Por qué el navegador no interviene ──────────────────────────────────────
--
-- El cliente manda un id y una cantidad. Nada más: ni precio, ni componentes,
-- ni ahorro, ni total. Todo eso lo vuelve a leer el servidor de estas tablas
-- dentro de la transacción del pedido, que es el mismo principio que ya
-- gobierna `create_order_web_v3` con los productos sueltos.
--
-- NO ejecutar automáticamente. Aplicar manualmente después de 0030.
-- Postgres / Supabase.
-- ============================================================================

begin;

-- ══ 1. La promoción ═════════════════════════════════════════════════════════

create table if not exists public.promotions (
  id           uuid primary key default gen_random_uuid(),

  name         text not null,
  -- Para el panel. NO sustituye a la composición: lo que el combo incluye se
  -- deriva siempre de `promotion_items`, nunca de un texto escrito a mano que
  -- podría contradecirlo.
  description  text,

  -- El precio del combo. El NORMAL no está aquí a propósito: se calcula.
  promo_price  numeric(10, 2) not null,

  -- Foto propia. Opcional: sin ella se cae al componente protagonista y, si
  -- tampoco, al placeholder.
  image_url    text,

  -- Vigencia. Ambas opcionales: sin fechas el combo se gobierna a mano con
  -- `is_active`. Se guardan en UTC y se PINTAN en la zona del negocio.
  starts_at    timestamptz,
  ends_at      timestamptz,

  -- El interruptor del encargado. Nace APAGADA: una promoción a medio definir
  -- no puede aparecerle a un cliente por haber pulsado guardar.
  is_active    boolean not null default false,

  -- Control de concurrencia optimista. Sube en cada UPDATE (trigger de abajo);
  -- quien guarda con una revisión vieja pisaría cambios que no vio.
  revision     integer not null default 1,

  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint promotions_name_not_empty
    check (btrim(name) <> '' and length(btrim(name)) <= 80),

  constraint promotions_description_length
    check (description is null or length(description) <= 300),

  -- Un precio de cero o negativo no es una promoción, es un error de tecleo.
  constraint promotions_promo_price_positive
    check (promo_price > 0),

  -- La ventana tiene que tener sentido. Con una sola fecha no hay nada que
  -- comparar: "desde el viernes" y "hasta el domingo" son ambas válidas.
  constraint promotions_window_order
    check (starts_at is null or ends_at is null or ends_at > starts_at),

  constraint promotions_revision_positive
    check (revision >= 1)
);

create index if not exists idx_promotions_active
  on public.promotions (is_active, starts_at, ends_at);

drop trigger if exists trg_promotions_updated_at on public.promotions;
create trigger trg_promotions_updated_at
  before update on public.promotions
  for each row execute function public.set_updated_at();

-- ── La revisión sube sola ───────────────────────────────────────────────────
--
-- En el trigger y no en el código de la aplicación: así ninguna escritura puede
-- olvidarse de subirla, venga de donde venga. Sin esto, el control optimista
-- dependería de que cada `update` se acordara, que es justo la clase de
-- disciplina que falla el día que hay prisa.
create or replace function public.bump_promotion_revision()
returns trigger
language plpgsql
as $fn$
begin
  new.revision = old.revision + 1;
  return new;
end;
$fn$;

drop trigger if exists trg_promotions_revision on public.promotions;
create trigger trg_promotions_revision
  before update on public.promotions
  for each row execute function public.bump_promotion_revision();


-- ══ 2. Los componentes ══════════════════════════════════════════════════════

create table if not exists public.promotion_items (
  id           uuid primary key default gen_random_uuid(),

  promotion_id uuid not null
                 references public.promotions (id) on delete cascade,

  -- ON DELETE RESTRICT como en `order_items`: un producto que forma parte de un
  -- combo no se borra del catálogo, se desactiva.
  menu_item_id uuid not null
                 references public.menu_items (id) on delete restrict,

  quantity     integer not null,

  created_at   timestamptz not null default now(),

  constraint promotion_items_quantity_range
    check (quantity >= 1 and quantity <= 20),

  -- Un producto aparece UNA vez por combo. Dos filas del mismo lomito serían
  -- dos verdades sobre la misma cantidad; elegir otra vez el producto actualiza
  -- la que ya hay.
  constraint promotion_items_unique_product
    unique (promotion_id, menu_item_id)
);

create index if not exists idx_promotion_items_promotion
  on public.promotion_items (promotion_id);

create index if not exists idx_promotion_items_menu_item
  on public.promotion_items (menu_item_id);


-- ══ 3. El precio normal, calculado ══════════════════════════════════════════
--
-- La suma de los precios VIGENTES por su cantidad. Es la única definición del
-- precio normal en todo el sistema: el panel la usa para mostrar el ahorro, el
-- menú para tachar la cifra y la RPC del pedido para autorizar el cobro.
--
-- `stable` y no `immutable`: depende de `menu_items`, que cambia. Marcarla
-- immutable dejaría que el planificador cacheara un precio viejo.
--
-- Devuelve 0 para un combo sin componentes, que es lo correcto: no hay nada que
-- sumar. Quien decide si eso es publicable es `promotion_availability`.
create or replace function public.promotion_normal_price(p_promotion_id uuid)
returns numeric
language sql
stable
as $fn$
  select coalesce(sum(m.price * pi.quantity), 0)
    from public.promotion_items pi
    join public.menu_items m on m.id = pi.menu_item_id
   where pi.promotion_id = p_promotion_id;
$fn$;


-- ══ 4. ¿Se puede vender ahora mismo? ════════════════════════════════════════
--
-- UNA función que responde por qué sí o por qué no, y que usan por igual el
-- panel, el menú y el checkout. Tener tres criterios distintos en tres sitios
-- es exactamente cómo se acaba vendiendo un combo vencido.
--
-- El orden de las comprobaciones es el orden en que se le explican a una
-- persona: primero si hay algo que vender, luego si el negocio quiere venderlo,
-- luego si toca, y por último si sale a cuenta.
create or replace function public.promotion_availability(
  p_promotion_id uuid,
  p_at timestamptz default now()
)
returns table (
  status        text,
  normal_price  numeric,
  promo_price   numeric,
  savings       numeric
)
language plpgsql
stable
as $fn$
declare
  v_promo    record;
  v_normal   numeric;
  v_units    integer;
  v_inactive integer;
begin
  select p.id, p.promo_price, p.is_active, p.starts_at, p.ends_at
    into v_promo
    from public.promotions p
   where p.id = p_promotion_id;

  if not found then
    return query select 'not_found'::text, 0::numeric, 0::numeric, 0::numeric;
    return;
  end if;

  v_normal := public.promotion_normal_price(p_promotion_id);

  -- Composición mínima: al menos DOS unidades en total. Un "combo" de una
  -- unidad no es un combo, es el producto con otro precio — y para eso ya está
  -- el precio del producto.
  --
  -- Dos unidades del MISMO producto valen: "2 lomitos goleadores" es un combo
  -- legítimo. Lo que no vale es una sola cosa.
  select coalesce(sum(pi.quantity), 0),
         count(*) filter (where m.is_active = false)
    into v_units, v_inactive
    from public.promotion_items pi
    join public.menu_items m on m.id = pi.menu_item_id
   where pi.promotion_id = p_promotion_id;

  if v_units < 2 then
    return query select 'incomplete'::text, v_normal, v_promo.promo_price, 0::numeric;
    return;
  end if;

  -- Un componente retirado del catálogo tumba el combo entero: no se puede
  -- entregar media promoción. Si el producto vuelve, el combo revive solo — sin
  -- recrearlo, porque nada se marcó de forma permanente.
  if v_inactive > 0 then
    return query select 'component_unavailable'::text, v_normal, v_promo.promo_price,
                        greatest(v_normal - v_promo.promo_price, 0);
    return;
  end if;

  if not v_promo.is_active then
    return query select 'disabled'::text, v_normal, v_promo.promo_price,
                        greatest(v_normal - v_promo.promo_price, 0);
    return;
  end if;

  if v_promo.starts_at is not null and p_at < v_promo.starts_at then
    return query select 'scheduled'::text, v_normal, v_promo.promo_price,
                        greatest(v_normal - v_promo.promo_price, 0);
    return;
  end if;

  if v_promo.ends_at is not null and p_at >= v_promo.ends_at then
    return query select 'expired'::text, v_normal, v_promo.promo_price,
                        greatest(v_normal - v_promo.promo_price, 0);
    return;
  end if;

  -- La última, y la que no se puede saltar: si subió el precio de un componente
  -- hasta comerse el descuento, esto YA no es una promoción. No se muestra un
  -- ahorro negativo ni se deja comprar: se dice que no hay ahorro.
  if v_promo.promo_price >= v_normal then
    return query select 'no_savings'::text, v_normal, v_promo.promo_price, 0::numeric;
    return;
  end if;

  return query select 'available'::text, v_normal, v_promo.promo_price,
                      v_normal - v_promo.promo_price;
end;
$fn$;


-- ══ 5. El pedido se lleva una copia congelada ═══════════════════════════════
--
-- Mismo principio que los snapshots de `order_items`: lo vendido no cambia
-- porque el catálogo cambie después. Un combo editado en octubre no puede
-- reescribir lo que alguien compró en septiembre.
create table if not exists public.order_promotions (
  id                    uuid primary key default gen_random_uuid(),

  order_id              uuid not null
                          references public.orders (id) on delete cascade,

  -- ON DELETE SET NULL: si algún día se borra la promoción, la línea del pedido
  -- sobrevive con su snapshot. El histórico no depende del catálogo.
  promotion_id          uuid references public.promotions (id) on delete set null,

  name_snapshot         text not null,
  -- Las DOS cifras, congeladas: lo que se cobró y lo que habría costado suelto.
  -- Sin la segunda no se puede reconstruir el ahorro que se le prometió.
  promo_price_snapshot  numeric(10, 2) not null,
  normal_price_snapshot numeric(10, 2) not null,

  quantity              integer not null,
  subtotal              numeric(10, 2) not null,

  -- La composición tal cual se vendió: [{code, name, unit_price, quantity}].
  -- En JSON y no en filas porque es un documento histórico que se lee entero y
  -- no se consulta por partes.
  components_snapshot   jsonb not null,

  created_at            timestamptz not null default now(),

  constraint order_promotions_quantity_positive
    check (quantity >= 1 and quantity <= 10),
  constraint order_promotions_amounts_non_negative
    check (promo_price_snapshot >= 0 and normal_price_snapshot >= 0 and subtotal >= 0),
  -- El snapshot tiene que probar que hubo ahorro. Una línea histórica que diga
  -- lo contrario sería la evidencia de un cobro que esta migración prohíbe.
  constraint order_promotions_had_savings
    check (promo_price_snapshot < normal_price_snapshot),
  constraint order_promotions_components_is_array
    check (jsonb_typeof(components_snapshot) = 'array')
);

create index if not exists idx_order_promotions_order
  on public.order_promotions (order_id);


-- ══ 6. Permisos ═════════════════════════════════════════════════════════════
--
-- RLS encendido y SIN políticas públicas, igual que el resto del esquema: el
-- backend entra con `service_role`, que las omite, y nadie más tiene puerta.
--
-- El `revoke` previo es necesario porque Supabase concede por defecto a los
-- roles de API sobre las tablas nuevas; sin él, un GRANT más estrecho no
-- restringiría nada.
alter table public.promotions       enable row level security;
alter table public.promotion_items  enable row level security;
alter table public.order_promotions enable row level security;

revoke all on table public.promotions       from public;
revoke all on table public.promotions       from anon;
revoke all on table public.promotions       from authenticated;
revoke all on table public.promotion_items  from public;
revoke all on table public.promotion_items  from anon;
revoke all on table public.promotion_items  from authenticated;
revoke all on table public.order_promotions from public;
revoke all on table public.order_promotions from anon;
revoke all on table public.order_promotions from authenticated;

-- El servidor administra el catálogo de promociones: crea, edita y enciende.
grant select, insert, update, delete on table public.promotions      to service_role;
grant select, insert, update, delete on table public.promotion_items to service_role;

-- Las líneas de un pedido NO se editan ni se borran nunca: son el histórico.
-- Mismo criterio que `agent_control_events`, donde el permiso refuerza la
-- intención en vez de confiar en que nadie escriba el UPDATE.
revoke all on table public.order_promotions from service_role;
grant select, insert on table public.order_promotions to service_role;

commit;
