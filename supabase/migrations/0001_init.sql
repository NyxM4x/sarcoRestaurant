-- ============================================================================
-- La Fija Orders — Migración inicial (0001_init)
-- Crea el esquema base: menu_items, orders, order_items, webhook_events.
--
-- NO ejecutar automáticamente. Aplicar manualmente en el proyecto Supabase
-- exclusivo de La Fija (ver docs/SETUP.md).
-- Postgres / Supabase.
-- ============================================================================

-- gen_random_uuid()
create extension if not exists "pgcrypto";

-- ── Helpers ──────────────────────────────────────────────────────────────

-- Mantiene updated_at en cada UPDATE.
create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Secuencia segura para el número de pedido (no aleatorio).
create sequence if not exists order_number_seq start with 1 increment by 1;

-- Genera números tipo ORD-000001 desde la BD.
create or replace function next_order_number()
returns text
language sql
volatile
as $$
  select 'ORD-' || lpad(nextval('order_number_seq')::text, 6, '0');
$$;

-- ── menu_items ───────────────────────────────────────────────────────────

create table if not exists menu_items (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique,
  name        text not null,
  category    text not null check (category in ('plato', 'bebida', 'extra')),
  price       numeric(10, 2) not null check (price >= 0),
  is_active   boolean not null default true,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists idx_menu_items_active
  on menu_items (is_active, sort_order);

create trigger trg_menu_items_updated_at
  before update on menu_items
  for each row execute function set_updated_at();

-- ── orders ───────────────────────────────────────────────────────────────

create table if not exists orders (
  id                           uuid primary key default gen_random_uuid(),
  order_number                 text not null unique default next_order_number(),
  customer_phone               text not null,
  customer_name                text,
  delivery_type                text not null check (delivery_type in ('delivery', 'pickup')),
  notes                        text,
  status                       text not null default 'draft'
    check (status in (
      'draft', 'awaiting_location', 'confirmed', 'preparing',
      'ready', 'on_the_way', 'delivered', 'cancelled'
    )),
  subtotal_amount              numeric(10, 2) not null default 0 check (subtotal_amount >= 0),
  delivery_amount              numeric(10, 2) not null default 0 check (delivery_amount >= 0),
  total_amount                 numeric(10, 2) not null default 0 check (total_amount >= 0),
  currency                     text not null default 'BOB',
  flow_token                   text,
  -- Idempotencia: un mensaje entrante confirma un único pedido.
  source_message_id            text unique,
  -- Correlación de ubicación: id del location_request_message saliente.
  location_request_message_id  text unique,
  raw_flow_response            jsonb,
  -- Datos de ubicación (delivery).
  delivery_latitude            double precision,
  delivery_longitude           double precision,
  delivery_address             text,
  delivery_location_name       text,
  created_at                   timestamptz not null default now(),
  updated_at                   timestamptz not null default now(),
  confirmed_at                 timestamptz
);

create index if not exists idx_orders_status         on orders (status);
create index if not exists idx_orders_created_at      on orders (created_at desc);
create index if not exists idx_orders_customer_phone  on orders (customer_phone);

-- Correlación por flow_token único (Kapso genera un UUID por Flow;
-- flow_token = order_{order_session_id}). Un flow_token ⇒ un solo pedido.
-- Parcial (where flow_token is not null) para no chocar con borradores sin token.
create unique index if not exists orders_flow_token_unique
  on public.orders (flow_token)
  where flow_token is not null;

create trigger trg_orders_updated_at
  before update on orders
  for each row execute function set_updated_at();

-- ── order_items ──────────────────────────────────────────────────────────
-- Guarda snapshots de nombre y precio: el detalle histórico no cambia aunque
-- el producto se edite o desactive después.

create table if not exists order_items (
  id                     uuid primary key default gen_random_uuid(),
  order_id               uuid not null references orders (id) on delete cascade,
  -- ON DELETE RESTRICT: no se borran productos usados en pedidos (se desactivan
  -- con is_active). Los snapshots preservan la info aunque el menú cambie.
  menu_item_id           uuid references menu_items (id) on delete restrict,
  product_code           text not null,
  product_name_snapshot  text not null,
  unit_price_snapshot    numeric(10, 2) not null check (unit_price_snapshot >= 0),
  quantity               integer not null check (quantity > 0 and quantity <= 10),
  subtotal               numeric(10, 2) not null check (subtotal >= 0),
  created_at             timestamptz not null default now()
);

create index if not exists idx_order_items_order_id on order_items (order_id);

-- ── webhook_events ───────────────────────────────────────────────────────
-- Idempotencia de webhooks: event_id (X-Idempotency-Key) único evita reprocesar
-- reintentos. Ciclo de estados: processing -> processed | failed.

create table if not exists webhook_events (
  id             uuid primary key default gen_random_uuid(),
  event_id       text unique,
  message_id     text,
  event_name     text,
  payload        jsonb,
  status         text not null default 'processing'
    check (status in ('received', 'processing', 'processed', 'failed')),
  error_message  text,
  processed_at   timestamptz,
  created_at     timestamptz not null default now()
);

create index if not exists idx_webhook_events_message_id on webhook_events (message_id);

-- ── Row Level Security ───────────────────────────────────────────────────
-- RLS habilitado en las 4 tablas SIN políticas públicas (Fase 1).
-- El backend usa SUPABASE_SERVICE_ROLE_KEY, que omite RLS. El acceso anónimo
-- o de cliente queda cerrado por defecto hasta definir políticas más adelante.

alter table menu_items     enable row level security;
alter table orders         enable row level security;
alter table order_items    enable row level security;
alter table webhook_events enable row level security;
