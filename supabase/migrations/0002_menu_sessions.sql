-- ============================================================================
-- La Fija Orders — Sesiones seguras del menú (0002_menu_sessions)
--
-- NO ejecutar automáticamente. Aplicar manualmente después de 0001_init.sql.
-- Postgres / Supabase.
-- ============================================================================

create table if not exists menu_sessions (
  id                 uuid primary key default gen_random_uuid(),
  source_message_id  text not null unique,
  token_hash         text not null unique,
  customer_phone     text not null,
  phone_number_id    text not null,
  created_at         timestamptz not null default now(),
  expires_at         timestamptz not null default (now() + interval '2 hours'),

  constraint check_source_message_id_not_empty
    check (btrim(source_message_id) <> ''),

  constraint check_token_hash_format
    check (token_hash ~ '^[0-9a-f]{64}$'),

  constraint check_customer_phone_not_empty
    check (btrim(customer_phone) <> ''),

  constraint check_phone_number_id_not_empty
    check (btrim(phone_number_id) <> ''),

  constraint check_expires_after_created
    check (expires_at > created_at)
);

create index if not exists idx_menu_sessions_expires_at
  on menu_sessions (expires_at);

alter table menu_sessions enable row level security;
