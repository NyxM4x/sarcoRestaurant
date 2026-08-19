-- ============================================================================
-- La Fija Orders — webhook_events como INBOX DURABLE (0016)
--
-- Migración ADITIVA sobre una tabla que ya existe desde 0001. No crea tablas,
-- no toca el CHECK de `status`, no hace backfill y no borra nada.
--
-- Por qué
-- -------
-- Kapso exige ACK 200 en menos de 10 s. En Production, un turno del agente con
-- herramienta tarda 11–12 s: dos llamadas a OpenAI más el envío. El webhook ya
-- no puede procesar en línea antes de responder.
--
-- La copia durable del trabajo YA se escribía: `payload jsonb` guarda el evento
-- entero y `event_id` (el X-Idempotency-Key) es UNIQUE desde 0001. Lo que
-- faltaba era poder responder ANTES de procesar y saber volver a lo que quedó
-- a medias. Eso es lo que añade esta migración.
--
-- Los cuatro estados YA están en el CHECK de 0001 y no se tocan. Lo que cambia
-- es su USO:
--
--   received    pendiente, o reintento programado (`next_attempt_at`)
--   processing  reclamado; el LEASE dice hasta cuándo se le da por vivo
--   processed   terminal, con éxito
--   failed      terminal, tras AGOTAR los intentos
--
-- Un fallo transitorio con intentos disponibles NO va a `failed`: vuelve a
-- `received` con su próximo intento agendado. `failed` significa "ya no se
-- intenta más", no "falló una vez".
--
-- El LEASE en vez de una heurística de antigüedad
-- -----------------------------------------------
-- Al reclamar se fija `next_attempt_at = now() + lease`. Si la invocación muere
-- a mitad, la fila vence sola y vuelve a estar disponible. No hay que decidir
-- cuánto es "demasiado tiempo en processing": un `processing` vencido ES
-- trabajo abandonado, por definición. `updated_at` queda para diagnóstico, no
-- como prueba de abandono.
--
-- NO ejecutar automáticamente. Aplicar manualmente después de 0001 + … + 0015.
-- Postgres / Supabase.
--
-- Toda la migración se aplica de forma atómica: begin; ... commit;.
-- ============================================================================

begin;

-- ── 1. Columnas ─────────────────────────────────────────────────────────────
-- `updated_at` nace con `now()` para las filas históricas: no es su instante
-- real de modificación, pero cualquier valor es mejor que un NULL que obligue a
-- tratar el caso en todas las consultas. Solo se usa para diagnóstico.
--
-- `next_attempt_at` nace NULL a propósito: las filas históricas quedan
-- INVISIBLES para el worker, que es exactamente lo que se quiere. Ninguna
-- entrega vieja se va a reprocesar por aplicar esta migración.

alter table public.webhook_events
  add column if not exists attempts        integer     not null default 0,
  add column if not exists max_attempts    integer     not null default 5,
  add column if not exists updated_at      timestamptz not null default now(),
  add column if not exists next_attempt_at timestamptz;


-- ── 2. Invariantes ──────────────────────────────────────────────────────────

alter table public.webhook_events
  drop constraint if exists webhook_events_attempts_check;
alter table public.webhook_events
  add constraint webhook_events_attempts_check check (attempts >= 0);

alter table public.webhook_events
  drop constraint if exists webhook_events_max_attempts_check;
alter table public.webhook_events
  add constraint webhook_events_max_attempts_check
  check (max_attempts between 1 and 10);

-- Un TERMINAL no puede quedar agendado. Sin esto, una fila `processed` con
-- `next_attempt_at` poblado la seleccionaría el worker para siempre.
alter table public.webhook_events
  drop constraint if exists webhook_events_terminal_not_scheduled;
alter table public.webhook_events
  add constraint webhook_events_terminal_not_scheduled check (
    status in ('received', 'processing') or next_attempt_at is null
  );


-- ── 3. Índice del trabajo reclamable ────────────────────────────────────────
-- PARCIAL a propósito. `webhook_events` crece con CADA evento de Kapso,
-- incluidos delivered y read, y la inmensa mayoría acaba en `processed` con
-- `next_attempt_at = null`: fuera del índice. El índice solo contiene lo que
-- está pendiente de verdad, así que se mantiene pequeño para siempre.

create index if not exists ix_webhook_events_claimable
  on public.webhook_events (next_attempt_at)
  where next_attempt_at is not null
    and status in ('received', 'processing');


-- ── 4. updated_at automático ────────────────────────────────────────────────
-- Reutiliza la función genérica de 0001, igual que orders, order_notifications,
-- agent_conversations, agent_runs y menu_send_deliveries. NO se redefine.
--
-- Va por trigger y no a mano en cada UPDATE porque las transiciones están
-- repartidas entre el accept, el fast path, el worker y el recovery: una sola
-- que se olvide de tocarlo dejaría un diagnóstico mentiroso.

drop trigger if exists trg_webhook_events_updated_at on public.webhook_events;
create trigger trg_webhook_events_updated_at
  before update on public.webhook_events
  for each row execute function public.set_updated_at();


-- ── 5. Reclamo atómico ──────────────────────────────────────────────────────
--
-- Dos funciones porque hay dos formas de llegar a una fila, y las dos tienen
-- que ser atómicas:
--
--   por ID       el fast path: `after()` o el modo inline saben cuál es.
--   por VENCIDO  el recovery: no sabe cuál es, la elige la base.
--
-- Ambas suben `attempts` DENTRO del mismo UPDATE que cambia el estado. Hacerlo
-- en dos sentencias desde el cliente dejaría una ventana en la que la fila está
-- reclamada pero sin contar el intento, y ahí es donde se cuelan los reintentos
-- infinitos.
--
-- Devuelven el `payload` para que quien reclama pueda trabajar sin releer: una
-- segunda lectura podría traer una fila ya modificada por otro.

create or replace function public.claim_webhook_event(
  p_id            uuid,
  p_lease_seconds integer
)
returns table (
  id           uuid,
  event_name   text,
  payload      jsonb,
  attempts     integer,
  max_attempts integer
)
language sql
security invoker
set search_path = public
as $$
  update public.webhook_events w
     set status          = 'processing',
         attempts        = w.attempts + 1,
         next_attempt_at = now() + make_interval(secs => greatest(p_lease_seconds, 1)),
         error_message   = null
   where w.id = p_id
     and w.status = 'received'
  returning w.id, w.event_name, w.payload, w.attempts, w.max_attempts;
$$;

-- `FOR UPDATE SKIP LOCKED` no se puede expresar desde PostgREST, y sin él dos
-- ticks solapados leerían la misma fila antes de que ninguno la marcara. Un
-- SELECT seguido de UPDATE tiene esa ventana; esto no.
--
-- Ordena por `created_at` para respetar el orden de llegada dentro del tick, y
-- excluye lo que ya agotó intentos.

create or replace function public.claim_due_webhook_events(
  p_limit         integer,
  p_lease_seconds integer
)
returns table (
  id           uuid,
  event_name   text,
  payload      jsonb,
  attempts     integer,
  max_attempts integer
)
language sql
security invoker
set search_path = public
as $$
  with due as (
    select w.id
    from public.webhook_events w
    where w.next_attempt_at is not null
      and w.next_attempt_at <= now()
      and w.status in ('received', 'processing')
      and w.attempts < w.max_attempts
    order by w.created_at
    for update skip locked
    limit greatest(p_limit, 0)
  )
  update public.webhook_events w
     set status          = 'processing',
         attempts        = w.attempts + 1,
         next_attempt_at = now() + make_interval(secs => greatest(p_lease_seconds, 1)),
         error_message   = null
    from due
   where w.id = due.id
  returning w.id, w.event_name, w.payload, w.attempts, w.max_attempts;
$$;

-- ── 6. Permisos ─────────────────────────────────────────────────────────────
--
-- Mismo patrón que 0003/0004/0005/0007: revocar a todos y conceder SOLO a
-- `service_role`. El GRANT explícito NO es decorativo — Postgres concede
-- EXECUTE a PUBLIC por defecto, así que sin él la única vía de acceso de
-- `service_role` podría ser esa misma concesión de PUBLIC que acabamos de
-- revocar, y el backend se quedaría sin poder reclamar nada.
--
-- Son `security invoker`: se ejecutan con los privilegios de quien llama, que
-- es `service_role` y ya tiene acceso a `webhook_events` desde 0001 (y omite
-- RLS). `security definer` daría una escalada que aquí no hace falta para nada.

revoke all on function public.claim_webhook_event(uuid, integer) from public;
revoke all on function public.claim_webhook_event(uuid, integer) from anon;
revoke all on function public.claim_webhook_event(uuid, integer) from authenticated;
grant execute on function public.claim_webhook_event(uuid, integer) to service_role;

revoke all on function public.claim_due_webhook_events(integer, integer) from public;
revoke all on function public.claim_due_webhook_events(integer, integer) from anon;
revoke all on function public.claim_due_webhook_events(integer, integer) from authenticated;
grant execute on function public.claim_due_webhook_events(integer, integer) to service_role;

comment on function public.claim_webhook_event(uuid, integer) is
  'Reclamo atómico por id: received -> processing con lease. Cero filas = otra ejecución lo tiene.';

comment on function public.claim_due_webhook_events(integer, integer) is
  'Reclama atómicamente eventos vencidos (received listos o processing con lease expirado). '
  'FOR UPDATE SKIP LOCKED impide que dos workers tomen la misma fila.';

commit;
