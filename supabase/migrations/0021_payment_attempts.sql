-- ============================================================================
-- 0021 — Comprobantes de pago: intentos y archivos
--
-- Los pedidos con `payment_method = 'qr'` se pagan enviando un comprobante por
-- WhatsApp. Esta migración introduce el modelo que permite revisarlos desde el
-- panel sin perder trazabilidad de nada de lo que llegó.
--
-- Dos tablas, dos responsabilidades distintas:
--
--   * `payment_attempts` — el EPISODIO de revisión. Un pedido puede tener
--     varios: si se rechaza un comprobante y el cliente manda otro, se abre uno
--     nuevo y el anterior SE CONSERVA. El historial completo es el producto.
--
--   * `payment_proofs` — cada ARCHIVO que llegó, decidido o no, asociado o no,
--     duplicado o no. Un comprobante nunca se borra ni se fusiona: si el mismo
--     archivo llega otra vez en un mensaje nuevo, se registra apuntando al
--     original con `duplicate_of_id`.
--
-- ── Revisar un pago NO es avanzar el pedido ─────────────────────────────────
--
-- `payment_attempts.review_status` es una dimensión INDEPENDIENTE de
-- `orders.status`. Confirmar un pago no marca el pedido listo, entregado ni
-- cancelado; esta migración no toca `orders` en absoluto. Un pedido puede estar
-- "En preparación" y a la vez tener un comprobante rechazado y otro aceptado.
--
-- ── La idempotencia la garantiza la BASE, no una consulta previa ────────────
--
-- Kapso reentrega mensajes. El índice único sobre `source_message_id` es lo que
-- impide una segunda fila para el mismo WAMID, y lo hace incluso si dos workers
-- corren a la vez: comprobar-y-después-insertar tiene una ventana entre ambos
-- pasos, un índice único no.
--
-- ── El estado estable del análisis es `pending` ─────────────────────────────
--
-- `analysis_status` queda preparado para un analizador automático que hoy NO
-- existe. `pending` es su estado NORMAL: no significa error ni archivo atascado,
-- y el panel no debe presentarlo como tal.
--
-- NO ejecutar automáticamente. Aplicar manualmente después de 0020.
-- Postgres / Supabase.
--
-- Toda la migración se aplica de forma atómica: begin; ... commit;. Si algo
-- falla, no queda nada a medias (no dependas del SQL Editor para envolverla).
-- ============================================================================

begin;

-- ── Tabla public.payment_attempts ───────────────────────────────────────────

create table if not exists public.payment_attempts (
  id            uuid primary key default gen_random_uuid(),
  order_id      uuid not null references public.orders (id) on delete cascade,
  review_status text not null default 'pending_review',
  opened_at     timestamptz not null default now(),
  -- La pone el SERVIDOR al decidir (nunca el navegador). Ver la RPC de 0022.
  reviewed_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- Dominio cerrado. `pending_review` es el único estado de partida.
  constraint payment_attempts_review_status_check
    check (review_status in ('pending_review', 'accepted', 'rejected')),

  -- Coherencia: un intento decidido TIENE fecha de decisión, y uno pendiente
  -- no puede tenerla. Sin esto, un UPDATE mal hecho dejaría "aceptado sin
  -- fecha" o "pendiente pero ya revisado", y el panel mostraría una mentira.
  constraint payment_attempts_reviewed_at_coherence check (
    (review_status = 'pending_review' and reviewed_at is null)
    or (review_status in ('accepted', 'rejected') and reviewed_at is not null)
  )
);

-- Listado del panel: los intentos de un pedido, el más reciente primero.
create index if not exists idx_payment_attempts_order
  on public.payment_attempts (order_id, opened_at desc);

-- Búsqueda del episodio abierto de un pedido (asociación de un comprobante
-- nuevo). Parcial: solo hay como mucho uno pendiente que importe.
create index if not exists idx_payment_attempts_pending
  on public.payment_attempts (order_id)
  where review_status = 'pending_review';

drop trigger if exists trg_payment_attempts_updated_at on public.payment_attempts;
create trigger trg_payment_attempts_updated_at
  before update on public.payment_attempts
  for each row execute function public.set_updated_at();

-- ── Tabla public.payment_proofs ─────────────────────────────────────────────

create table if not exists public.payment_proofs (
  id                  uuid primary key default gen_random_uuid(),

  -- Identidad del mensaje de origen (WAMID). Es la clave de idempotencia.
  source_message_id   text not null,

  -- Asociación. Ambas pueden ser NULL: un comprobante que no se pudo asociar
  -- sigue existiendo y siendo visible, no se descarta.
  order_id            uuid references public.orders (id) on delete set null,
  attempt_id          uuid references public.payment_attempts (id) on delete set null,
  association_method  text,
  routing_exception   text,

  -- Tipo DECLARADO por el proveedor y tipo REAL verificado sobre los bytes.
  -- Se guardan los dos: que no coincidan es justamente el dato interesante
  -- (un .pdf renombrado que en realidad es otra cosa).
  declared_mime_type  text,
  verified_mime_type  text,
  safe_filename       text,

  -- Hash del CONTENIDO. Reconoce el mismo archivo llegando en un mensaje nuevo.
  content_sha256      text,
  duplicate_of_id     uuid references public.payment_proofs (id) on delete set null,

  -- Captura y almacenamiento.
  capture_status      text not null default 'pending',
  received_at         timestamptz not null default now(),
  storage_provider    text,
  storage_namespace   text,
  storage_key         text,
  storage_stored_at   timestamptz,
  storage_expires_at  timestamptz,

  -- Análisis automático futuro. `pending` es estado NORMAL, no un fallo.
  analysis_status     text not null default 'pending',

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  -- Dominios cerrados.
  constraint payment_proofs_association_method_check
    check (association_method is null or association_method in (
      'reply_to_qr', 'single_open_qr_order', 'duplicate', 'ambiguous', 'unresolved'
    )),
  constraint payment_proofs_routing_exception_check
    check (routing_exception is null or routing_exception in (
      'signal_conflict', 'expired_target', 'payment_already_accepted', 'closed_order'
    )),
  constraint payment_proofs_capture_status_check
    check (capture_status in ('pending', 'stored', 'failed')),
  constraint payment_proofs_analysis_status_check
    check (analysis_status in ('pending', 'done', 'failed')),

  -- El WAMID nunca es cadena vacía.
  constraint payment_proofs_source_message_id_not_empty
    check (btrim(source_message_id) <> ''),

  -- REGLA CENTRAL (contrato §3.4): si hubo una excepción de enrutamiento, el
  -- comprobante NO puede fingir que está unido a un intento. Una cosa excluye
  -- a la otra, y se protege aquí para que ningún camino de código pueda
  -- guardar un estado que se contradice a sí mismo.
  constraint payment_proofs_routing_exception_excludes_attempt
    check (routing_exception is null or attempt_id is null),

  -- Coherencia del almacenamiento: `stored` exige key y fecha; lo que no está
  -- almacenado no puede aparentar que sí. Una caída antes de guardar deja
  -- `pending`, nunca una captura completa a medias.
  constraint payment_proofs_storage_coherence check (
    (capture_status = 'stored'
      and storage_provider is not null
      and storage_key is not null
      and storage_stored_at is not null)
    or (capture_status <> 'stored')
  ),

  -- Un duplicado se marca como tal en el método de asociación.
  constraint payment_proofs_duplicate_coherence
    check (duplicate_of_id is null or association_method = 'duplicate'),

  -- Un comprobante no puede ser duplicado de sí mismo.
  constraint payment_proofs_duplicate_not_self
    check (duplicate_of_id is null or duplicate_of_id <> id)
);

-- IDEMPOTENCIA (contrato §4.1): el mismo WAMID no produce una segunda fila,
-- ni siquiera con dos workers corriendo a la vez.
create unique index if not exists uq_payment_proofs_source_message_id
  on public.payment_proofs (source_message_id);

-- DUPLICADOS (contrato §4.2): reconocer el mismo contenido en un mensaje nuevo.
create index if not exists idx_payment_proofs_content_sha256
  on public.payment_proofs (content_sha256)
  where content_sha256 is not null;

-- Panel: los comprobantes de un intento y de un pedido.
create index if not exists idx_payment_proofs_attempt
  on public.payment_proofs (attempt_id, received_at);
create index if not exists idx_payment_proofs_order
  on public.payment_proofs (order_id, received_at desc);

drop trigger if exists trg_payment_proofs_updated_at on public.payment_proofs;
create trigger trg_payment_proofs_updated_at
  before update on public.payment_proofs
  for each row execute function public.set_updated_at();

-- ── Row Level Security ──────────────────────────────────────────────────────
-- RLS habilitado SIN políticas públicas, igual que el resto de tablas internas.
-- El backend usa SUPABASE_SERVICE_ROLE_KEY (omite RLS); el acceso anónimo con
-- la anon key no puede leer ni un comprobante ni una storage key.
alter table public.payment_attempts enable row level security;
alter table public.payment_proofs   enable row level security;

commit;
