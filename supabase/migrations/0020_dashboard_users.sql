-- ============================================================================
-- 0020 — Usuarios del acceso interno (panel y cocina)
--
-- Sustituye las contraseñas COMPARTIDAS por variables de entorno
-- (DASHBOARD_PASSWORD / KITCHEN_PASSWORD) por usuarios individuales con rol.
--
-- Cada persona tiene su propio usuario, y el ROL guardado aquí decide a qué
-- pantalla entra: `admin` al panel del encargado (/dashboard) y `kitchen` al
-- tablero de cocina (/cocina). Así se puede dar de baja el acceso de una sola
-- persona sin rotar la contraseña de todo el restaurante.
--
-- La contraseña NUNCA se guarda en claro: se almacena el hash bcrypt (coste 12)
-- que produce `src/lib/security/password.ts`. La columna se llama
-- `password_hash` a propósito, para que quede claro en cualquier consulta
-- manual que ahí no va texto plano.
--
-- El rol vive en la BASE, no en la cookie: la cookie solo transporta el rol ya
-- probado, firmado con HMAC (ver src/lib/dashboard/session-token.ts).
--
-- NO ejecutar automáticamente. Aplicar manualmente en el proyecto Supabase
-- (ver docs/SETUP.md). Postgres / Supabase.
-- ============================================================================

create table if not exists dashboard_users (
  id            uuid primary key default gen_random_uuid(),
  username      text not null,
  -- Hash bcrypt, nunca la contraseña en claro.
  password_hash text not null,
  role          text not null check (role in ('admin', 'kitchen')),
  -- Baja lógica: desactivar en vez de borrar conserva el historial del alta.
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Username único SIN distinguir mayúsculas: evita dar de alta "Juan" y "juan"
-- como dos personas distintas, y sostiene el login case-insensitive.
create unique index if not exists dashboard_users_username_lower_key
  on dashboard_users (lower(username));

-- Mantiene updated_at en cada UPDATE (función creada en 0001_init).
drop trigger if exists trg_dashboard_users_updated_at on public.dashboard_users;
create trigger trg_dashboard_users_updated_at
  before update on dashboard_users
  for each row execute function set_updated_at();

-- ── Row Level Security ───────────────────────────────────────────────────
-- RLS habilitado SIN políticas públicas, igual que el resto de tablas
-- internas. El backend usa SUPABASE_SERVICE_ROLE_KEY, que omite RLS; el acceso
-- anónimo con la anon key no puede leer ni un solo hash.
alter table dashboard_users enable row level security;
