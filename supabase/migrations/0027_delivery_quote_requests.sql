-- ═══════════════════════════════════════════════════════════════════════════
-- 0027 · Cotizaciones de delivery ANTES de que exista un pedido
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Hay un cliente que no entra al menú hasta saber cuánto le sale el envío. Hoy
-- manda su ubicación por el botón normal de WhatsApp y no le contesta nadie: el
-- pipeline solo sabe atender un pin que RESPONDE a la petición del sistema
-- (`location_request_message_id`), y uno suelto se descarta antes de llegar al
-- agente. Silencio absoluto, justo al cliente que estaba decidiendo si pedir.
--
-- Esta tabla es el registro de esas cotizaciones sueltas. Existe por tres
-- razones, y ninguna es "guardar por guardar":
--
--   1. IDEMPOTENCIA. `source_message_id` es el WAMID del pin y es único: una
--      reentrega de Kapso encuentra la fila y no vuelve a llamar a Mapbox ni a
--      contestarle dos veces al cliente.
--
--   2. CUPO. Cada cotización cuesta una llamada de pago a Mapbox, y una
--      cotización gratis es un juguete: sin contador, un pin repetido diez
--      veces son diez llamadas. Se cuentan las que el cliente RECIBIÓ.
--
--   3. REUSO. La distancia por carretera hasta un punto no cambia entre las
--      12:18 y las 12:25. Si el mismo cliente cotiza y luego arma su pedido y
--      comparte el mismo pin, el checkout puede leer la medición de aquí en vez
--      de volver a pagar por medirla.
--
-- Lo que esta tabla NO es: un pedido. No hay productos, ni total, ni cliente
-- identificado más allá de su teléfono. Es una pregunta y su respuesta.

create table if not exists public.delivery_quote_requests (
  id                  uuid        primary key default gen_random_uuid(),

  -- Identidad durable del cliente: dígitos normalizados, igual que en
  -- `agent_conversations` y `menu_send_deliveries`. NUNCA el crudo del webhook.
  customer_phone      text        not null,

  -- WAMID REAL del pin entrante. Es la clave de idempotencia.
  source_message_id   text        not null,

  -- El punto que mandó el cliente, tal cual. Mismo tipo que
  -- `orders.delivery_latitude` para que las dos mediciones sean comparables.
  latitude            double precision not null,
  longitude           double precision not null,

  status              text        not null,

  -- Solo cuando hubo medición. `distance_source` dice si se pagó por ella.
  distance_meters     integer,
  distance_source     text,

  -- Solo cuando la distancia cayó dentro de cobertura.
  fee_amount          numeric(10, 2),

  error_code          text,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  -- ── Idempotencia técnica ──────────────────────────────────────────────────
  constraint delivery_quote_requests_source_message_id_unique
    unique (source_message_id),

  constraint delivery_quote_requests_source_message_id_not_empty
    check (btrim(source_message_id) <> ''),

  constraint delivery_quote_requests_customer_phone_format
    check (customer_phone ~ '^[0-9]{8,15}$'),

  -- ── Dominios ──────────────────────────────────────────────────────────────
  constraint delivery_quote_requests_status_check check (status in (
    'quoted', 'out_of_coverage', 'over_limit', 'failed'
  )),

  constraint delivery_quote_requests_distance_source_check check (
    distance_source is null or distance_source in ('mapbox', 'reused')
  ),

  constraint delivery_quote_requests_coords_range check (
    latitude  between -90  and 90 and
    longitude between -180 and 180
  ),

  constraint delivery_quote_requests_distance_meters_check check (
    distance_meters is null or distance_meters >= 0
  ),

  constraint delivery_quote_requests_fee_amount_check check (
    fee_amount is null or fee_amount >= 0
  ),

  -- Mismo formato que `agent_runs.error_code` y `menu_send_deliveries`: cabe en
  -- un log y nunca arrastra el cuerpo de una respuesta ni un secreto.
  constraint delivery_quote_requests_error_code_format check (
    error_code is null or error_code ~ '^[A-Za-z0-9._:-]{1,64}$'
  ),

  -- ── Coherencia de estados ─────────────────────────────────────────────────
  -- Cada estado dice exactamente qué pasó, y las columnas tienen que
  -- respaldarlo. Un `quoted` sin importe sería una cotización que nadie puede
  -- reproducir; un `over_limit` con distancia sería una llamada a Mapbox que
  -- decíamos no haber hecho.
  constraint delivery_quote_requests_state_coherence check (
    (
      -- Se midió y cayó dentro de cobertura: hay distancia, origen e importe.
      status = 'quoted'
      and distance_meters is not null
      and distance_source is not null
      and fee_amount      is not null
      and error_code      is null
    )
    or (
      -- Se midió y quedó fuera del tarifario: distancia sí, importe no.
      status = 'out_of_coverage'
      and distance_meters is not null
      and distance_source is not null
      and fee_amount      is null
      and error_code      is null
    )
    or (
      -- El cupo estaba agotado: NO se llamó a Mapbox. Es una decisión, no un
      -- fallo, y por eso no lleva `error_code`.
      status = 'over_limit'
      and distance_meters is null
      and distance_source is null
      and fee_amount      is null
      and error_code      is null
    )
    or (
      -- Se intentó medir y no se pudo. El cliente recibió un texto honesto.
      status = 'failed'
      and distance_meters is null
      and distance_source is null
      and fee_amount      is null
      and error_code      is not null
    )
  )
);

-- ── Índices ─────────────────────────────────────────────────────────────────

-- El CUPO: "¿cuántas cotizaciones recibió este teléfono en las últimas 12 h?".
-- Parcial sobre los dos estados que el cliente llegó a ver: una llamada fallida
-- o un rechazo por cupo no gastan cupo, porque no le sirvieron de nada.
create index if not exists ix_delivery_quote_requests_cupo
  on public.delivery_quote_requests (customer_phone, created_at desc)
  where status in ('quoted', 'out_of_coverage');

-- El REUSO: "¿ya medimos un punto de este cliente hace poco?". Parcial sobre
-- las filas que tienen distancia, que son las únicas reutilizables.
create index if not exists ix_delivery_quote_requests_reuso
  on public.delivery_quote_requests (customer_phone, created_at desc)
  where distance_meters is not null;

-- ── updated_at automático (trigger genérico de 0001; NO se redefine) ────────

drop trigger if exists trg_delivery_quote_requests_updated_at on public.delivery_quote_requests;
create trigger trg_delivery_quote_requests_updated_at
  before update on public.delivery_quote_requests
  for each row execute function public.set_updated_at();

-- ── RLS: cerrada, como el resto de tablas operativas ────────────────────────
alter table public.delivery_quote_requests enable row level security;
