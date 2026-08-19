-- ============================================================================
-- La Fija Orders — Agent Foundation (0014_agent_foundation)
--
-- Crea la base de datos del Agent Core conversacional (Fase 6D.2F.1B). SOLO
-- schema: no hay OpenAI, ni tools, ni runtime de webhook, ni human takeover.
--
-- Cuatro tablas, ninguna RPC, CERO cambios sobre tablas existentes
-- (orders, menu_items, order_items, webhook_events, menu_sessions,
-- order_notifications quedan intactas). Sin seed y sin backfill.
--
-- Principios fijados en SCHEMA_FREEZE_V3_READY:
--
--  1. `customer_phone` es la identidad DURABLE del cliente (UNIQUE). El
--     conversation_id del proveedor es solo una referencia técnica cambiante,
--     por eso se llama `last_provider_conversation_id`.
--  2. `agent_conversations` representa el ESTADO ACTUAL; el historial de
--     pausas/reanudaciones vive exclusivamente en `agent_control_events`.
--  3. El historial de mensajes es COMPLETO: cliente, IA, humano y automatismos
--     determinísticos del backend. Guardar todo NO significa enviarlo todo al
--     modelo: eso lo acota la ventana de lectura, no el almacenamiento.
--  4. `agent_messages` contiene únicamente mensajes REALES del canal. Nunca
--     marcadores internos tipo [MEDIA_SENT] / [PRODUCT_CONTEXT] / [LOCATION]:
--     el dominio de `actor` los hace irrepresentables.
--  5. `webhook_events.event_id` (idempotencia del evento del proveedor) y
--     `agent_runs.source_message_id` (idempotencia de la reacción de la IA) son
--     conceptos SEPARADOS. El retry failed→processing del webhook reejecuta el
--     procesamiento por diseño; sin `agent_runs` eso duplicaría OpenAI y envíos.
--
-- NO ejecutar automáticamente. Aplicar manualmente después de
-- 0001 + … + 0013. Postgres / Supabase.
--
-- Toda la migración se aplica de forma atómica: begin; ... commit;. Si algo
-- falla, no queda nada a medias (no dependas del SQL Editor para envolverla).
-- ============================================================================

begin;

-- ============================================================================
-- 1. public.agent_conversations — ESTADO ACTUAL de la conversación
--
-- Una fila por teléfono, para siempre. No se segmenta por ventanas de WhatsApp:
-- la conversación es durable aunque el cliente vuelva semanas después.
--
-- Puede NACER por tres caminos, los tres representables:
--   · mensaje entrante del cliente        → state='active'
--   · saliente humano (business_app)      → state='paused' (takeover inmediato)
--   · saliente determinístico del backend → state='active', sin mensaje de cliente
-- ============================================================================

create table if not exists public.agent_conversations (
  id                            uuid        primary key default gen_random_uuid(),

  -- Identidad durable. Solo dígitos: mismo criterio que normalizePhone()
  -- (src/lib/phone.ts), de modo que '+591 700-00000' y '59170000000' son la
  -- MISMA conversación y no tres filas distintas.
  customer_phone                text        not null,

  -- Referencias técnicas del proveedor. Volátiles, NUNCA identidad.
  last_provider_conversation_id text,
  -- Por qué número del negocio responder. Nullable a propósito: registrar el
  -- historial jamás puede fallar porque el evento no traiga phone_number_id.
  provider_phone_number_id      text,

  -- Control del agente.
  state                         text        not null default 'active',
  paused_at                     timestamptz,
  pause_expires_at              timestamptz,
  pause_reason                  text,
  pause_source                  text,
  -- Momento del último resume. Solo poblado mientras la conversación está
  -- 'active'; vuelve a NULL en cuanto se pausa de nuevo.
  resumed_at                    timestamptz,

  -- Denormalizaciones temporales. Evitan agregados correlacionados sobre
  -- agent_messages en cada consulta de panel o seguimiento.
  first_customer_message_at     timestamptz,
  first_ai_message_at           timestamptz,
  -- DERIVADA por trigger: el runtime NUNCA la escribe (ver §3).
  last_message_at               timestamptz,
  last_customer_message_at      timestamptz,
  last_ai_message_at            timestamptz,
  last_human_message_at         timestamptz,
  last_automation_message_at    timestamptz,

  created_at                    timestamptz not null default now(),
  updated_at                    timestamptz not null default now(),

  -- ── Identidad ─────────────────────────────────────────────────────────────
  constraint agent_conversations_customer_phone_unique
    unique (customer_phone),

  constraint agent_conversations_customer_phone_format
    check (customer_phone ~ '^[0-9]{8,15}$'),

  constraint agent_conversations_provider_conversation_id_not_empty
    check (last_provider_conversation_id is null
           or btrim(last_provider_conversation_id) <> ''),

  constraint agent_conversations_provider_phone_number_id_not_empty
    check (provider_phone_number_id is null
           or btrim(provider_phone_number_id) <> ''),

  -- ── Dominios de control ───────────────────────────────────────────────────
  constraint agent_conversations_state_check
    check (state in ('active', 'paused')),

  constraint agent_conversations_pause_source_check
    check (pause_source is null
           or pause_source in ('business_app', 'dashboard', 'api', 'system')),

  -- Mismo charset que order_notifications.last_error_code (0004): código corto
  -- y seguro, nunca mensajes técnicos, JSON, teléfonos ni secretos.
  constraint agent_conversations_pause_reason_format
    check (pause_reason is null or pause_reason ~ '^[A-Za-z0-9._:-]{1,64}$'),

  -- ── Coherencia estado ↔ columnas ──────────────────────────────────────────
  -- Solo tres situaciones son representables:
  --   paused                      → paused_at/reason/source, resumed_at NULL
  --   active nunca pausada        → todo NULL (incluido resumed_at)
  --   active tras un resume       → todo NULL salvo resumed_at
  -- Los datos de la pausa ANTERIOR no se conservan aquí: eso es historial y
  -- vive en agent_control_events.
  constraint agent_conversations_state_coherence check (
    (
      state = 'paused'
      and paused_at    is not null
      and pause_reason is not null
      and pause_source is not null
      and resumed_at   is null
    )
    or (
      state = 'active'
      and paused_at        is null
      and pause_expires_at is null
      and pause_reason     is null
      and pause_source     is null
    )
  ),

  -- pause_expires_at NULL = pausa INDEFINIDA (el takeover humano lo es).
  constraint agent_conversations_pause_expiry_after_paused
    check (pause_expires_at is null
           or (paused_at is not null and pause_expires_at > paused_at)),

  -- ── Coherencia de las marcas temporales ───────────────────────────────────
  constraint agent_conversations_customer_first_last_paired
    check ((first_customer_message_at is null) = (last_customer_message_at is null)),
  constraint agent_conversations_customer_first_before_last
    check (first_customer_message_at is null
           or first_customer_message_at <= last_customer_message_at),

  constraint agent_conversations_ai_first_last_paired
    check ((first_ai_message_at is null) = (last_ai_message_at is null)),
  constraint agent_conversations_ai_first_before_last
    check (first_ai_message_at is null
           or first_ai_message_at <= last_ai_message_at),

  -- `last_message_at` es EXACTAMENTE el máximo de los cuatro actores.
  -- greatest() ignora los NULL y solo devuelve NULL si todos lo son;
  -- `is not distinct from` fuerza un booleano, de modo que el caso "todos NULL"
  -- no se cuela por la puerta de atrás de un CHECK que evalúa a NULL.
  constraint agent_conversations_last_message_at_is_exact_max check (
    last_message_at is not distinct from greatest(
      last_customer_message_at,
      last_ai_message_at,
      last_human_message_at,
      last_automation_message_at
    )
  )
);

-- ── last_message_at como columna DERIVADA ───────────────────────────────────
-- El writer solo mantiene los last_* por actor (con greatest) y los first_*
-- (con least). Delegar el máximo al motor evita el error clásico: en un UPDATE
-- las referencias a columnas del lado derecho ven los valores ANTIGUOS, así que
-- calcularlo a mano fallaría el CHECK y BLOQUEARÍA la persistencia del
-- historial — justo lo que no puede ocurrir nunca.

create or replace function public.agent_conversations_sync_last_message_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.last_message_at := greatest(
    new.last_customer_message_at,
    new.last_ai_message_at,
    new.last_human_message_at,
    new.last_automation_message_at
  );
  return new;
end;
$$;

drop trigger if exists trg_agent_conversations_last_message_at
  on public.agent_conversations;
create trigger trg_agent_conversations_last_message_at
  before insert or update on public.agent_conversations
  for each row execute function public.agent_conversations_sync_last_message_at();

-- updated_at automático (reutiliza el trigger genérico de 0001; NO se redefine).
drop trigger if exists trg_agent_conversations_updated_at on public.agent_conversations;
create trigger trg_agent_conversations_updated_at
  before update on public.agent_conversations
  for each row execute function public.set_updated_at();

-- ── Índices ─────────────────────────────────────────────────────────────────
-- El UNIQUE de customer_phone ya provee el índice de lookup por identidad.

-- Panel / seguimiento: "conversaciones sin actividad desde X".
create index if not exists ix_agent_conversations_last_message_at
  on public.agent_conversations (last_message_at desc);

-- Cola de handoffs. Parcial: son pocas filas y el índice queda diminuto.
create index if not exists ix_agent_conversations_paused
  on public.agent_conversations (paused_at desc)
  where state = 'paused';

-- Reanudación de pausas temporales (el runtime llega en una fase posterior).
create index if not exists ix_agent_conversations_pause_expiry
  on public.agent_conversations (pause_expires_at)
  where pause_expires_at is not null;

-- ============================================================================
-- 2. public.agent_messages — historial COMPLETO de mensajes reales del canal
--
-- Cuatro actores, cuatro combinaciones válidas de las 16 posibles
-- (direction × role × actor):
--
--   cliente                 inbound  / user      / customer
--   Agent Core (OpenAI)     outbound / assistant / ai
--   trabajador humano       outbound / assistant / human
--   backend determinístico  outbound / assistant / automation
--
-- `automation` cubre order_received, confirmation, location_request, el QR y el
-- CTA del menú disparado por isMenuIntent/TESTMENU9842. Se separa de `ai` para
-- que el tráfico determinístico NO contamine first_ai_message_at ni las
-- métricas AI-only / AI→human del Agent Core.
--
-- `automation` representa SOLO comunicaciones reales enviadas al cliente: no
-- existe actor para eventos internos, así que un mensaje falso no cabe aquí.
-- ============================================================================

create table if not exists public.agent_messages (
  id                       uuid        primary key default gen_random_uuid(),

  agent_conversation_id    uuid        not null
                             references public.agent_conversations (id)
                             on delete cascade,

  -- WAMID del proveedor. NULLABLE: un saliente de IA con envío ambiguo
  -- (send_unknown) todavía no tiene uno, y jamás se inventa.
  provider_message_id      text,
  -- Ventana de conversación del proveedor a la que perteneció este mensaje.
  provider_conversation_id text,

  direction                text        not null,
  role                     text        not null,
  actor                    text        not null,

  -- NULLABLE: un pin de GPS, un sticker o un audio no tienen texto. Antes que
  -- inventar un "[LOCATION]" se guarda NULL y el detalle va en metadata.
  content                  text,
  content_type             text        not null default 'text',
  -- Describe la acción que produjo un saliente real (p. ej.
  -- {"action":"send_menu","resource_type":"menu","resource_key":"main_menu"}).
  -- Es lo que permite responder "¿ya enviamos esto hace poco?" sin buscar
  -- marcadores dentro del texto. NUNCA guarda session_token, URLs con token,
  -- claves ni secretos: el WAMID real vive en provider_message_id.
  metadata                 jsonb,

  -- Instante del proveedor (Unix s/ms o ISO ya normalizado por el runtime).
  message_timestamp        timestamptz not null,
  created_at               timestamptz not null default now(),

  -- ── Dominios ──────────────────────────────────────────────────────────────
  constraint agent_messages_direction_check
    check (direction in ('inbound', 'outbound')),
  constraint agent_messages_role_check
    check (role in ('user', 'assistant')),
  constraint agent_messages_actor_check
    check (actor in ('customer', 'ai', 'human', 'automation')),

  constraint agent_messages_content_type_check check (
    content_type in ('text', 'image', 'audio', 'video', 'document',
                     'sticker', 'location', 'interactive', 'unknown')
  ),

  -- ── Coherencia direction / role / actor ───────────────────────────────────
  -- Cualquier otra combinación no existe para el motor. Construir el contexto
  -- del modelo pasa a ser leer `role`, sin lógica de mapeo que pueda divergir.
  constraint agent_messages_actor_coherence check (
    (direction = 'inbound'  and role = 'user'      and actor = 'customer')
    or
    (direction = 'outbound' and role = 'assistant' and actor in ('ai', 'human', 'automation'))
  ),

  -- ── Coherencia content / content_type ─────────────────────────────────────
  -- text  → contenido real obligatorio.
  -- resto → NULL permitido; si hay caption o transcripción real se guarda,
  --         pero nunca una cadena en blanco disfrazada de contenido.
  constraint agent_messages_content_coherence check (
    (content_type =  'text' and content is not null and btrim(content) <> '')
    or
    (content_type <> 'text' and (content is null or btrim(content) <> ''))
  ),

  -- ── Higiene ───────────────────────────────────────────────────────────────
  constraint agent_messages_provider_message_id_not_empty
    check (provider_message_id is null or btrim(provider_message_id) <> ''),

  constraint agent_messages_provider_conversation_id_not_empty
    check (provider_conversation_id is null or btrim(provider_conversation_id) <> ''),

  -- metadata es un OBJETO o nada. Se fija la FORMA del contenedor, nunca las
  -- claves: esas son convención de TypeScript y evolucionarán.
  constraint agent_messages_metadata_is_object
    check (metadata is null or jsonb_typeof(metadata) = 'object'),

  -- Rango de cordura (mismo criterio que el parser de timestamps de Kapso):
  -- un valor basura no puede envenenar el orden del historial.
  constraint agent_messages_timestamp_range check (
    message_timestamp >= timestamptz '2000-01-01T00:00:00Z'
    and message_timestamp < timestamptz '2100-01-01T00:00:00Z'
  )
);

-- Unicidad del WAMID, solo cuando existe. Es la barrera que hace idempotente el
-- takeover humano: sent + delivered + read del mismo saliente chocan aquí y el
-- segundo evento se convierte en un no-op.
create unique index if not exists uq_agent_messages_provider_message_id
  on public.agent_messages (provider_message_id)
  where provider_message_id is not null;

-- ÚNICO índice de lectura. Resuelve en un solo scan:
--   · ventana de memoria para el modelo (24 h / N mensajes)
--   · memoria operacional anti-repetición (recursos ya enviados)
--   · timeline del panel
-- El desempate por id es arbitrario pero ESTABLE: WhatsApp entrega timestamps
-- con resolución de segundo y dos mensajes pueden coincidir.
-- Sin GIN sobre metadata: dentro de una conversación y una ventana corta el
-- filtro se aplica sobre decenas de filas y no compensa el coste de escritura.
create index if not exists ix_agent_messages_recent
  on public.agent_messages (agent_conversation_id, message_timestamp desc, id desc);

-- ============================================================================
-- 3. public.agent_runs — idempotencia y estado de la EJECUCIÓN del agente
--
-- Separado a propósito de webhook_events: aquel deduplica la ENTREGA del evento
-- del proveedor; este deduplica la REACCIÓN de la IA a un mensaje. El webhook
-- reejecuta el procesamiento completo cuando reclama un evento `failed`, cosa
-- segura para los efectos deterministas actuales (todos idempotentes) pero no
-- para una llamada a OpenAI seguida de un envío.
--
-- Un mensaje recibido con la conversación en pausa TAMBIÉN crea su run, que
-- termina de inmediato en skipped_paused/pre_openai: así queda medido y nunca
-- se queda eternamente en `processing`.
-- ============================================================================

create table if not exists public.agent_runs (
  id                      uuid        primary key default gen_random_uuid(),

  agent_conversation_id   uuid        not null
                            references public.agent_conversations (id)
                            on delete cascade,

  -- WAMID entrante que disparó el run. El UNIQUE es la idempotencia semántica:
  -- se reclama con INSERT ... ON CONFLICT DO NOTHING, sin ventana de carrera.
  source_message_id       text        not null,

  -- Punteros a mensajes: ON DELETE SET NULL (no CASCADE). Una futura política
  -- de retención/privacidad puede borrar un mensaje sin destruir la evidencia
  -- de ejecución ni la protección de idempotencia de source_message_id.
  source_agent_message_id uuid        references public.agent_messages (id)
                            on delete set null,
  response_message_id     uuid        references public.agent_messages (id)
                            on delete set null,

  status                  text        not null default 'processing',
  attempt_count           integer     not null default 1,
  model                   text,
  tool_rounds             integer     not null default 0,
  -- Qué barrera detuvo el run: distingue "no llegamos a gastar OpenAI"
  -- (pre_openai) de "gastamos y descartamos la respuesta" (pre_send).
  skipped_at_barrier      text,

  started_at              timestamptz not null default now(),
  completed_at            timestamptz,
  error_code              text,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),

  -- ── Idempotencia semántica ────────────────────────────────────────────────
  constraint agent_runs_source_message_id_unique unique (source_message_id),
  constraint agent_runs_source_message_id_not_empty
    check (btrim(source_message_id) <> ''),

  -- ── Dominios ──────────────────────────────────────────────────────────────
  constraint agent_runs_status_check check (status in (
    'processing', 'sending', 'completed', 'skipped_paused', 'failed', 'send_unknown'
  )),

  constraint agent_runs_barrier_check check (
    skipped_at_barrier is null or skipped_at_barrier in ('pre_openai', 'pre_send')
  ),
  constraint agent_runs_barrier_only_when_skipped check (
    skipped_at_barrier is null or status = 'skipped_paused'
  ),

  constraint agent_runs_attempt_count_check check (attempt_count >= 1),
  -- Solo el invariante. El TOPE de rondas es política y vive en TypeScript:
  -- cambiarlo no debe exigir una migración.
  constraint agent_runs_tool_rounds_check check (tool_rounds >= 0),

  constraint agent_runs_model_not_empty
    check (model is null or btrim(model) <> ''),

  constraint agent_runs_error_code_format check (
    error_code is null or error_code ~ '^[A-Za-z0-9._:-]{1,64}$'
  ),

  constraint agent_runs_completed_after_started check (
    completed_at is null or completed_at >= started_at
  ),

  -- ── Coherencia de estados ─────────────────────────────────────────────────
  -- Los estados EN CURSO son estrictos: todavía controlamos el proceso.
  -- Los TERMINALES exigen solo lo indispensable: un CHECK que impidiera CERRAR
  -- un run lo dejaría en 'sending', la recuperación de stale lo tomaría y
  -- podría duplicar el mensaje — exactamente el fallo que esta tabla evita.
  --
  -- Por eso 'completed' NO exige response_message_id: un SET NULL por retención
  -- debe poder ocurrir sin abortar el DELETE. Un NULL ahí significa "mensaje
  -- purgado", no "no hubo respuesta": eso ya lo afirma `status`.
  constraint agent_runs_state_coherence check (
    (
      status in ('processing', 'sending')
      and completed_at        is null
      and response_message_id is null
      and error_code          is null
    )
    or (
      status = 'completed'
      and completed_at is not null
      and error_code   is null
    )
    or (
      status = 'skipped_paused'
      and completed_at        is not null
      and response_message_id is null
      and error_code          is null
      and skipped_at_barrier  is not null
    )
    or (
      status = 'failed'
      and completed_at        is not null
      and response_message_id is null
      and error_code          is not null
    )
    or (
      -- Envío ambiguo: el mensaje PUDO salir. Nunca se reenvía a ciegas.
      status = 'send_unknown'
      and completed_at is not null
      and error_code   is not null
    )
  )
);

drop trigger if exists trg_agent_runs_updated_at on public.agent_runs;
create trigger trg_agent_runs_updated_at
  before update on public.agent_runs
  for each row execute function public.set_updated_at();

-- Descubrimiento de runs colgados (crash de la invocación). La recuperación en
-- sí llega en una fase posterior; el índice ya queda listo para ella.
create index if not exists ix_agent_runs_stale
  on public.agent_runs (started_at)
  where status in ('processing', 'sending');

create index if not exists ix_agent_runs_conversation
  on public.agent_runs (agent_conversation_id, created_at desc);

-- ============================================================================
-- 4. public.agent_control_events — historial APPEND-ONLY de pausa/reanudación
--
-- agent_conversations dice CÓMO ESTÁ la conversación; esta tabla dice QUÉ PASÓ.
-- Sin updated_at y sin trigger: un registro de auditoría que se modifica deja
-- de ser auditoría. Los permisos lo refuerzan (solo SELECT + INSERT).
-- ============================================================================

create table if not exists public.agent_control_events (
  id                    uuid        primary key default gen_random_uuid(),

  agent_conversation_id uuid        not null
                          references public.agent_conversations (id)
                          on delete cascade,

  action                text        not null,
  source                text        not null,
  reason                text,
  -- WAMID del saliente humano que provocó la pausa, cuando lo hay.
  provider_message_id   text,
  expires_at            timestamptz,
  metadata              jsonb,

  created_at            timestamptz not null default now(),

  constraint agent_control_events_action_check
    check (action in ('pause', 'resume')),

  constraint agent_control_events_source_check
    check (source in ('business_app', 'dashboard', 'api', 'system')),

  constraint agent_control_events_reason_format
    check (reason is null or reason ~ '^[A-Za-z0-9._:-]{1,64}$'),

  constraint agent_control_events_provider_message_id_not_empty
    check (provider_message_id is null or btrim(provider_message_id) <> ''),

  -- Un vencimiento solo tiene sentido en una pausa temporal.
  constraint agent_control_events_expires_only_on_pause
    check (expires_at is null or action = 'pause'),

  constraint agent_control_events_metadata_is_object
    check (metadata is null or jsonb_typeof(metadata) = 'object')
);

-- Idempotencia: sent + delivered + read del MISMO saliente humano producen UN
-- solo evento de pausa. Parcial porque una pausa desde el panel o la API no
-- tiene WAMID y no debe colisionar con otra.
create unique index if not exists uq_agent_control_events_provider_action
  on public.agent_control_events (agent_conversation_id, action, provider_message_id)
  where provider_message_id is not null;

create index if not exists ix_agent_control_events_conversation
  on public.agent_control_events (agent_conversation_id, created_at desc);

-- ============================================================================
-- 5. Row Level Security
--
-- RLS habilitado en las cuatro tablas SIN políticas: anon y authenticated
-- quedan cerrados por defecto. Solo el backend con service_role (que omite RLS)
-- accede. El panel futuro entra por una ruta autenticada del servidor, nunca
-- desde el navegador contra estas tablas.
-- ============================================================================

alter table public.agent_conversations  enable row level security;
alter table public.agent_messages       enable row level security;
alter table public.agent_runs           enable row level security;
alter table public.agent_control_events enable row level security;

-- ============================================================================
-- 6. Permisos
--
-- Se revoca PRIMERO de service_role además de public/anon/authenticated: los
-- privilegios por defecto del esquema public de Supabase conceden ALL sobre las
-- tablas nuevas, así que sin ese revoke un GRANT más estrecho no restringiría
-- nada y el carácter append-only sería puramente decorativo.
--
-- Ninguna tabla concede DELETE: nada en esta fase borra conversaciones ni
-- mensajes, y una capacidad destructiva sobre contenido conversacional personal
-- no debe ser un permiso permanente. Los borrados en CASCADE los ejecuta el
-- motor con privilegios del propietario, así que no necesitan este grant.
-- ============================================================================

-- agent_conversations — máquina de estados mutable.
revoke all on table public.agent_conversations from public;
revoke all on table public.agent_conversations from anon;
revoke all on table public.agent_conversations from authenticated;
revoke all on table public.agent_conversations from service_role;
grant select, insert, update on table public.agent_conversations to service_role;

-- agent_messages — UPDATE necesario para completar el WAMID de un envío que
-- quedó ambiguo y luego se reconcilió.
revoke all on table public.agent_messages from public;
revoke all on table public.agent_messages from anon;
revoke all on table public.agent_messages from authenticated;
revoke all on table public.agent_messages from service_role;
grant select, insert, update on table public.agent_messages to service_role;

-- agent_runs — máquina de estados mutable.
revoke all on table public.agent_runs from public;
revoke all on table public.agent_runs from anon;
revoke all on table public.agent_runs from authenticated;
revoke all on table public.agent_runs from service_role;
grant select, insert, update on table public.agent_runs to service_role;

-- agent_control_events — APPEND-ONLY también a nivel de permisos.
revoke all on table public.agent_control_events from public;
revoke all on table public.agent_control_events from anon;
revoke all on table public.agent_control_events from authenticated;
revoke all on table public.agent_control_events from service_role;
grant select, insert on table public.agent_control_events to service_role;

-- Sobre la función de trigger no se concede nada explícitamente: una función que
-- devuelve `trigger` no puede invocarse desde SQL (Postgres lo rechaza), así que
-- no hay superficie que cerrar. Revocarla no aportaría seguridad y sí arriesgaría
-- el disparo del propio trigger.

commit;
