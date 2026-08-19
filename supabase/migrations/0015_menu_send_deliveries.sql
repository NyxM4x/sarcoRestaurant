-- ============================================================================
-- La Fija Orders — Ledger de envíos del menú (0015_menu_send_deliveries)
--
-- Una sola tabla. CERO cambios sobre tablas existentes (menu_sessions,
-- agent_* y el resto quedan intactas). Sin seed y sin backfill.
--
-- Por qué existe
-- -------------
-- Hasta ahora el CTA del menú se enviaba directamente desde el webhook: la
-- única idempotencia era que el mismo `source_message_id` producía el mismo
-- token, así que un reintento reenviaba el MISMO enlace... pero lo reenviaba.
-- Con `send_menu()` a la vista, el envío pasa a tener dos puertas —la ruta
-- determinística y, en 6D.2F.5B, el agente— y ninguna puede fiarse de la otra.
--
-- Esta tabla es la AUTORIDAD del efecto: se reclama la fila ANTES de llamar a
-- Kapso, y solo quien gana el claim puede enviar.
--
-- Dos protecciones distintas que conviene no confundir:
--
--  1. IDEMPOTENCIA TÉCNICA — `source_message_id` UNIQUE. El mismo WAMID
--     entrante jamás produce dos CTAs, pase lo que pase después.
--  2. ANTI-REPEAT DE EXPERIENCIA — un WAMID NUEVO sí puede producir un CTA
--     nuevo. El cooldown es política (TypeScript), no un CHECK: un cliente que
--     vuelve a pedir el menú porque no le cargó tiene derecho a recibirlo.
--
-- El token de la sesión y la URL del menú NO se guardan aquí. Ni el hash. La
-- fila dice QUÉ pasó, nunca CÓMO entrar al menú de nadie.
--
-- NO ejecutar automáticamente. Aplicar manualmente después de 0001 + … + 0014.
-- Postgres / Supabase.
-- ============================================================================

create table if not exists public.menu_send_deliveries (
  id                  uuid        primary key default gen_random_uuid(),

  -- Identidad durable del cliente: dígitos normalizados, igual que en
  -- `agent_conversations`. Es la clave por la que se calcula el cooldown.
  customer_phone      text        not null,

  -- WAMID REAL del mensaje entrante que originó el envío. Nunca un id
  -- inventado: si no hay WAMID no hay claim, y sin claim no se envía.
  source_message_id   text        not null,

  -- Quién pidió el menú y con qué autoridad. Lo determina el BACKEND a partir
  -- del turno, nunca el modelo: ver `menu/policy.ts`.
  reason              text        not null,

  status              text        not null default 'pending',

  -- WAMID del CTA saliente, cuando Kapso lo confirma.
  provider_message_id text,

  error_code          text,

  claimed_at          timestamptz not null default now(),
  completed_at        timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  -- ── Idempotencia técnica ──────────────────────────────────────────────────
  constraint menu_send_deliveries_source_message_id_unique
    unique (source_message_id),

  constraint menu_send_deliveries_source_message_id_not_empty
    check (btrim(source_message_id) <> ''),

  constraint menu_send_deliveries_customer_phone_not_empty
    check (btrim(customer_phone) <> ''),

  -- ── Dominios ──────────────────────────────────────────────────────────────
  constraint menu_send_deliveries_status_check check (status in (
    'pending', 'sent', 'failed', 'send_unknown', 'blocked_recent'
  )),

  -- `qa_trigger` es TESTMENU9842. `agent_suggestion` es el único motivo sujeto
  -- a cooldown, y el único que podrá originar `send_menu()` en 6D.2F.5B.
  constraint menu_send_deliveries_reason_check check (reason in (
    'explicit_request', 'explicit_resend', 'agent_suggestion', 'qa_trigger'
  )),

  constraint menu_send_deliveries_provider_message_id_not_empty
    check (provider_message_id is null or btrim(provider_message_id) <> ''),

  -- Mismo formato que `agent_runs.error_code`: cabe en un log y nunca arrastra
  -- el cuerpo de una respuesta ni un secreto.
  constraint menu_send_deliveries_error_code_format check (
    error_code is null or error_code ~ '^[A-Za-z0-9._:-]{1,64}$'
  ),

  constraint menu_send_deliveries_completed_after_claimed check (
    completed_at is null or completed_at >= claimed_at
  ),

  -- ── Coherencia de estados ─────────────────────────────────────────────────
  -- Misma filosofía que `agent_runs`: el estado EN CURSO es estricto porque
  -- todavía controlamos el proceso; los TERMINALES exigen solo lo indispensable
  -- para que cerrar una fila nunca falle. Un CHECK que impidiera CERRAR dejaría
  -- la fila en 'pending' y una recuperación futura podría reenviar el CTA —
  -- exactamente el fallo que esta tabla existe para evitar.
  constraint menu_send_deliveries_state_coherence check (
    (
      status = 'pending'
      and completed_at        is null
      and provider_message_id is null
      and error_code          is null
    )
    or (
      -- Consta que salió: hay WAMID del proveedor.
      status = 'sent'
      and completed_at        is not null
      and provider_message_id is not null
      and error_code          is null
    )
    or (
      -- Consta que NO salió: rechazo determinístico del proveedor.
      status = 'failed'
      and completed_at        is not null
      and provider_message_id is null
      and error_code          is not null
    )
    or (
      -- Pudo salir. Nunca se reenvía a ciegas.
      status = 'send_unknown'
      and completed_at is not null
      and error_code   is not null
    )
    or (
      -- La política dijo que no: es una decisión, no un fallo.
      status = 'blocked_recent'
      and completed_at        is not null
      and provider_message_id is null
      and error_code          is null
    )
  )
);

-- ── Índices ─────────────────────────────────────────────────────────────────

-- Cooldown y observabilidad: "¿cuándo se le mandó el menú a este teléfono?".
-- Parcial sobre 'sent' a propósito: un envío que no salió no gasta cooldown.
create index if not exists ix_menu_send_deliveries_recent
  on public.menu_send_deliveries (customer_phone, completed_at desc)
  where status = 'sent';

-- ── updated_at automático (trigger genérico de 0001; NO se redefine) ────────

drop trigger if exists trg_menu_send_deliveries_updated_at on public.menu_send_deliveries;
create trigger trg_menu_send_deliveries_updated_at
  before update on public.menu_send_deliveries
  for each row execute function public.set_updated_at();

-- ── RLS ─────────────────────────────────────────────────────────────────────
-- Sin políticas: nadie llega por PostgREST. El backend usa `service_role`, que
-- las omite por diseño.

alter table public.menu_send_deliveries enable row level security;

-- ── Privilegios ─────────────────────────────────────────────────────────────
-- Mismo criterio que 0014: revoke explícito antes del grant, porque los roles
-- de Supabase traen privilegios por defecto sobre tablas nuevas.

revoke all on table public.menu_send_deliveries from public;
revoke all on table public.menu_send_deliveries from anon;
revoke all on table public.menu_send_deliveries from authenticated;
revoke all on table public.menu_send_deliveries from service_role;
grant select, insert, update on table public.menu_send_deliveries to service_role;
